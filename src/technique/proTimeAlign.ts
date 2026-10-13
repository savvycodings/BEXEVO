/**
 * Time alignment between a user clip and a pro-library clip. Pure functions, no DB, so the
 * control-clip geometry can be unit tested without a database.
 */
import type { TrainPoseFrame } from "../db/schema";

/**
 * Pick the pro frame at the same time offset from contact as `userVideoFrameIndex` is from
 * the user's impact. Keeps swing phase matched when the two clips place contact differently.
 * Pro `frame_idx` runs on a stride (5 in train_modal_app), so this snaps to the nearest row.
 */
export function pickImpactAlignedProPoseFrame(opts: {
  userVideoFrameIndex: number;
  userImpactFrame: number;
  userFps: number;
  proSeq: TrainPoseFrame[];
  proImpactFrame: number;
  proFps: number;
}): TrainPoseFrame | null {
  const { proSeq } = opts;
  if (!proSeq.length) return null;
  const userFps = opts.userFps > 0 ? opts.userFps : 30;
  const proFps = opts.proFps > 0 ? opts.proFps : userFps;
  const offsetMs =
    ((opts.userVideoFrameIndex - opts.userImpactFrame) / userFps) * 1000;
  const targetProIdx = opts.proImpactFrame + (offsetMs * proFps) / 1000;

  let best = proSeq[0]!;
  let bestD = Math.abs(best.frame_idx - targetProIdx);
  for (const row of proSeq) {
    const d = Math.abs(row.frame_idx - targetProIdx);
    if (d < bestD) {
      bestD = d;
      best = row;
    }
  }
  return best;
}

type PoseJoint = { x: number; y: number; z?: number; visibility?: number };

/**
 * Joint-wise linear blend between two poses at `t` in [0, 1]. A joint present on only one side
 * comes from the nearer pose, so a brief dropout does not make it vanish mid-window.
 */
export function lerpLandmarks<L extends Record<string, PoseJoint | undefined>>(
  a: L,
  b: L,
  t: number
): L {
  const out: Record<string, PoseJoint> = {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const pa = a[k];
    const pb = b[k];
    if (pa && pb) {
      const j: PoseJoint = { x: pa.x + (pb.x - pa.x) * t, y: pa.y + (pb.y - pa.y) * t };
      if (pa.z != null && pb.z != null) j.z = pa.z + (pb.z - pa.z) * t;
      if (pa.visibility != null && pb.visibility != null) j.visibility = Math.min(pa.visibility, pb.visibility);
      out[k] = j;
    } else {
      const only = t < 0.5 ? (pa ?? pb) : (pb ?? pa);
      if (only) out[k] = only;
    }
  }
  return out as L;
}

/**
 * Pro pose at a fractional frame index, interpolated between the rows either side. Pro rows sit
 * on a stride (5 in train_modal_app), so snapping to the nearest row makes the pro limbs move in
 * steps. Clamps to the first and last row like `pickImpactAlignedProPoseFrame`.
 */
export function interpolateProPoseAt(proSeq: TrainPoseFrame[], targetIdx: number): TrainPoseFrame | null {
  const rows = proSeq
    .filter((r) => r.landmarks && Object.keys(r.landmarks).length > 0)
    .sort((a, b) => a.frame_idx - b.frame_idx);
  if (!rows.length) return null;
  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  if (targetIdx <= first.frame_idx) return first;
  if (targetIdx >= last.frame_idx) return last;
  let k = 0;
  while (k < rows.length - 1 && rows[k + 1]!.frame_idx <= targetIdx) k++;
  const lo = rows[k]!;
  if (lo.frame_idx === targetIdx || k === rows.length - 1) return lo;
  const hi = rows[k + 1]!;
  const t = (targetIdx - lo.frame_idx) / (hi.frame_idx - lo.frame_idx);
  return { frame_idx: targetIdx, landmarks: lerpLandmarks(lo.landmarks, hi.landmarks, t) };
}

/** Same contact-to-contact mapping as `pickImpactAlignedProPoseFrame`, interpolated instead of snapped. */
export function impactAlignedProPoseAt(opts: {
  userVideoFrameIndex: number;
  userImpactFrame: number;
  userFps: number;
  proSeq: TrainPoseFrame[];
  proImpactFrame: number;
  proFps: number;
}): TrainPoseFrame | null {
  const userFps = opts.userFps > 0 ? opts.userFps : 30;
  const proFps = opts.proFps > 0 ? opts.proFps : userFps;
  const offsetMs = ((opts.userVideoFrameIndex - opts.userImpactFrame) / userFps) * 1000;
  return interpolateProPoseAt(opts.proSeq, opts.proImpactFrame + (offsetMs * proFps) / 1000);
}

/** Span at each end of a pro clip over which trust in its pose ramps from 0 to 1. */
const PRO_EDGE_TRUST_MS = 150;

/**
 * How far to trust the pro pose at a fractional pro frame, 0-1. Outside the clip the pose is
 * clamped (frozen on the first or last row), so it carries no motion: 0. Pose tracking is also
 * least reliable over the last and first frames, where the player walks off or the tracker
 * re-acquires, so trust ramps up over `PRO_EDGE_TRUST_MS` from each end.
 */
export function proTrustAt(proSeq: TrainPoseFrame[], targetIdx: number, proFps: number): number {
  const idxs = proSeq
    .filter((r) => r.landmarks && Object.keys(r.landmarks).length > 0)
    .map((r) => r.frame_idx);
  if (!idxs.length) return 0;
  const first = Math.min(...idxs);
  const last = Math.max(...idxs);
  if (targetIdx < first || targetIdx > last) return 0;
  const fps = proFps > 0 ? proFps : 30;
  const edgeFrames = (PRO_EDGE_TRUST_MS / 1000) * fps;
  if (edgeFrames <= 0) return 1;
  const fromEdge = Math.min(targetIdx - first, last - targetIdx);
  return Math.max(0, Math.min(1, fromEdge / edgeFrames));
}

/** `proTrustAt` for each user frame under the same contact-to-contact mapping as `impactAlignedProPoseAt`. */
export function proTrustByImpact(opts: {
  userFrameIndices: number[];
  userImpactFrame: number;
  userFps: number;
  proSeq: TrainPoseFrame[];
  proImpactFrame: number;
  proFps: number;
}): number[] {
  const userFps = opts.userFps > 0 ? opts.userFps : 30;
  const proFps = opts.proFps > 0 ? opts.proFps : userFps;
  return opts.userFrameIndices.map((idx) => {
    const offsetMs = ((idx - opts.userImpactFrame) / userFps) * 1000;
    return proTrustAt(opts.proSeq, opts.proImpactFrame + (offsetMs * proFps) / 1000, proFps);
  });
}

/**
 * Map user video frame index to a pro-library frame by relative position in the clip.
 * Embedding matched the whole pro sequence; this picks a comparable instant for landmark targets.
 * Uses frame_idx when present (train_modal_app) so array order matches video timeline.
 *
 * Fallback for clips whose pro contact frame was never resolved; prefer
 * `pickImpactAlignedProPoseFrame` when it is available.
 */
export function pickAlignedProPoseFrame(
  userVideoFrameIndex: number,
  videoTotalFrames: number,
  proSeq: TrainPoseFrame[]
): TrainPoseFrame | null {
  if (!proSeq.length) return null;
  const sorted = [...proSeq].sort((a, b) => a.frame_idx - b.frame_idx);
  const tf = Math.max(1, videoTotalFrames);
  const t = Math.max(0, Math.min(1, userVideoFrameIndex / Math.max(1, tf - 1)));
  const proMaxIdx = sorted[sorted.length - 1]?.frame_idx ?? sorted.length - 1;
  const targetProIdx = Math.round(t * Math.max(0, proMaxIdx));

  let best = sorted[0]!;
  let bestD = Math.abs(best.frame_idx - targetProIdx);
  for (const row of sorted) {
    const d = Math.abs(row.frame_idx - targetProIdx);
    if (d < bestD) {
      bestD = d;
      best = row;
    }
  }
  return best;
}
