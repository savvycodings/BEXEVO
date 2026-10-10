import type { DenseFrame, Vec3 } from './types'

const FIT_JOINTS = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]

/**
 * Pixels per world meter for one frame: least-squares weak-perspective fit (scale + offset) from
 * world (x, y) to image pixels. MediaPipe world axes are camera-aligned, so no rotation is needed.
 * Returns null when the fit is unusable (too few joints, non-positive scale, large residual).
 */
export function fitScale(frame: DenseFrame, width: number, height: number): number | null {
  const pts = FIT_JOINTS.map((j) => ({
    X: frame.world[j]![0], Y: frame.world[j]![1],
    u: frame.image[j]![0]! * width, v: frame.image[j]![1]! * height,
  }))
  if (pts.length < 4) return null
  const m = (k: 'X' | 'Y' | 'u' | 'v') => pts.reduce((s, p) => s + p[k], 0) / pts.length
  const X0 = m('X'), Y0 = m('Y'), u0 = m('u'), v0 = m('v')
  let num = 0
  let den = 0
  for (const p of pts) {
    num += (p.X - X0) * (p.u - u0) + (p.Y - Y0) * (p.v - v0)
    den += (p.X - X0) ** 2 + (p.Y - Y0) ** 2
  }
  if (den < 1e-9) return null
  const a = num / den
  if (!(a > 0)) return null
  const rms = Math.sqrt(
    pts.reduce((s, p) => s + (a * (p.X - X0) + u0 - p.u) ** 2 + (a * (p.Y - Y0) + v0 - p.v) ** 2, 0) / pts.length,
  )
  const vs = pts.map((p) => p.v)
  const bodyPx = Math.max(...vs) - Math.min(...vs)
  if (bodyPx > 0 && rms > 0.25 * bodyPx) return null
  return a
}

/**
 * Corrected image landmarks: the player's own image landmarks plus the projected world change.
 * Joints the correction didn't move land exactly where the player is in the video.
 */
export function projectCorrection(
  frame: DenseFrame,
  correctedWorld: Vec3[],
  pxPerMeter: number,
  width: number,
  height: number,
): number[][] {
  return frame.image.map((p, i) => {
    const dX = correctedWorld[i]![0] - frame.world[i]![0]
    const dY = correctedWorld[i]![1] - frame.world[i]![1]
    return [p[0]! + (pxPerMeter * dX) / width, p[1]! + (pxPerMeter * dY) / height, p[2]!, p[3]!]
  })
}

/** Per-frame scales with the previous good fit standing in for a bad one. */
export function fitScales(frames: DenseFrame[], width: number, height: number): number[] {
  const raw = frames.map((f) => fitScale(f, width, height))
  const firstGood = raw.find((a) => a != null) ?? Math.max(width, height) / 2
  let last = firstGood
  return raw.map((a) => (a != null ? (last = a) : last))
}
