import { LM, sideIdx } from './landmarks'
import type { Region, Side, Strengths, Vec3 } from './types'
import {
  add, clamp, frameOf, fromSpherical, len, mid, norm, scale, sub, toSpherical, wrapPi,
  type Frame,
} from './vec'

const UP: Vec3 = [0, -1, 0] // MediaPipe world y points down
const DOWN: Vec3 = [0, 1, 0]

/** A bone and how to build its parent frame from an (already corrected) pose. */
type Bone = {
  id: string
  region: (racket: Side) => Region
  /** Direction of the bone in `w`. */
  dir: (w: Vec3[]) => Vec3
  parent: (w: Vec3[]) => Frame
}

const midHip = (w: Vec3[]) => mid(w[LM.LEFT_HIP]!, w[LM.RIGHT_HIP]!)
const midShoulder = (w: Vec3[]) => mid(w[LM.LEFT_SHOULDER]!, w[LM.RIGHT_SHOULDER]!)
const hipAxis = (w: Vec3[]) => sub(w[LM.LEFT_HIP]!, w[LM.RIGHT_HIP]!)
const trunkDir = (w: Vec3[]) => sub(midShoulder(w), midHip(w))
const shoulderLine = (w: Vec3[]) => sub(w[LM.LEFT_SHOULDER]!, w[LM.RIGHT_SHOULDER]!)

function armBones(side: Side): Bone[] {
  const s = sideIdx(side)
  const region = (racket: Side): Region => (racket === side ? 'racketArm' : 'freeArm')
  return [
    {
      id: `${side}_upperArm`,
      region,
      dir: (w) => sub(w[s.elbow]!, w[s.shoulder]!),
      parent: (w) => frameOf(scale(trunkDir(w), -1), shoulderLine(w)),
    },
    {
      id: `${side}_forearm`,
      region,
      dir: (w) => sub(w[s.wrist]!, w[s.elbow]!),
      parent: (w) => frameOf(sub(w[s.elbow]!, w[s.shoulder]!), shoulderLine(w)),
    },
  ]
}

function legBones(side: Side): Bone[] {
  const s = sideIdx(side)
  const region = (): Region => 'legs'
  return [
    { id: `${side}_thigh`, region, dir: (w) => sub(w[s.knee]!, w[s.hip]!), parent: (w) => frameOf(DOWN, hipAxis(w)) },
    { id: `${side}_shin`, region, dir: (w) => sub(w[s.ankle]!, w[s.knee]!), parent: (w) => frameOf(sub(w[s.knee]!, w[s.hip]!), hipAxis(w)) },
  ]
}

/** Bones in forward-kinematics order: every parent frame only uses bones placed before it. */
const BONES: Bone[] = [
  { id: 'trunk', region: () => 'trunk', dir: trunkDir, parent: (w) => frameOf(UP, hipAxis(w)) },
  { id: 'shoulderLine', region: () => 'trunk', dir: shoulderLine, parent: (w) => frameOf(trunkDir(w), hipAxis(w)) },
  ...armBones('LEFT'),
  ...armBones('RIGHT'),
  ...legBones('LEFT'),
  ...legBones('RIGHT'),
]

/**
 * Blend one bone's direction: polar angle and azimuth (relative to its parent frame) move by
 * `s` of the way from the player's to the reference's. s outside [0, 1] extrapolates. For a hinge
 * (elbow, knee) this gives exactly angle' = angle + s·(ref − angle).
 */
function blendDir(playerDir: Vec3, playerParent: Frame, refDir: Vec3, refParent: Frame, s: number) {
  const p = toSpherical(playerDir, playerParent)
  const r = toSpherical(refDir, refParent)
  const theta = clamp(p.theta + s * (r.theta - p.theta), 0, Math.PI)
  let phi: number
  if (Math.sin(p.theta) < 0.1) phi = r.phi // player's azimuth undefined (bone along the axis)
  else if (Math.sin(r.theta) < 0.1) phi = p.phi
  else phi = p.phi + s * wrapPi(r.phi - p.phi)
  return { theta, phi }
}

/** Player limbs that ride on a corrected joint: [moving landmarks, anchor landmark]. */
function riders(): Array<[number[], number | 'neck']> {
  return [
    [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 'neck'],
    [[17, 19, 21], LM.LEFT_WRIST],
    [[18, 20, 22], LM.RIGHT_WRIST],
    [[29, 31], LM.LEFT_ANKLE],
    [[30, 32], LM.RIGHT_ANKLE],
  ]
}

/**
 * Correct one frame. `player` and `ref` are world poses (33 points); `ref` must already be mirrored
 * to the player's racket side. Only joint angles change: bone lengths, the pelvis and its position
 * are the player's own.
 */
export function correctFrame(player: Vec3[], ref: Vec3[], racketSide: Side, strengths: Strengths): Vec3[] {
  const out: Vec3[] = player.map((p) => [...p] as Vec3)
  const L = LM
  const length = (a: number, b: number) => len(sub(player[a]!, player[b]!))

  const place = (bone: Bone): Vec3 => {
    const s = strengths[bone.region(racketSide)] ?? 0
    const { theta, phi } = blendDir(bone.dir(player), bone.parent(player), bone.dir(ref), bone.parent(ref), s)
    return norm(fromSpherical(theta, phi, bone.parent(out)))
  }

  for (const bone of BONES) {
    const d = place(bone)
    switch (bone.id) {
      case 'trunk': {
        const hip = midHip(player)
        const msNew = add(hip, scale(d, len(trunkDir(player))))
        const delta = sub(msNew, midShoulder(player))
        out[L.LEFT_SHOULDER] = add(player[L.LEFT_SHOULDER]!, delta)
        out[L.RIGHT_SHOULDER] = add(player[L.RIGHT_SHOULDER]!, delta)
        break
      }
      case 'shoulderLine': {
        const ms = midShoulder(out)
        const half = len(shoulderLine(player)) / 2
        out[L.LEFT_SHOULDER] = add(ms, scale(d, half))
        out[L.RIGHT_SHOULDER] = sub(ms, scale(d, half))
        break
      }
      default: {
        const [sideName, part] = bone.id.split('_') as [Side, string]
        const s = sideIdx(sideName)
        const [from, to] =
          part === 'upperArm' ? [s.shoulder, s.elbow]
          : part === 'forearm' ? [s.elbow, s.wrist]
          : part === 'thigh' ? [s.hip, s.knee]
          : [s.knee, s.ankle]
        out[to] = add(out[from]!, scale(d, length(from, to)))
      }
    }
  }

  // Head, hands and feet follow the joint they hang from.
  const neckDelta = sub(midShoulder(out), midShoulder(player))
  for (const [idxs, anchor] of riders()) {
    const delta = anchor === 'neck' ? neckDelta : sub(out[anchor]!, player[anchor]!)
    for (const i of idxs) out[i] = add(player[i]!, delta)
  }
  return out
}

/** Smooth 0→1 ramp over `rampS` seconds from the window start, so frame 0 matches the real frame. */
export function easeIn(t: number, windowStart: number, rampS = 0.3): number {
  const x = clamp((t - windowStart) / rampS, 0, 1)
  return x * x * (3 - 2 * x)
}

export function scaleStrengths(s: Strengths, k: number): Strengths {
  return { racketArm: s.racketArm * k, freeArm: s.freeArm * k, trunk: s.trunk * k, legs: s.legs * k }
}

