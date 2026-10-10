/**
 * E2E seed accounts (fakes mode only): a player, a coach linked to that player, and an admin.
 * The admin hub is password-gated (ADMIN_HUB_GATE_PASSWORD), so "admin" is a normal account that
 * the tests pair with the gate password. Idempotent: re-running creates nothing new.
 */
import { randomUUID } from 'crypto'
import { and, eq } from 'drizzle-orm'

export const E2E_PASSWORD = 'E2E-test-password-1!'
export const E2E_ACCOUNTS = {
  player: { email: 'e2e-player@xevo.test', name: 'E2E Player', username: 'e2e_player', role: 'student' },
  coach: { email: 'e2e-coach@xevo.test', name: 'E2E Coach', username: 'e2e_coach', role: 'coach' },
  admin: { email: 'e2e-admin@xevo.test', name: 'E2E Admin', username: 'e2e_admin', role: 'none' },
} as const

/** Profile fields the app's setup steps ask for, so seeded accounts land on the home tabs. */
const COMPLETE_PROFILE = {
  dominantHand: 'right',
  courtSide: 'right',
  heightCm: 180,
  weightKg: 75,
  hasRanking: false,
  level: 'intermediate',
  gender: 'male',
}

export const E2E_NOTIFICATION_TITLE = 'E2E welcome notification'

export type SeedResult = Record<keyof typeof E2E_ACCOUNTS, { id: string; email: string; created: boolean }>

export async function seedE2eAccounts(): Promise<SeedResult> {
  const { auth } = await import('../auth')
  const { db } = await import('../db')
  const { user, userProfile, coachStudent, userNotification, userGamification } = await import('../db/schema')

  const out = {} as SeedResult
  for (const [key, acct] of Object.entries(E2E_ACCOUNTS) as Array<[keyof typeof E2E_ACCOUNTS, (typeof E2E_ACCOUNTS)[keyof typeof E2E_ACCOUNTS]]>) {
    let row = (await db.select().from(user).where(eq(user.email, acct.email)).limit(1))[0]
    let created = false
    if (!row) {
      await auth.api.signUpEmail({ body: { email: acct.email, password: E2E_PASSWORD, name: acct.name } })
      row = (await db.select().from(user).where(eq(user.email, acct.email)).limit(1))[0]
      created = true
    }
    if (!row) throw new Error(`seed: could not create ${acct.email}`)
    await db.update(user).set({ emailVerified: true }).where(eq(user.id, row.id))
    await db
      .insert(userProfile)
      .values({ userId: row.id, username: acct.username, ...COMPLETE_PROFILE, coachStudentRole: acct.role })
      .onConflictDoUpdate({ target: userProfile.userId, set: { username: acct.username, ...COMPLETE_PROFILE, coachStudentRole: acct.role } })
    out[key] = { id: row.id, email: acct.email, created }
  }

  const link = await db
    .select()
    .from(coachStudent)
    .where(and(eq(coachStudent.coachUserId, out.coach.id), eq(coachStudent.studentUserId, out.player.id)))
    .limit(1)
  if (!link[0]) {
    await db.insert(coachStudent).values({ id: randomUUID(), coachUserId: out.coach.id, studentUserId: out.player.id })
  }
  // Some XP for the player, so the leaderboard (totalXp > 0) lists them. Never lowers real XP.
  const g = await db.select().from(userGamification).where(eq(userGamification.userId, out.player.id)).limit(1)
  if (!g[0]) await db.insert(userGamification).values({ userId: out.player.id, totalXp: 120 })
  else if (g[0].totalXp <= 0) await db.update(userGamification).set({ totalXp: 120 }).where(eq(userGamification.userId, out.player.id))

  // One known notification for the player, so the notifications screen has something to show.
  const noti = await db
    .select()
    .from(userNotification)
    .where(and(eq(userNotification.userId, out.player.id), eq(userNotification.kind, 'e2e_welcome')))
    .limit(1)
  if (!noti[0]) {
    await db.insert(userNotification).values({
      id: randomUUID(),
      userId: out.player.id,
      kind: 'e2e_welcome',
      title: E2E_NOTIFICATION_TITLE,
      body: 'Seeded by the e2e setup.',
    })
  }
  // The pro reference used by the pose-correction Magic Shot video (front-view forehand volley).
  const { upsertProReference } = await import('../technique/poseCorrection/proReferences')
  const { readJsonFixture } = await import('./fakes')
  const pro = readJsonFixture<any>('pro-fh-volley-front-42cf0eba.json')
  await upsertProReference({ id: pro.id, strokePreset: pro.strokePreset, racketSide: pro.racketSide, sourceLabel: pro.sourceLabel, pose: pro.pose })

  return out
}
