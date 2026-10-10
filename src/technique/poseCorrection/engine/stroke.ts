import { LM, sampleTrack } from './landmarks'
import type { DenseFrame, DenseTrack, Side, StrokeInfo } from './types'

/** Wrist speed per frame in pixels/second (image coords scaled by the true frame size). */
export function wristSpeeds(track: DenseTrack, wrist: number): number[] {
  const { width, height, fps } = track
  const f = track.frames
  return f.map((_, i) => {
    const a = f[Math.max(0, i - 1)]!.image[wrist]!
    const b = f[Math.min(f.length - 1, i + 1)]!.image[wrist]!
    const span = Math.min(f.length - 1, i + 1) - Math.max(0, i - 1)
    if (!span) return 0
    return (Math.hypot((b[0]! - a[0]!) * width, (b[1]! - a[1]!) * height) * fps) / span
  })
}

export type StrokeOverrides = { contactT?: number; racketSide?: Side }

/**
 * Racket side = the wrist with the higher peak speed. Contact = that wrist's peak-speed frame
 * (or the override). Start/end = where its speed falls below 10% of the peak around contact;
 * 20% cut the backswing off at the short pause before the swing.
 */
export function detectStroke(track: DenseTrack, overrides: StrokeOverrides = {}): StrokeInfo {
  const left = wristSpeeds(track, LM.LEFT_WRIST)
  const right = wristSpeeds(track, LM.RIGHT_WRIST)
  // Fastest wrist can be the free hand coming off the racket, so callers may override.
  const racketSide: Side = overrides.racketSide ?? (Math.max(...right) >= Math.max(...left) ? 'RIGHT' : 'LEFT')
  const speed = racketSide === 'RIGHT' ? right : left
  const n = speed.length

  let contactFrame = speed.indexOf(Math.max(...speed))
  if (overrides.contactT != null) {
    contactFrame = Math.min(n - 1, Math.max(0, Math.round(overrides.contactT * track.fps)))
  }
  const peak = Math.max(...speed)
  const floor = peak * 0.1
  let startFrame = contactFrame
  while (startFrame > 0 && speed[startFrame - 1]! >= floor) startFrame--
  let endFrame = contactFrame
  while (endFrame < n - 1 && speed[endFrame + 1]! >= floor) endFrame++

  const t = (i: number) => track.frames[i]!.t
  return {
    racketSide,
    startFrame,
    contactFrame,
    endFrame,
    startT: t(startFrame),
    contactT: t(contactFrame),
    endT: t(endFrame),
  }
}

/**
 * Piecewise-linear time warp: player [start→contact] maps onto reference [start→contact] and
 * [contact→end] onto [contact→end]; outside the stroke the nearer segment's rate continues.
 * Returns the reference's fractional frame index for a player time.
 */
export function warpTime(playerT: number, player: StrokeInfo, ref: StrokeInfo, refFps: number): number {
  const seg = (t: number, a0: number, a1: number, b0: number, b1: number) =>
    a1 - a0 > 1e-6 ? b0 + ((t - a0) * (b1 - b0)) / (a1 - a0) : b0 + (t - a0)
  const refT =
    playerT <= player.contactT
      ? seg(playerT, player.startT, player.contactT, ref.startT, ref.contactT)
      : seg(playerT, player.contactT, player.endT, ref.contactT, ref.endT)
  return refT * refFps
}

/** The reference pose aligned to each player frame. */
export function alignReference(player: DenseTrack, playerStroke: StrokeInfo, ref: DenseTrack, refStroke: StrokeInfo): DenseFrame[] {
  return player.frames.map((f) => sampleTrack(ref, warpTime(f.t, playerStroke, refStroke, ref.fps)))
}
