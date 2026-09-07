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
