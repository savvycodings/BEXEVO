import { downsamplePoseFramesForPrompt } from './poseEmbedding'

const CORRECTION_METRIC_KEYS = [
  'correction_images',
  'correction_images_fal',
  'correction_images_comfy',
  'correction_context',
  'correction_context_fal',
  'correction_context_comfy',
  'correction_videos_comfy',
  'correction_context_videos_comfy',
] as const

const MAX_POSE_SAMPLES_CLIENT = 80

/** Slim metrics for mobile/web poll — omit multi‑MB base64 correction blobs. */
export function metricsForClientFetch(
  metrics: Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
  if (!metrics || typeof metrics !== 'object') return null
  const m = { ...metrics }
  for (const k of CORRECTION_METRIC_KEYS) {
    delete m[k]
  }
  const gemini = metrics.correction_images
  m.has_correction_images = Array.isArray(gemini) && gemini.length > 0
  const wanVideo = metrics.correction_videos_comfy
  m.has_correction_videos =
    !!wanVideo &&
    typeof wanVideo === 'object' &&
    typeof (wanVideo as { video?: unknown }).video === 'string' &&
    String((wanVideo as { video: string }).video).trim().length > 0
  const pose = m.pose_data
  if (Array.isArray(pose) && pose.length > MAX_POSE_SAMPLES_CLIENT) {
    m.pose_data = downsamplePoseFramesForPrompt(
      pose as Array<{ frame: number }>,
      MAX_POSE_SAMPLES_CLIENT
    )
    m.pose_data_client_downsampled = true
    m.pose_data_total_samples = pose.length
  }
  return m
}
