import { downsamplePoseFramesForPrompt } from './poseEmbedding'

/** Max pose samples returned for client video overlay (racket/ball boxes + skeleton). */
export const MAX_POSE_OVERLAY_FRAMES = 200

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
  maxFrames = MAX_POSE_OVERLAY_FRAMES
): Record<string, unknown>[] {
  if (!Array.isArray(poseRaw) || poseRaw.length === 0) return []
  const sampled = downsamplePoseFramesForPrompt(
    poseRaw as Array<{ frame: number }>,
    maxFrames
  )
  const out: Record<string, unknown>[] = []
  for (const row of sampled) {
    const slim = slimPoseRowForOverlay(row)
    if (slim) out.push(slim)
  }
  return out
}
