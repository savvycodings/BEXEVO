import type { DenseTrack } from './types'

/**
 * How front-on the body is to the camera: median over frames of 2D shoulder width / torso length.
 * About 0.6+ for a front or back view, under about 0.3 for a side view.
 */
export function facingRatio(t: DenseTrack): number {
  const r = t.frames.map((f) => {
    const px = (i: number) => [f.image[i]![0]! * t.width, f.image[i]![1]! * t.height] as const
    const [ls, rs, lh, rh] = [px(11), px(12), px(23), px(24)]
    const sw = Math.hypot(ls[0] - rs[0], ls[1] - rs[1])
    const th = Math.hypot((ls[0] + rs[0] - lh[0] - rh[0]) / 2, (ls[1] + rs[1] - lh[1] - rh[1]) / 2)
    return th > 0 ? sw / th : 0
  }).sort((a, b) => a - b)
  return r[Math.floor(r.length / 2)] ?? 0
}

/** The two clips are filmed from clearly different angles (e.g. front vs side). */
export function viewsDiffer(player: DenseTrack, ref: DenseTrack, maxRatio = 1.8): boolean {
  const a = facingRatio(player)
  const b = facingRatio(ref)
  if (a <= 0 || b <= 0) return false
  return Math.max(a, b) / Math.min(a, b) > maxRatio
}
