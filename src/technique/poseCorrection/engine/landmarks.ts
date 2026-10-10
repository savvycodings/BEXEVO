import type { DenseFrame, DenseTrack, PoseTrack, Side, Vec3 } from './types'

/** MediaPipe Pose landmark indices (LEFT/RIGHT are the person's own sides). */
export const LM = {
  NOSE: 0,
  LEFT_EYE: 2,
  RIGHT_EYE: 5,
  LEFT_EAR: 7,
  RIGHT_EAR: 8,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28,
} as const

export const HEAD = [LM.NOSE, LM.LEFT_EYE, LM.RIGHT_EYE, LM.LEFT_EAR, LM.RIGHT_EAR]

export function sideIdx(side: Side) {
  return side === 'LEFT'
    ? { shoulder: LM.LEFT_SHOULDER, elbow: LM.LEFT_ELBOW, wrist: LM.LEFT_WRIST, hip: LM.LEFT_HIP, knee: LM.LEFT_KNEE, ankle: LM.LEFT_ANKLE }
    : { shoulder: LM.RIGHT_SHOULDER, elbow: LM.RIGHT_ELBOW, wrist: LM.RIGHT_WRIST, hip: LM.RIGHT_HIP, knee: LM.RIGHT_KNEE, ankle: LM.RIGHT_ANKLE }
}

export const otherSide = (s: Side): Side => (s === 'LEFT' ? 'RIGHT' : 'LEFT')

/** Left/right landmark pairs of the 33-point model. */
const MIRROR_PAIRS: Array<[number, number]> = [
  [1, 4], [2, 5], [3, 6], [7, 8], [9, 10], [11, 12], [13, 14], [15, 16],
  [17, 18], [19, 20], [21, 22], [23, 24], [25, 26], [27, 28], [29, 30], [31, 32],
]
const MIRROR_INDEX: number[] = (() => {
  const m = Array.from({ length: 33 }, (_, i) => i)
  for (const [a, b] of MIRROR_PAIRS) {
    m[a] = b
    m[b] = a
  }
  return m
})()

/**
 * Mirror a track horizontally: x flips AND left/right names swap, so a left-handed stroke reads as
 * a right-handed one with the racket arm still labeled as the racket arm.
 */
export function mirrorTrack(track: DenseTrack): DenseTrack {
  return {
    ...track,
    frames: track.frames.map((f) => ({
      t: f.t,
      image: MIRROR_INDEX.map((src) => {
        const p = f.image[src]!
        return [1 - p[0]!, p[1]!, p[2]!, p[3]!]
      }),
      world: MIRROR_INDEX.map((src) => {
        const p = f.world[src]!
        return [-p[0], p[1], p[2]] as Vec3
      }),
    })),
  }
}

function lerpRows(a: number[][], b: number[][], t: number): number[][] {
  return a.map((row, i) => row.map((v, j) => v + (b[i]![j]! - v) * t))
}

/**
 * Drop frames where the tracker latched onto someone else: the body's center jumps sideways, or
 * its size drops, against the median of nearby frames (e.g. a smaller player in the background).
 * Dropped frames become gaps, which densify() fills from their neighbours.
 */
export function rejectPoseOutliers(track: PoseTrack, opts: { radius?: number; maxShift?: number; minScale?: number } = {}): PoseTrack {
  const radius = opts.radius ?? 4
  const maxShift = opts.maxShift ?? 0.35 // of body height
  const minScale = opts.minScale ?? 0.8
  const { width, height } = track
  const stats = track.frames.map((f) => {
    if (!f.image) return null
    const px = (i: number) => [f.image![i]![0]! * width, f.image![i]![1]! * height]
    const hip = [(px(23)[0]! + px(24)[0]!) / 2, (px(23)[1]! + px(24)[1]!) / 2]
    const sh = [(px(11)[0]! + px(12)[0]!) / 2, (px(11)[1]! + px(12)[1]!) / 2]
    const ankleY = Math.max(px(27)[1]!, px(28)[1]!)
    const size = Math.max(1, Math.hypot(sh[0]! - hip[0]!, sh[1]! - hip[1]!) + Math.abs(ankleY - hip[1]!))
    return { x: hip[0]!, y: hip[1]!, size }
  })
  const median = (xs: number[]) => {
    const a = [...xs].sort((p, q) => p - q)
    return a[Math.floor(a.length / 2)]!
  }
  const frames = track.frames.map((f, i) => {
    const me = stats[i]
    if (!me) return f
    const near = stats.slice(Math.max(0, i - radius), i + radius + 1).filter((s): s is NonNullable<typeof s> => !!s)
    if (near.length < 3) return f
    const mx = median(near.map((s) => s.x))
    const my = median(near.map((s) => s.y))
    const ms = median(near.map((s) => s.size))
    const jumped = Math.hypot(me.x - mx, me.y - my) > maxShift * ms
    const shrank = me.size < minScale * ms
    return jumped || shrank ? { t: f.t, image: null, world: null } : f
  })
  const detected = frames.filter((f) => f.image).length
  return { ...track, frames, detectionRate: frames.length ? detected / frames.length : 0 }
}

/**
 * Fill frames with no detection by interpolating between the nearest detected frames (holding at
 * the ends), then smooth every coordinate with a centered moving average of `window` frames.
 */
export function densify(track: PoseTrack, window = 5): DenseTrack {
  const n = track.frames.length
  const detected = track.frames.map((f, i) => (f.image && f.world ? i : -1)).filter((i) => i >= 0)
  if (!detected.length) throw new Error('No body detected in any frame')

  const filled: Array<{ image: number[][]; world: number[][] }> = []
  for (let i = 0; i < n; i++) {
    const f = track.frames[i]!
    if (f.image && f.world) {
      filled.push({ image: f.image, world: f.world })
      continue
    }
    const prev = [...detected].reverse().find((d) => d < i)
    const next = detected.find((d) => d > i)
    const a = track.frames[prev ?? next!]!
    const b = track.frames[next ?? prev!]!
    const t = prev != null && next != null ? (i - prev) / (next - prev) : 0
    filled.push({ image: lerpRows(a.image!, b.image!, t), world: lerpRows(a.world!, b.world!, t) })
  }

  const half = Math.floor(window / 2)
  const smooth = (rows: Array<number[][]>, i: number): number[][] => {
    const lo = Math.max(0, i - half)
    const hi = Math.min(n - 1, i + half)
    const out = rows[i]!.map((r) => r.map(() => 0))
    for (let k = lo; k <= hi; k++) rows[k]!.forEach((r, a) => r.forEach((v, b) => (out[a]![b]! += v)))
    const c = hi - lo + 1
    return out.map((r) => r.map((v) => v / c))
  }
  const images = filled.map((f) => f.image)
  const worlds = filled.map((f) => f.world)
  const frames: DenseFrame[] = track.frames.map((f, i) => {
    const image = smooth(images, i)
    // keep raw visibility (column 3) rather than its average
    image.forEach((r, a) => (r[3] = images[i]![a]![3]!))
    return { t: f.t, image, world: smooth(worlds, i) as Vec3[] }
  })
  return { fps: track.fps, width: track.width, height: track.height, frameCount: n, detectionRate: track.detectionRate, frames }
}

/** Pose at a fractional frame index, linearly interpolated (clamped to the track). */
export function sampleTrack(track: DenseTrack, frameIdx: number): DenseFrame {
  const n = track.frames.length
  const x = Math.min(n - 1, Math.max(0, frameIdx))
  const i = Math.floor(x)
  const j = Math.min(n - 1, i + 1)
  const t = x - i
  const a = track.frames[i]!
  const b = track.frames[j]!
  if (t === 0 || i === j) return a
  return {
    t: a.t + (b.t - a.t) * t,
    image: lerpRows(a.image, b.image, t),
    world: lerpRows(a.world, b.world, t) as Vec3[],
  }
}
