import { LM } from './landmarks'
import type { DenseFrame, DenseTrack, Vec3 } from './types'
import { add, rad, scale } from './vec'

/**
 * A simple standing figure in MediaPipe world coordinates (meters, y down), facing the camera.
 * `elbowDeg` is the racket (right) elbow's interior angle; the forearm bends forward (toward -z).
 */
export function standingPose(opts: { elbowDeg?: number; kneeDeg?: number; armLen?: number } = {}): Vec3[] {
  const elbowDeg = opts.elbowDeg ?? 160
  const armLen = opts.armLen ?? 0.28
  const w: Vec3[] = Array.from({ length: 33 }, () => [0, 0, 0] as Vec3)
  w[LM.LEFT_HIP] = [0.1, 0, 0]
  w[LM.RIGHT_HIP] = [-0.1, 0, 0]
  w[LM.LEFT_SHOULDER] = [0.18, -0.5, 0]
  w[LM.RIGHT_SHOULDER] = [-0.18, -0.5, 0]
  // arms hang down, elbows bend forward
  for (const [sh, el, wr, ang] of [
    [LM.LEFT_SHOULDER, LM.LEFT_ELBOW, LM.LEFT_WRIST, 170],
    [LM.RIGHT_SHOULDER, LM.RIGHT_ELBOW, LM.RIGHT_WRIST, elbowDeg],
  ] as const) {
    w[el] = add(w[sh]!, [0, armLen, 0])
    const bend = rad(180 - ang)
    w[wr] = add(w[el]!, scale([0, Math.cos(bend), -Math.sin(bend)], 0.25))
  }
  const knee = rad(180 - (opts.kneeDeg ?? 170))
  for (const [hip, kn, an] of [
    [LM.LEFT_HIP, LM.LEFT_KNEE, LM.LEFT_ANKLE],
    [LM.RIGHT_HIP, LM.RIGHT_KNEE, LM.RIGHT_ANKLE],
  ] as const) {
    w[kn] = add(w[hip]!, [0, 0.42, 0])
    w[an] = add(w[kn]!, scale([0, Math.cos(knee), Math.sin(knee)], 0.4))
  }
  for (const i of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) w[i] = [0, -0.68, -0.05]
  for (const i of [17, 19, 21]) w[i] = w[LM.LEFT_WRIST]!
  for (const i of [18, 20, 22]) w[i] = w[LM.RIGHT_WRIST]!
  for (const i of [29, 31]) w[i] = w[LM.LEFT_ANKLE]!
  for (const i of [30, 32]) w[i] = w[LM.RIGHT_ANKLE]!
  return w
}

/** Image landmarks for a world pose under a weak-perspective camera (px per meter, center). */
export function imageOf(world: Vec3[], pxPerMeter: number, width: number, height: number, cx = 0.5, cy = 0.5): number[][] {
  return world.map((p) => [cx + (p[0] * pxPerMeter) / width, cy + (p[1] * pxPerMeter) / height, p[2], 1])
}

export function frameOf(world: Vec3[], t = 0, pxPerMeter = 400, width = 1080, height = 1920): DenseFrame {
  return { t, world, image: imageOf(world, pxPerMeter, width, height) }
}

export function trackOf(frames: DenseFrame[], fps = 30, width = 1080, height = 1920): DenseTrack {
  return { fps, width, height, frameCount: frames.length, detectionRate: 1, frames }
}
