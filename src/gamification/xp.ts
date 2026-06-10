import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { db, userGamification, xpEvent } from "../db";
import { levelFromXp } from "./definitions";

export async function ensureUserGamification(userId: string) {
  const existing = await db.query.userGamification.findFirst({
    where: (g, { eq: _eq }) => _eq(g.userId, userId),
  });
  if (existing) return existing;

  const now = new Date();
  const [row] = await db
    .insert(userGamification)
    .values({
      userId,
      totalXp: 0,
      loginStreak: 0,
      lastLevel: 1,
      dayStartLevel: 1,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning();

  if (row) return row;

  return (
    (await db.query.userGamification.findFirst({
      where: (g, { eq: _eq }) => _eq(g.userId, userId),
    })) ?? {
      userId,
      totalXp: 0,
      loginStreak: 0,
      lastLoginDate: null,
      lastLevel: 1,
      dayStartDate: null,
      dayStartLevel: 1,
      updatedAt: now,
    }
  );
}

/** Award XP once per (`source`, `sourceRef`). Returns new total or null if duplicate. */
export async function awardXp(
  userId: string,
  amount: number,
  source: string,
  sourceRef: string
): Promise<{ totalXp: number; level: number; awarded: boolean }> {
  if (!Number.isFinite(amount) || amount <= 0) {
    const g = await ensureUserGamification(userId);
    const { level } = levelFromXp(g.totalXp);
    return { totalXp: g.totalXp, level, awarded: false };
  }

  await ensureUserGamification(userId);

  const inserted = await db
    .insert(xpEvent)
    .values({
      id: randomUUID(),
      userId,
      amount: Math.floor(amount),
      source,
      sourceRef,
    })
    .onConflictDoNothing()
    .returning({ id: xpEvent.id });

  if (inserted.length === 0) {
    const g = await ensureUserGamification(userId);
    const { level } = levelFromXp(g.totalXp);
    return { totalXp: g.totalXp, level, awarded: false };
  }

  const g = await ensureUserGamification(userId);
  const newTotal = g.totalXp + Math.floor(amount);
  const { level } = levelFromXp(newTotal);
  const now = new Date();

  await db
    .update(userGamification)
    .set({ totalXp: newTotal, lastLevel: level, updatedAt: now })
    .where(eq(userGamification.userId, userId));

  return { totalXp: newTotal, level, awarded: true };
}
