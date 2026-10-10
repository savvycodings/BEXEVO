import type { Vec3 } from './types'

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s]
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
export const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2])
export const mid = (a: Vec3, b: Vec3): Vec3 => scale(add(a, b), 0.5)
export const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => add(a, scale(sub(b, a), t))

export function norm(a: Vec3): Vec3 {
  const l = len(a)
  return l > 1e-9 ? scale(a, 1 / l) : [0, 0, 0]
}

export const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))
export const deg = (rad: number): number => (rad * 180) / Math.PI
export const rad = (d: number): number => (d * Math.PI) / 180

/** Interior angle at `b` between b→a and b→c, degrees (180 = straight). */
export function angleAt(a: Vec3, b: Vec3, c: Vec3): number {
  const u = norm(sub(a, b))
  const v = norm(sub(c, b))
  return deg(Math.acos(clamp(dot(u, v), -1, 1)))
}

export function angleBetween(u: Vec3, v: Vec3): number {
  return deg(Math.acos(clamp(dot(norm(u), norm(v)), -1, 1)))
}

/** Wrap an angle in radians to (-π, π]. */
export function wrapPi(a: number): number {
  let x = a
  while (x <= -Math.PI) x += 2 * Math.PI
  while (x > Math.PI) x -= 2 * Math.PI
  return x
}

/** Orthonormal frame with `polar` as e3 and `ref` (made orthogonal to it) as e1. */
export type Frame = { e1: Vec3; e2: Vec3; e3: Vec3 }

export function frameOf(polar: Vec3, ref: Vec3): Frame {
  const e3 = norm(polar)
  let r = sub(ref, scale(e3, dot(ref, e3)))
  if (len(r) < 1e-6) {
    // ref parallel to polar: pick any perpendicular axis
    r = Math.abs(e3[0]) < 0.9 ? cross(e3, [1, 0, 0]) : cross(e3, [0, 1, 0])
  }
  const e1 = norm(r)
  const e2 = cross(e3, e1)
  return { e1, e2, e3 }
}

/** Unit direction → (polar angle θ from e3, azimuth φ around e3 from e1), radians. */
export function toSpherical(v: Vec3, f: Frame): { theta: number; phi: number } {
  const u = norm(v)
  const theta = Math.acos(clamp(dot(u, f.e3), -1, 1))
  const phi = Math.atan2(dot(u, f.e2), dot(u, f.e1))
  return { theta, phi }
}

export function fromSpherical(theta: number, phi: number, f: Frame): Vec3 {
  const s = Math.sin(theta)
  return add(scale(f.e3, Math.cos(theta)), add(scale(f.e1, s * Math.cos(phi)), scale(f.e2, s * Math.sin(phi))))
}
