import { downsamplePoseFramesForPrompt } from './poseEmbedding'

/** Max pose samples returned for client video overlay (racket/ball boxes + skeleton).
 * 900 ≈ 30s @ 30fps so typical analyze clips stay full density; longer uploads downsample. */
export const MAX_POSE_OVERLAY_FRAMES = 900

/** Analyze Step-2 clips are ~3s; never thin those even if sample count exceeds the soft cap. */
export const SHORT_CLIP_FULL_DENSITY_MS = 5000

export function slimPoseRowForOverlay(row: unknown): Record<string, unknown> | null {
  if (!row || typeof row !== 'object') return null
  const r = row as Record<string, unknown>
  const frame =
    typeof r.frame === 'number'
      ? r.frame
      : typeof r.frame_idx === 'number'
        ? r.frame_idx
        : NaN
  if (!Number.isFinite(frame)) return null
  const lm = r.landmarks
  if (!lm || typeof lm !== 'object') return null
  const out: Record<string, unknown> = { frame, landmarks: lm }
  if (Array.isArray(r.racket_bbox) && r.racket_bbox.length === 4) {
    out.racket_bbox = r.racket_bbox
  }
  if (typeof r.racket_conf === 'number') out.racket_conf = r.racket_conf
  if (r.racket_hand === 'left' || r.racket_hand === 'right') {
    out.racket_hand = r.racket_hand
  }
  if (Array.isArray(r.ball_bbox) && r.ball_bbox.length === 4) {
    out.ball_bbox = r.ball_bbox
  }
  if (typeof r.ball_conf === 'number') out.ball_conf = r.ball_conf
  return out
}

export function poseDataForOverlayFetch(
  poseRaw: unknown,
  maxFrames = MAX_POSE_OVERLAY_FRAMES,
  opts?: { videoDurationMs?: number | null }
): Record<string, unknown>[] {
  if (!Array.isArray(poseRaw) || poseRaw.length === 0) return []
  const durationMs =
    typeof opts?.videoDurationMs === 'number' && opts.videoDurationMs > 0
      ? opts.videoDurationMs
      : null
  // Short analyze clips: return every stored pose row (Modal is already every-frame).
  const keepFull =
    poseRaw.length <= maxFrames ||
    (durationMs != null && durationMs <= SHORT_CLIP_FULL_DENSITY_MS)
  const sampled = keepFull
    ? (poseRaw as Array<{ frame: number }>)
    : downsamplePoseFramesForPrompt(poseRaw as Array<{ frame: number }>, maxFrames)
  const out: Record<string, unknown>[] = []
  for (const row of sampled) {
    const slim = slimPoseRowForOverlay(row)
    if (slim) out.push(slim)
  }
  return out
}
