import type { StrokeInfo } from './types'

/** Provider minimum (and cheapest) frame count. */
export const NUM_FRAMES = 81
const MAX_FPS = 30
const MIN_FPS = 16
const PAD_S = 0.3

export type GenWindow = {
  start: number
  end: number
  /** Output fps so `NUM_FRAMES` frames play back at real speed. */
  fps: number
  numFrames: number
  /** Player-clip times of the frames sent to the provider. */
  times: number[]
  /** Seconds the provider bills (frames ÷ 16). */
  billedSeconds: number
}

export class WindowError extends Error {}

/**
 * Generation window: the stroke ±0.3 s, widened around contact to at least 81/30 s, clamped to
 * the clip. A window longer than `maxSeconds` is an error (spec: no provider call over the cap).
 */
export function planWindow(stroke: StrokeInfo, clipDuration: number, maxSeconds: number, requested?: { start: number; end: number }): GenWindow {
  let start: number
  let end: number
  if (requested) {
    start = requested.start
    end = requested.end
    if (!(end > start)) throw new WindowError('The window end must be after its start.')
    if (start < 0 || end > clipDuration + 1e-6) throw new WindowError('The window must lie inside the clip.')
  } else {
    start = stroke.startT - PAD_S
    end = stroke.endT + PAD_S
    const minLen = NUM_FRAMES / MAX_FPS
    if (end - start < minLen) {
      const c = stroke.contactT
      start = c - minLen / 2
      end = c + minLen / 2
    }
    // shift into the clip, then clamp
    if (start < 0) {
      end -= start
      start = 0
    }
    if (end > clipDuration) {
      start -= end - clipDuration
      end = clipDuration
    }
    start = Math.max(0, start)
  }
  const span = end - start
  if (span > maxSeconds + 1e-6) {
    throw new WindowError(`The window is ${span.toFixed(1)} s; the limit is ${maxSeconds} s.`)
  }
  const fps = Math.min(MAX_FPS, Math.max(MIN_FPS, Math.round(NUM_FRAMES / span)))
  const times = Array.from({ length: NUM_FRAMES }, (_, i) => start + (span * i) / (NUM_FRAMES - 1))
  return { start, end, fps, numFrames: NUM_FRAMES, times, billedSeconds: NUM_FRAMES / 16 }
}

export function estimateCost(billedSeconds: number, pricePerSecond: number): number {
  return Math.round(billedSeconds * pricePerSecond * 1000) / 1000
}
