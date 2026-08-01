import { estimateFps } from "./impactPoseContext";

type Pt = { x: number; y: number; visibility?: number };

type PoseRow = {
  frame: number;
  landmarks?: Record<string, Pt | undefined>;
  ball_bbox?: number[];
  ball_conf?: number;
};

export type BiomechanicsSummary = {
  version: "v1.1";
  calibration: "uncalibrated_monocular";
  timing: {
    fps: number;
    impact_frame: number | null;
    impact_source: string | null;
    prep_to_impact_ms: number | null;
    impact_to_follow_ms: number | null;
    frames_prep_to_impact: number | null;
    frames_impact_to_follow: number | null;
  };
  angles_deg_proxy: {
    elbow_impact_deg: number | null;
    elbow_prep_deg: number | null;
    elbow_delta_deg: number | null;
    knee_impact_deg: number | null;
    shoulder_hip_sep_prep_deg: number | null;
    shoulder_hip_sep_impact_deg: number | null;
    torso_sep_delta_deg: number | null;
  };
  speeds_body: {
    scale: "torso_units";
    wrist_peak_body_per_s: number | null;
    wrist_path_prep_to_impact_body: number | null;
  };
  contact: {
    yolo_contact_count: number;
    contact_window_ms: number | null;
    ball_height_vs_hip: "above_hip" | "near_hip" | "below_hip" | "unknown";
    lob_rise: number | null;
  };
  quality: {
    pose_frames: number;
    mean_visibility: number | null;
    ball_track_n: number;
    cite_ok: boolean;
  };
};

function pt(lm: Record<string, Pt | undefined> | undefined, name: string): Pt | null {
  const p = lm?.[name];
  if (!p || typeof p.x !== "number" || typeof p.y !== "number") return null;
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
  return p;
}

function dist(a: Pt, b: Pt): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

/** Interior angle at b for points a-b-c, in degrees (2D image plane). */
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

function lineAngleDeg(a: Pt, b: Pt): number | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.hypot(dx, dy) < 1e-8) return null;
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round0(n: number): number {
  return Math.round(n);
}

function phaseFrame(
  seq: Array<{ phase?: string; frame?: number; landmarks?: Record<string, Pt | undefined> }> | undefined,
  phase: string
): { frame: number; landmarks: Record<string, Pt | undefined> } | null {
  if (!Array.isArray(seq)) return null;
  const row = seq.find((r) => r.phase === phase);
  if (!row || typeof row.frame !== "number" || !row.landmarks) return null;
  return { frame: row.frame, landmarks: row.landmarks };
}

function elbowDeg(lm: Record<string, Pt | undefined>, side: "LEFT" | "RIGHT"): number | null {
  const s = pt(lm, `${side}_SHOULDER`);
  const e = pt(lm, `${side}_ELBOW`);
  const w = pt(lm, `${side}_WRIST`);
  if (!s || !e || !w) return null;
  return angleDeg(s, e, w);
}

function kneeDeg(lm: Record<string, Pt | undefined>, side: "LEFT" | "RIGHT"): number | null {
  const h = pt(lm, `${side}_HIP`);
  const k = pt(lm, `${side}_KNEE`);
  const a = pt(lm, `${side}_ANKLE`);
  if (!h || !k || !a) return null;
  return angleDeg(h, k, a);
}

/** Absolute |shoulder-line angle − hip-line angle| in degrees (2D). */
function shoulderHipSepDeg(lm: Record<string, Pt | undefined>): number | null {
  const ls = pt(lm, "LEFT_SHOULDER");
  const rs = pt(lm, "RIGHT_SHOULDER");
  const lh = pt(lm, "LEFT_HIP");
  const rh = pt(lm, "RIGHT_HIP");
  if (!ls || !rs || !lh || !rh) return null;
  const sa = lineAngleDeg(ls, rs);
  const ha = lineAngleDeg(lh, rh);
  if (sa == null || ha == null) return null;
  let d = Math.abs(sa - ha);
  if (d > 180) d = 360 - d;
  return round1(d);
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
  const leftReach = dist(lw, ls);
  const rightReach = dist(rw, rs);
  return rightReach >= leftReach ? "RIGHT" : "LEFT";
}

function meanVisibility(pose: PoseRow[]): number | null {
  let sum = 0;
  let n = 0;
  for (const row of pose) {
    const lm = row.landmarks;
    if (!lm) continue;
    for (const key of ["LEFT_WRIST", "RIGHT_WRIST", "LEFT_SHOULDER", "RIGHT_SHOULDER", "LEFT_HIP", "RIGHT_HIP"]) {
      const p = lm[key];
      if (p && typeof p.visibility === "number" && Number.isFinite(p.visibility)) {
        sum += p.visibility;
        n += 1;
      }
    }
  }
  if (n === 0) return null;
  return round1(sum / n);
}

/** Prefer clip-local contact frames written by the router / yoloContactHints. */
function contactWindowFrames(
  det: Record<string, unknown> | null | undefined
): number[] {
  if (!det) return [];
  const prompt = det.contact_window_frames_prompt;
  if (Array.isArray(prompt) && prompt.length > 0) {
    return prompt.filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  }
  const raw = det.contact_window_frames;
  if (Array.isArray(raw) && raw.length > 0) {
    return raw.filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  }
  // Legacy field names (pre-v1.1) — keep as last resort.
  const legacyLocal = det.ball_racket_contact_frames_clip_local;
  if (Array.isArray(legacyLocal) && legacyLocal.length > 0) {
    return legacyLocal.filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  }
  const legacy = det.ball_racket_contact_frames;
  if (Array.isArray(legacy) && legacy.length > 0) {
    return legacy.filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  }
  return [];
}

/**
 * Compact measured motion summary for the analyze LLM + client Motion evidence UI.
 * Units are honest monocular proxies: ms, degrees (2D), body-lengths/s — never km/h.
 */
export function computeBiomechanicsSummary(metrics: Record<string, unknown>): BiomechanicsSummary {
  const poseRaw = Array.isArray(metrics.pose_data) ? (metrics.pose_data as PoseRow[]) : [];
  const pose = [...poseRaw]
    .filter((r) => r && typeof r.frame === "number" && r.landmarks)
    .sort((a, b) => a.frame - b.frame);

  const totalFrames =
    typeof metrics.total_frames === "number" && metrics.total_frames > 0
      ? metrics.total_frames
      : pose.length > 0
        ? pose[pose.length - 1].frame + 1
        : 0;
  const durationMs =
    typeof metrics.video_duration_ms === "number" && metrics.video_duration_ms > 0
      ? metrics.video_duration_ms
      : 0;
  const fps = estimateFps(totalFrames, durationMs);

  const seq = metrics.impact_pose_sequence as
    | Array<{ phase?: string; frame?: number; landmarks?: Record<string, Pt | undefined> }>
    | undefined;
  const prep = phaseFrame(seq, "preparation");
  const impact = phaseFrame(seq, "impact");
  const follow = phaseFrame(seq, "follow_through");

  const impactFrame =
    typeof metrics.impact_frame_resolved === "number"
      ? metrics.impact_frame_resolved
      : impact?.frame ?? null;
  const impactSource =
    typeof metrics.impact_frame_source === "string" ? metrics.impact_frame_source : null;

  const framesPrepToImpact =
    prep && impactFrame != null ? Math.max(0, impactFrame - prep.frame) : null;
  const framesImpactToFollow =
    follow && impactFrame != null ? Math.max(0, follow.frame - impactFrame) : null;

  const prepToImpactMs =
    framesPrepToImpact != null ? round0((framesPrepToImpact / fps) * 1000) : null;
  const impactToFollowMs =
    framesImpactToFollow != null ? round0((framesImpactToFollow / fps) * 1000) : null;

  const impactLm = impact?.landmarks;
  const prepLm = prep?.landmarks;
  const side = impactLm ? pickRacketSide(impactLm) : "RIGHT";

  const elbowImpact = impactLm ? elbowDeg(impactLm, side) : null;
  const elbowPrep = prepLm ? elbowDeg(prepLm, side) : null;
  const elbowDelta =
    elbowImpact != null && elbowPrep != null ? round0(elbowImpact - elbowPrep) : null;

  const kneeImpact = impactLm
    ? kneeDeg(impactLm, side) ?? kneeDeg(impactLm, side === "RIGHT" ? "LEFT" : "RIGHT")
    : null;

  const shoulderHipSepPrep = prepLm ? shoulderHipSepDeg(prepLm) : null;
  const shoulderHipSepImpact = impactLm ? shoulderHipSepDeg(impactLm) : null;
  const torsoSepDelta =
    shoulderHipSepImpact != null && shoulderHipSepPrep != null
      ? round1(shoulderHipSepImpact - shoulderHipSepPrep)
      : null;

  // Wrist speed / path in torso units between prep and impact (or nearby window).
  let wristPeakBodyPerS: number | null = null;
  let wristPathBody: number | null = null;
  if (pose.length >= 2 && impactFrame != null) {
    const startF = prep?.frame ?? Math.max(0, impactFrame - Math.round(fps * 0.35));
    const endF = impactFrame;
    const window = pose.filter((r) => r.frame >= startF && r.frame <= endF);
    const scaleLm = impactLm ?? window[window.length - 1]?.landmarks;
    const scale = scaleLm ? torsoScale(scaleLm) : null;
    if (scale && window.length >= 2) {
      let path = 0;
      let peak = 0;
      for (let i = 1; i < window.length; i++) {
        const prev = window[i - 1];
        const cur = window[i];
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
      if (path > 0) wristPathBody = round1(path);
      if (peak > 0) wristPeakBodyPerS = round1(peak);
    }
  }

  const det = metrics.detection_summary as Record<string, unknown> | null | undefined;
  const contactFrames = contactWindowFrames(det);
  let contactWindowMs: number | null = null;
  if (contactFrames.length >= 2) {
    const lo = Math.min(...contactFrames);
    const hi = Math.max(...contactFrames);
    contactWindowMs = round0(((hi - lo) / fps) * 1000);
  } else if (contactFrames.length === 1) {
    contactWindowMs = round0((1 / fps) * 1000);
  }

  let ballHeight: BiomechanicsSummary["contact"]["ball_height_vs_hip"] = "unknown";
  const impactRow =
    impactFrame != null
      ? pose.find((r) => r.frame === impactFrame) ??
        pose.reduce<PoseRow | null>((best, r) => {
          if (!best) return r;
          return Math.abs(r.frame - impactFrame) < Math.abs(best.frame - impactFrame) ? r : best;
        }, null)
      : null;
  if (impactRow?.ball_bbox && impactRow.ball_bbox.length === 4 && impactRow.landmarks) {
    const [, y1, , y2] = impactRow.ball_bbox;
    const ballCy = (y1 + y2) / 2;
    const lh = pt(impactRow.landmarks, "LEFT_HIP");
    const rh = pt(impactRow.landmarks, "RIGHT_HIP");
    if (lh && rh) {
      const hipY = (lh.y + rh.y) / 2;
      if (ballCy < hipY - 0.04) ballHeight = "above_hip";
      else if (ballCy > hipY + 0.04) ballHeight = "below_hip";
      else ballHeight = "near_hip";
    }
  }

  const lob = metrics.ball_trajectory as { rise?: number } | null | undefined;
  const lobRise =
    lob && typeof lob.rise === "number" && Number.isFinite(lob.rise) ? round1(lob.rise) : null;

  const ballTrackN = pose.filter(
    (r) => Array.isArray(r.ball_bbox) && r.ball_bbox.length === 4
  ).length;
  const meanVis = meanVisibility(pose);
  const citeOk =
    pose.length >= 8 &&
    (prepToImpactMs != null ||
      elbowImpact != null ||
      wristPeakBodyPerS != null ||
      torsoSepDelta != null);

  return {
    version: "v1.1",
    calibration: "uncalibrated_monocular",
    timing: {
      fps: round1(fps),
      impact_frame: impactFrame,
      impact_source: impactSource,
      prep_to_impact_ms:
        prepToImpactMs != null && prepToImpactMs >= 0 ? prepToImpactMs : null,
      impact_to_follow_ms:
        impactToFollowMs != null && impactToFollowMs >= 0 ? impactToFollowMs : null,
      frames_prep_to_impact: framesPrepToImpact,
      frames_impact_to_follow: framesImpactToFollow,
    },
    angles_deg_proxy: {
      elbow_impact_deg: elbowImpact != null ? round0(elbowImpact) : null,
      elbow_prep_deg: elbowPrep != null ? round0(elbowPrep) : null,
      elbow_delta_deg: elbowDelta,
      knee_impact_deg: kneeImpact != null ? round0(kneeImpact) : null,
      shoulder_hip_sep_prep_deg: shoulderHipSepPrep,
      shoulder_hip_sep_impact_deg: shoulderHipSepImpact,
      torso_sep_delta_deg: torsoSepDelta,
    },
    speeds_body: {
      scale: "torso_units",
      wrist_peak_body_per_s: wristPeakBodyPerS,
      wrist_path_prep_to_impact_body: wristPathBody,
    },
    contact: {
      yolo_contact_count: contactFrames.length,
      contact_window_ms: contactWindowMs,
      ball_height_vs_hip: ballHeight,
      lob_rise: lobRise,
    },
    quality: {
      pose_frames: pose.length,
      mean_visibility: meanVis,
      ball_track_n: ballTrackN,
      cite_ok: citeOk,
    },
  };
}

/** Prompt block: measured motion the model must cite when quality.cite_ok. */
export function formatBiomechanicsForPrompt(summary: BiomechanicsSummary | null | undefined): string {
  if (!summary) return "";
  const lines = [
    "Measured motion (from MediaPipe pose + YOLO; monocular proxies — never invent km/h or metres):",
    JSON.stringify(summary),
    "Citation rules:",
    "- When quality.cite_ok is true, EVERY one of diagnosis, each strengths item, each technical_errors item, and each actionable_corrections item MUST include at least one concrete figure from this block (ms, approximate degrees / deltas, or wrist body-lengths/s).",
    "- Prefer prep_to_impact_ms (+ frames_prep_to_impact), torso_sep_delta_deg, elbow_delta_deg / elbow_impact_deg, wrist_peak_body_per_s, contact_window_ms when non-null.",
    "- Label angles as approximate pose readings; speeds as body-lengths per second (torso scale), not km/h.",
    "- Do not dump raw landmark coordinates or the full JSON into user-facing text.",
  ];
  return lines.join("\n");
}
