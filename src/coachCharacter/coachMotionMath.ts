/**
 * Best-effort motion math for coach answers when biomechanics_summary left
 * wrist speed / impact frame null (usually missing impact_pose_sequence).
 * Uses pose wrists + YOLO contact frames / ball trajectory — never invents.
 */
import {
  bodySpeedToMps,
  mpsToKmh,
  parseCourtCalibration,
  resolveMetersPerTorsoUnit,
} from "../technique/anthropometricScale";
import { estimateFps } from "../technique/impactPoseContext";

type Pt = { x: number; y: number; visibility?: number };
type PoseRow = {
  frame: number;
  landmarks?: Record<string, Pt | undefined>;
  ball_bbox?: number[];
};

function pt(lm: Record<string, Pt | undefined> | undefined, name: string): Pt | null {
  const p = lm?.[name];
  if (!p || typeof p.x !== "number" || typeof p.y !== "number") return null;
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
  return p;
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round0(n: number): number {
  return Math.round(n);
}

function torsoScale(lm: Record<string, Pt | undefined>): number | null {
  const ls = pt(lm, "LEFT_SHOULDER");
  const rs = pt(lm, "RIGHT_SHOULDER");
  const lh = pt(lm, "LEFT_HIP");
  const rh = pt(lm, "RIGHT_HIP");
  if (!ls || !rs || !lh || !rh) return null;
  const midS = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
  const midH = { x: (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2 };
  const s = dist(midS, midH);
  return s > 0.02 ? s : null;
}

function pickRacketSide(lm: Record<string, Pt | undefined>): "LEFT" | "RIGHT" {
  const lw = pt(lm, "LEFT_WRIST");
  const rw = pt(lm, "RIGHT_WRIST");
  const ls = pt(lm, "LEFT_SHOULDER");
  const rs = pt(lm, "RIGHT_SHOULDER");
  if (!lw || !rw || !ls || !rs) return "RIGHT";
  return dist(rw, rs) >= dist(lw, ls) ? "RIGHT" : "LEFT";
}

function angleDeg(a: Pt, b: Pt, c: Pt): number | null {
  const bax = a.x - b.x;
  const bay = a.y - b.y;
  const bcx = c.x - b.x;
  const bcy = c.y - b.y;
  const denom = Math.hypot(bax, bay) * Math.hypot(bcx, bcy);
  if (denom < 1e-8) return null;
  let cos = (bax * bcx + bay * bcy) / denom;
  cos = Math.max(-1, Math.min(1, cos));
  return (Math.acos(cos) * 180) / Math.PI;
}

function contactFramesFromDet(det: Record<string, unknown> | null | undefined): number[] {
  if (!det) return [];
  for (const key of [
    "contact_window_frames_prompt",
    "contact_window_frames",
    "ball_racket_contact_frames_clip_local",
    "ball_racket_contact_frames",
  ]) {
    const raw = det[key];
    if (Array.isArray(raw) && raw.length) {
      return raw.filter((n): n is number => typeof n === "number" && Number.isFinite(n));
    }
  }
  return [];
}

/** Prefer densest YOLO contact cluster; median of that cluster. */
export function pickContactFrame(frames: number[]): number | null {
  if (!frames.length) return null;
  const sorted = [...frames].sort((a, b) => a - b);
  let bestStart = 0;
  let bestLen = 1;
  let curStart = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]! - sorted[i - 1]! <= 3) {
      const len = i - curStart + 1;
      if (len > bestLen) {
        bestLen = len;
        bestStart = curStart;
      }
    } else {
      curStart = i;
    }
  }
  const cluster = sorted.slice(bestStart, bestStart + bestLen);
  return cluster[Math.floor((cluster.length - 1) / 2)] ?? null;
}

export type CoachDerivedMotion = {
  lines: string[];
  contactFrame: number | null;
  contactMs: number | null;
  wristPeakBodyPerS: number | null;
  wristPeakKmhEst: number | null;
  elbowDeg: number | null;
  kneeDeg: number | null;
};

/**
 * Derive contact + wrist-speed proxies from pose + YOLO when stored bio speeds are null.
 */
export function deriveCoachMotion(metrics: Record<string, unknown> | null | undefined): CoachDerivedMotion {
  const empty: CoachDerivedMotion = {
    lines: [],
    contactFrame: null,
    contactMs: null,
    wristPeakBodyPerS: null,
    wristPeakKmhEst: null,
    elbowDeg: null,
    kneeDeg: null,
  };
  if (!metrics) return empty;

  const poseRaw = Array.isArray(metrics.pose_data) ? (metrics.pose_data as PoseRow[]) : [];
  const pose = [...poseRaw]
    .filter((r) => r && typeof r.frame === "number" && r.landmarks)
    .sort((a, b) => a.frame - b.frame);
  if (pose.length < 2) return empty;

  const totalFrames =
    typeof metrics.total_frames === "number" && metrics.total_frames > 0
      ? metrics.total_frames
      : pose[pose.length - 1]!.frame + 1;
  const durationMs =
    typeof metrics.video_duration_ms === "number" && metrics.video_duration_ms > 0
      ? metrics.video_duration_ms
      : 0;
  const fps = estimateFps(totalFrames, durationMs);

  const bio = metrics.biomechanics_summary as
    | { timing?: { impact_frame?: number | null; fps?: number }; speeds_body?: Record<string, unknown> }
    | undefined;
  let contactFrame =
    typeof bio?.timing?.impact_frame === "number" ? bio.timing.impact_frame : null;
  let contactSource = contactFrame != null ? "stored_impact_frame" : null;

  const det = metrics.detection_summary as Record<string, unknown> | null | undefined;
  const yoloFrames = contactFramesFromDet(det);
  if (contactFrame == null && yoloFrames.length) {
    contactFrame = pickContactFrame(yoloFrames);
    contactSource = "yolo_contact_cluster";
  }

  const ball = metrics.ball_trajectory as { apex_frame?: number; contact_y?: number } | null | undefined;
  if (contactFrame == null && typeof ball?.apex_frame === "number") {
    contactFrame = ball.apex_frame;
    contactSource = "ball_trajectory_apex";
  }

  const lines: string[] = [];
  const contactMs =
    contactFrame != null && fps > 0 ? round0((contactFrame / fps) * 1000) : null;
  if (contactFrame != null) {
    lines.push(
      `estimated_contact_frame: ${contactFrame} (source=${contactSource ?? "unknown"}; fps≈${round1(fps)})`
    );
  }
  if (contactMs != null) {
    lines.push(`estimated_contact_time_ms_from_clip_start: ${contactMs}`);
  }
  if (yoloFrames.length) {
    const lo = Math.min(...yoloFrames);
    const hi = Math.max(...yoloFrames);
    lines.push(
      `yolo_ball_racket_contact_frames: [${yoloFrames.slice(0, 12).join(", ")}${
        yoloFrames.length > 12 ? ", ..." : ""
      }] (span ${lo}-${hi}, n=${yoloFrames.length})`
    );
    if (yoloFrames.length >= 2) {
      lines.push(`yolo_contact_span_ms: ${round0(((hi - lo) / fps) * 1000)}`);
    }
  }

  // Wrist peak speed: prefer window ending at contact; else last 0.35s of clip.
  const endF =
    contactFrame != null ? contactFrame : pose[pose.length - 1]!.frame;
  const startF = Math.max(0, endF - Math.round(fps * 0.35));
  const window = pose.filter((r) => r.frame >= startF && r.frame <= endF);
  const endLm = window[window.length - 1]?.landmarks ?? pose[pose.length - 1]?.landmarks;
  let wristPeakBodyPerS: number | null = null;
  let wristPeakKmhEst: number | null = null;
  let elbowDeg: number | null = null;
  let kneeDeg: number | null = null;

  if (endLm && window.length >= 2) {
    const side = pickRacketSide(endLm);
    const scale = torsoScale(endLm);
    if (scale) {
      let peak = 0;
      let path = 0;
      for (let i = 1; i < window.length; i++) {
        const prev = window[i - 1]!;
        const cur = window[i]!;
        const w0 = pt(prev.landmarks, `${side}_WRIST`);
        const w1 = pt(cur.landmarks, `${side}_WRIST`);
        if (!w0 || !w1) continue;
        const step = dist(w0, w1) / scale;
        path += step;
        const dt = (cur.frame - prev.frame) / fps;
        if (dt > 0) {
          const speed = step / dt;
          if (speed > peak) peak = speed;
        }
      }
      if (peak > 0) {
        wristPeakBodyPerS = round1(peak);
        lines.push(
          `wrist_peak_body_per_s_derived: ${wristPeakBodyPerS} (racket-side ${side}, window frames ${startF}-${endF}; torso-normalized proxy, not radar gun)`
        );
        if (path > 0) {
          lines.push(`wrist_path_body_derived: ${round1(path)} body-lengths over that window`);
        }

        const playerCtx = (metrics.biomechanics_summary as { player_context?: { height_cm?: number } } | undefined)
          ?.player_context;
        const heightCm =
          typeof playerCtx?.height_cm === "number" && Number.isFinite(playerCtx.height_cm)
            ? playerCtx.height_cm
            : null;
        const court = parseCourtCalibration(metrics);
        const scaleAbs = resolveMetersPerTorsoUnit({ heightCm, court });
        const mps = bodySpeedToMps(wristPeakBodyPerS, scaleAbs.metersPerTorso);
        const kmh = mpsToKmh(mps);
        if (kmh != null) {
          wristPeakKmhEst = round1(kmh);
          lines.push(
            `wrist_peak_kmh_est_derived: ${wristPeakKmhEst} (scaled estimate from ${scaleAbs.status}; cite as an estimate)`
          );
        }
      }
    }

    const shoulder = pt(endLm, `${side}_SHOULDER`);
    const elbow = pt(endLm, `${side}_ELBOW`);
    const wrist = pt(endLm, `${side}_WRIST`);
    if (shoulder && elbow && wrist) {
      const a = angleDeg(shoulder, elbow, wrist);
      if (a != null) {
        elbowDeg = round0(a);
        lines.push(`elbow_angle_deg_at_estimated_contact: ${elbowDeg} (${side}, 2D image-plane proxy)`);
      }
    }
    const hip = pt(endLm, `${side}_HIP`) ?? pt(endLm, side === "RIGHT" ? "LEFT_HIP" : "RIGHT_HIP");
    const knee = pt(endLm, `${side}_KNEE`) ?? pt(endLm, side === "RIGHT" ? "LEFT_KNEE" : "RIGHT_KNEE");
    const ankle =
      pt(endLm, `${side}_ANKLE`) ?? pt(endLm, side === "RIGHT" ? "LEFT_ANKLE" : "RIGHT_ANKLE");
    if (hip && knee && ankle) {
      const a = angleDeg(hip, knee, ankle);
      if (a != null) {
        kneeDeg = round0(a);
        lines.push(`knee_angle_deg_at_estimated_contact: ${kneeDeg} (${side}, 2D image-plane proxy)`);
      }
    }
  }

  if (lines.length) {
    lines.push(
      "derived_motion_note: values above are computed for coaching from this clip; cite as estimates when spoken. Prefer a stored biomechanics field if the same metric is already listed. Never describe the product or training data negatively."
    );
  }

  return {
    lines,
    contactFrame,
    contactMs,
    wristPeakBodyPerS,
    wristPeakKmhEst,
    elbowDeg,
    kneeDeg,
  };
}

/** Merge derived lines when stored measured-motion list lacks speed/contact. */
export function enrichMeasuredMotionWithDerived(
  storedLines: string[],
  metrics: Record<string, unknown> | null | undefined
): string[] {
  const hasSpeed = storedLines.some((l) => /wrist_peak/i.test(l));
  const hasContactFrame = storedLines.some((l) => /impact_frame|contact_frame/i.test(l));
  const derived = deriveCoachMotion(metrics);
  if (!derived.lines.length) return storedLines;

  const extra: string[] = [];
  for (const line of derived.lines) {
    if (hasSpeed && /wrist_peak|wrist_path/i.test(line)) continue;
    if (hasContactFrame && /estimated_contact_frame|estimated_contact_time/i.test(line)) continue;
    // Always keep YOLO frame list / knee / elbow derived if not already present
    if (storedLines.some((s) => s.split(":")[0] === line.split(":")[0])) continue;
    extra.push(line);
  }
  return extra.length ? [...storedLines, ...extra] : storedLines;
}
