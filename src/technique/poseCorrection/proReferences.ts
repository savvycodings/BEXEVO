import { eq } from 'drizzle-orm'

/** Pose as written by the MediaPipe script: one entry per video frame. */
export type ProPose = {
  fps: number
  width: number
  height: number
  frames: Array<{ t: number; image: number[][] | null; world: number[][] | null }>
}

export type ProReferenceInput = {
  id: string
  strokePreset: string
  racketSide: 'LEFT' | 'RIGHT'
  sourceLabel?: string | null
  pose: ProPose
}

/** Median 2D shoulder width ÷ torso length over detected frames (~0.6+ front view, < 0.3 side view). */
export function facingRatioOfPose(pose: ProPose): number {
  const r: number[] = []
  for (const f of pose.frames) {
    const im = f.image
    if (!im) continue
    const px = (i: number) => [im[i]![0]! * pose.width, im[i]![1]! * pose.height] as const
    const [ls, rs, lh, rh] = [px(11), px(12), px(23), px(24)]
    const sw = Math.hypot(ls[0] - rs[0], ls[1] - rs[1])
    const th = Math.hypot((ls[0] + rs[0] - lh[0] - rh[0]) / 2, (ls[1] + rs[1] - lh[1] - rh[1]) / 2)
    if (th > 0) r.push(sw / th)
  }
  r.sort((a, b) => a - b)
  return r[Math.floor(r.length / 2)] ?? 0
}

/** Insert or update one pro reference row (id is stable). */
export async function upsertProReference(input: ProReferenceInput): Promise<{ id: string; facingRatio: number }> {
  const { db } = await import('../../db')
  const { proReference } = await import('../../db/schema')
  const facingRatio = facingRatioOfPose(input.pose)
  const values = {
    id: input.id,
    strokePreset: input.strokePreset,
    racketSide: input.racketSide,
    facingRatio,
    fps: input.pose.fps,
    width: input.pose.width,
    height: input.pose.height,
    pose: input.pose,
    sourceLabel: input.sourceLabel ?? null,
    updatedAt: new Date(),
  }
  const existing = await db.select({ id: proReference.id }).from(proReference).where(eq(proReference.id, input.id)).limit(1)
  if (existing[0]) await db.update(proReference).set(values).where(eq(proReference.id, input.id))
  else await db.insert(proReference).values(values)
  return { id: input.id, facingRatio }
}
