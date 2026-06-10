import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import { db, userAchievement, userDailyQuest, userGamification } from "../db";
import { evaluateNewAchievements, unlockAchievements } from "./achievements";
import {
  CLIENT_TRACKABLE_QUEST_KEYS,
  getQuestDef,
  levelFromXp,
  pickDailyQuestKeysForDate,
  isQuestActiveInPeriod,
  periodKeyForCadence,
} from "./definitions";
import { syncAllQuestRows, type QuestProgress } from "./dailyQuests";
import type { QuestCadence } from "./questPeriods";
import {
  loadUserGamificationStats,
  localDateKey,
  type UserGamificationStats,
} from "./stats";
import { awardXp, ensureUserGamification } from "./xp";

export type GamificationState = {
  totalXp: number;
  level: number;
  xpInLevel: number;
  xpGoal: number;
  tier: string;
  loginStreak: number;
  achievements: { key: string; unlockedAt: string; claimedAt: string }[];
  claimableAchievements: { key: string; earnedAt: string }[];
  dailyQuests: QuestProgress[];
  weeklyQuests: QuestProgress[];
  seasonQuests: QuestProgress[];
  dateKey: string;
  weeklyPeriodKey: string;
  seasonPeriodKey: string;
  newlyEarnedAchievements: string[];
};

function addDays(dateKey: string, delta: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + delta);
  return localDateKey(dt);
}

async function recordDailyLogin(userId: string, dateKey: string): Promise<number> {
  const g = await ensureUserGamification(userId);
  const now = new Date();
  let loginStreak = g.loginStreak;

  if (g.lastLoginDate === dateKey) {
    loginStreak = g.loginStreak;
  } else if (g.lastLoginDate === addDays(dateKey, -1)) {
    loginStreak = g.loginStreak + 1;
  } else {
    loginStreak = 1;
  }

  const { level } = levelFromXp(g.totalXp);
  const dayStartPatch =
    g.dayStartDate === dateKey
      ? {}
      : { dayStartDate: dateKey, dayStartLevel: level };

  await db
    .update(userGamification)
    .set({
      loginStreak,
      lastLoginDate: dateKey,
      lastLevel: level,
      updatedAt: now,
      ...dayStartPatch,
    })
    .where(eq(userGamification.userId, userId));

  return loginStreak;
}

async function loadClientTrackedToday(
  userId: string,
  dateKey: string
): Promise<Set<string>> {
  const rows = await db.query.userDailyQuest.findMany({
    where: (q, { and: _and, eq: _eq }) =>
      _and(_eq(q.userId, userId), _eq(q.dateKey, dateKey)),
  });
  const tracked = new Set<string>();
  for (const row of rows) {
    if (
      CLIENT_TRACKABLE_QUEST_KEYS.has(row.questKey) &&
      row.progress >= row.goal
    ) {
      tracked.add(row.questKey);
    }
  }
  return tracked;
}

async function runAchievementPass(
  userId: string,
  stats: UserGamificationStats
): Promise<string[]> {
  let currentStats = stats;
  const allNew: string[] = [];

  for (let pass = 0; pass < 3; pass++) {
    const candidates = evaluateNewAchievements(currentStats);
    if (candidates.length === 0) break;

    const unlocked = await unlockAchievements(userId, candidates);
    allNew.push(...unlocked);

    for (const key of unlocked) {
      currentStats.earnedKeys.add(key);
    }
  }

  return allNew;
}

export async function refreshGamification(
  userId: string,
  dateKey: string = localDateKey()
): Promise<GamificationState> {
  const loginStreak = await recordDailyLogin(userId, dateKey);
  const clientTrackedToday = await loadClientTrackedToday(userId, dateKey);

  let stats = await loadUserGamificationStats(userId, {
    loginStreak,
    todayKey: dateKey,
    clientTrackedToday,
  });

  const newlyEarnedAchievements = await runAchievementPass(userId, stats);

  if (newlyEarnedAchievements.length > 0) {
    stats = await loadUserGamificationStats(userId, {
      loginStreak,
      todayKey: dateKey,
      clientTrackedToday,
    });
  }

  const { dailyQuests, weeklyQuests, seasonQuests } = await syncAllQuestRows(
    userId,
    dateKey,
    stats
  );
  const g = await ensureUserGamification(userId);
  const { level, xpInLevel, xpGoal, tier, totalXp } = levelFromXp(g.totalXp);

  const achievementRows = await db.query.userAchievement.findMany({
    where: (a, { eq: _eq }) => _eq(a.userId, userId),
    orderBy: (a, { desc: _desc }) => [_desc(a.unlockedAt)],
  });

  const claimedRows = achievementRows.filter((a) => a.claimedAt != null);
  const claimableRows = achievementRows.filter((a) => a.claimedAt == null);

  return {
    totalXp,
    level,
    xpInLevel,
    xpGoal,
    tier,
    loginStreak: g.loginStreak,
    achievements: claimedRows.map((a) => ({
      key: a.achievementKey,
      unlockedAt: a.unlockedAt.toISOString(),
      claimedAt: a.claimedAt!.toISOString(),
    })),
    claimableAchievements: claimableRows.map((a) => ({
      key: a.achievementKey,
      earnedAt: a.unlockedAt.toISOString(),
    })),
    dailyQuests,
    weeklyQuests,
    seasonQuests,
    dateKey,
    weeklyPeriodKey: periodKeyForCadence("weekly"),
    seasonPeriodKey: periodKeyForCadence("season"),
    newlyEarnedAchievements,
  };
}

export async function getGamificationState(
  userId: string,
  dateKey?: string
): Promise<GamificationState> {
  return refreshGamification(userId, dateKey ?? localDateKey());
}

export async function onVideoUploaded(userId: string): Promise<void> {
  await refreshGamification(userId);
}

export async function onAnalysisCompleted(userId: string): Promise<void> {
  await refreshGamification(userId);
}

export async function onCoachReviewCompleted(studentUserId: string): Promise<void> {
  await refreshGamification(studentUserId);
}

export async function onFriendLinked(userId: string): Promise<void> {
  await refreshGamification(userId);
}

export async function trackClientQuest(
  userId: string,
  questKey: string,
  dateKey: string = localDateKey()
): Promise<GamificationState | null> {
  if (!CLIENT_TRACKABLE_QUEST_KEYS.has(questKey)) return null;
  if (!pickDailyQuestKeysForDate(dateKey).includes(questKey)) return null;

  const def = getQuestDef(questKey);
  if (!def || def.cadence !== "daily") return null;

  const now = new Date();
  const existing = await db.query.userDailyQuest.findFirst({
    where: (q, { and: _and, eq: _eq }) =>
      _and(
        _eq(q.userId, userId),
        _eq(q.dateKey, dateKey),
        _eq(q.questKey, questKey)
      ),
  });

  if (existing) {
    await db
      .update(userDailyQuest)
      .set({ progress: def.goal, updatedAt: now })
      .where(eq(userDailyQuest.id, existing.id));
  } else {
    await db.insert(userDailyQuest).values({
      id: randomUUID(),
      userId,
      dateKey,
      questKey,
      progress: def.goal,
      goal: def.goal,
      updatedAt: now,
    });
  }

  return refreshGamification(userId, dateKey);
}

export async function claimDailyQuest(
  userId: string,
  questKey: string,
  opts: {
    cadence?: QuestCadence;
    periodKey?: string;
    dateKey?: string;
  } = {}
): Promise<
  | { ok: true; state: GamificationState; xpAwarded: number }
  | { ok: false; error: string }
> {
  const def = getQuestDef(questKey);
  if (!def) return { ok: false, error: "Unknown quest" };

  const cadence = opts.cadence ?? def.cadence;
  const todayKey = opts.dateKey ?? localDateKey();
  const periodKey =
    opts.periodKey ??
    (cadence === "daily" ? todayKey : periodKeyForCadence(cadence));

  if (!isQuestActiveInPeriod(questKey, cadence, periodKey)) {
    return { ok: false, error: "Quest is not active for this period" };
  }

  await refreshGamification(userId, todayKey);

  const row = await db.query.userDailyQuest.findFirst({
    where: (q, { and: _and, eq: _eq }) =>
      _and(
        _eq(q.userId, userId),
        _eq(q.dateKey, periodKey),
        _eq(q.questKey, questKey)
      ),
  });

  if (!row) return { ok: false, error: "Quest not found" };
  if (row.claimedAt) return { ok: false, error: "Quest already claimed" };
  if (row.progress < row.goal) {
    return { ok: false, error: "Quest not complete yet" };
  }

  const now = new Date();
  await db
    .update(userDailyQuest)
    .set({ claimedAt: now, updatedAt: now })
    .where(eq(userDailyQuest.id, row.id));

  const xpResult = await awardXp(
    userId,
    def.xp,
    `${cadence}_quest`,
    `${periodKey}:${questKey}`
  );

  const state = await refreshGamification(userId, todayKey);
  return { ok: true, state, xpAwarded: xpResult.awarded ? def.xp : 0 };
}

export async function claimAchievement(
  userId: string,
  achievementKey: string
): Promise<
  | { ok: true; state: GamificationState }
  | { ok: false; error: string }
> {
  const key = achievementKey.trim();
  if (!key) return { ok: false, error: "Missing achievement key" };

  await refreshGamification(userId);

  const row = await db.query.userAchievement.findFirst({
    where: (a, { and: _and, eq: _eq }) =>
      _and(_eq(a.userId, userId), _eq(a.achievementKey, key)),
  });

  if (!row) return { ok: false, error: "Achievement not earned yet" };
  if (row.claimedAt) return { ok: false, error: "Achievement already claimed" };

  const now = new Date();
  await db
    .update(userAchievement)
    .set({ claimedAt: now })
    .where(
      and(
        eq(userAchievement.userId, userId),
        eq(userAchievement.achievementKey, key)
      )
    );

  const state = await refreshGamification(userId);
  return { ok: true, state };
}
