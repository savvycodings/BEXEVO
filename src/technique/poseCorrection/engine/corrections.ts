import { LM, sideIdx, otherSide } from './landmarks'
import type { Correction, DenseFrame, Phase, Region, Side, Strengths, StrokeInfo, Vec3 } from './types'
import { angleAt, angleBetween, deg, mid, sub, wrapPi } from './vec'

type JointAngle = { region: Region; joint: string; kind: 'bend' | 'other'; value: (w: Vec3[]) => number }

function jointAngles(racket: Side): JointAngle[] {
  const r = sideIdx(racket)
  const f = sideIdx(otherSide(racket))
  const midHip = (w: Vec3[]) => mid(w[LM.LEFT_HIP]!, w[LM.RIGHT_HIP]!)
  const midSh = (w: Vec3[]) => mid(w[LM.LEFT_SHOULDER]!, w[LM.RIGHT_SHOULDER]!)
  const shoulderElev = (s: ReturnType<typeof sideIdx>) => (w: Vec3[]) =>
    angleBetween(sub(w[s.elbow]!, w[s.shoulder]!), sub(midHip(w), midSh(w)))
  const yaw = (a: Vec3, b: Vec3) => Math.atan2(b[2] - a[2], b[0] - a[0])
  return [
    { region: 'racketArm', joint: 'racket elbow', kind: 'bend', value: (w) => angleAt(w[r.shoulder]!, w[r.elbow]!, w[r.wrist]!) },
    { region: 'racketArm', joint: 'racket shoulder lift', kind: 'other', value: shoulderElev(r) },
    { region: 'freeArm', joint: 'free elbow', kind: 'bend', value: (w) => angleAt(w[f.shoulder]!, w[f.elbow]!, w[f.wrist]!) },
    { region: 'freeArm', joint: 'free shoulder lift', kind: 'other', value: shoulderElev(f) },
    { region: 'legs', joint: 'racket-side knee', kind: 'bend', value: (w) => angleAt(w[r.hip]!, w[r.knee]!, w[r.ankle]!) },
    { region: 'legs', joint: 'free-side knee', kind: 'bend', value: (w) => angleAt(w[f.hip]!, w[f.knee]!, w[f.ankle]!) },
    { region: 'trunk', joint: 'trunk lean', kind: 'other', value: (w) => angleBetween(sub(midSh(w), midHip(w)), [0, -1, 0]) },
    {
      region: 'trunk',
      joint: 'trunk rotation',
      kind: 'other',
      value: (w) => Math.abs(deg(wrapPi(
        yaw(w[LM.RIGHT_SHOULDER]!, w[LM.LEFT_SHOULDER]!) - yaw(w[LM.RIGHT_HIP]!, w[LM.LEFT_HIP]!),
      ))),
    },
  ]
}

const PHASE_LABEL: Record<Phase, string> = { preparation: 'preparation', contact: 'contact', followThrough: 'follow-through' }

function sentence(joint: string, kind: JointAngle['kind'], phase: Phase, p: number, r: number): string {
  const d = r - p
  const how =
    kind === 'bend'
      ? d > 0 ? `${Math.round(d)}° more bent than the pro` : `${Math.round(-d)}° straighter than the pro`
      : d > 0 ? `${Math.round(d)}° less than the pro` : `${Math.round(-d)}° more than the pro`
  const cap = joint[0]!.toUpperCase() + joint.slice(1)
  return `${cap} at ${PHASE_LABEL[phase]}: ${Math.round(p)}° vs pro ${Math.round(r)}° (${how}).`
}

/**
 * Differences of at least `minDeg` between player and aligned reference at the three phases,
 * largest first. `alignedRef[i]` is the reference pose paired with player frame i.
 */
export function listCorrections(
  player: DenseFrame[],
  alignedRef: DenseFrame[],
  stroke: StrokeInfo,
  minDeg: number,
): Correction[] {
  const phases: Array<[Phase, number]> = [
    ['preparation', stroke.startFrame],
    ['contact', stroke.contactFrame],
    ['followThrough', stroke.endFrame],
  ]
  const out: Correction[] = []
  for (const [phase, i] of phases) {
    for (const ja of jointAngles(stroke.racketSide)) {
      const p = ja.value(player[i]!.world)
      const r = ja.value(alignedRef[i]!.world)
      const d = r - p
      if (Math.abs(d) < minDeg) continue
      out.push({
        region: ja.region,
        phase,
        joint: ja.joint,
        playerDeg: Math.round(p * 10) / 10,
        refDeg: Math.round(r * 10) / 10,
        deltaDeg: Math.round(d * 10) / 10,
        sentence: sentence(ja.joint, ja.kind, phase, p, r),
      })
    }
  }
  return out.sort((a, b) => Math.abs(b.deltaDeg) - Math.abs(a.deltaDeg))
}

/**
 * Racket arm at 1 when it has a listed correction; every other region starts at 0. Copying a
 * different body's legs, trunk and free arm added most of the noise in the first live run.
 */
export function defaultStrengths(corrections: Correction[]): Strengths {
  return { racketArm: corrections.some((c) => c.region === 'racketArm') ? 1 : 0, freeArm: 0, trunk: 0, legs: 0 }
}
