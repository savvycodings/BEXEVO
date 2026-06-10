import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import {

  getQuestDef,
  pickDailyQuestKeysForDate,
  pickQuestKeysForPeriod,
  pickSeasonQuestKeysForPeriod,
  pickWeeklyQuestKeysForPeriod,

} from "./definitions";
import type { QuestCadence } from "./questPeriods";
import {

  cadenceFromPeriodKey,
  periodBounds,
  periodKeyForCadence,

} from "./questPeriods";
import type { AnalysisSnapshot, UserGamificationStats } from "./stats";
import { countClaimsBeforeMidday, localDateKey } from "./stats";
import { db, userDailyQuest, xpEvent } from "../db";
import { sql } from "drizzle-orm";

export type QuestProgress = {

  questKey: string;
  progress: number;
  goal: number;
  xp: number;
  claimed: boolean;
  cadence: QuestCadence;
  periodKey: string;

};

function isSRank(rating: string | null, score: number | null): boolean {

  if (rating && /^s/i.test(rating.trim())) return true;
  return score != null && score >= 90;

}

function analysisMatchesStroke(
  strokeLabel: string | null,
  needles: string[]
): boolean {

  if (!strokeLabel) return false;
  return needles.some((n) => strokeLabel.includes(n));

}

function analysesInPeriod(
  stats: UserGamificationStats,
  periodKey: string
): AnalysisSnapshot[] {

  const { start, end } = periodBounds(periodKey);
  return stats.analyses.filter((a) => a.dateKey >= start && a.dateKey <= end);

}

function uploadCountInPeriod(
  stats: UserGamificationStats,
  periodKey: string
): number {

  const { start, end } = periodBounds(periodKey);
  let count = 0;
  for (const dk of stats.uploadDateKeys) {

    if (dk >= start && dk <= end) count += 1;

  }
  return count;

}

function maxScoreInPeriod(
  stats: UserGamificationStats,
  periodKey: string
): number | null {

  let max: number | null = null;
  for (const a of analysesInPeriod(stats, periodKey)) {

    if (a.score != null) {

      max = max == null ? a.score : Math.max(max, a.score);

    }

  }
  return max;

}

function volleyCountInPeriod(
  stats: UserGamificationStats,
  periodKey: string
): number {

  let count = 0;
  for (const a of analysesInPeriod(stats, periodKey)) {

    const stroke = a.strokeLabel ?? "";
    const isVolley =
      a.category === "net_play" ||
      (stroke.includes("volley") && !stroke.includes("half"));
    if (isVolley) count += 1;

  }
  return count;

}

function maxUploadStreakInPeriod(
  stats: UserGamificationStats,
  periodKey: string
): number {

  const { start, end } = periodBounds(periodKey);
  const keys = Array.from(stats.uploadDateKeys).filter(
    (dk) => dk >= start && dk <= end
  );
  if (keys.length === 0) return 0;

  const sorted = keys.sort();
  let best = 1;
  let run = 1;
  for (let i = 1; i < sorted.length; i++) {

    const [y, m, d] = sorted[i - 1].split("-").map(Number);
    const prev = new Date(y, m - 1, d);
    prev.setDate(prev.getDate() + 1);
    const expected = localDateKey(prev);
    if (sorted[i] === expected) {

      run += 1;
      best = Math.max(best, run);

    } else {

      run = 1;

    }

  }
  return best;

}

function scopedAnalyses(
  stats: UserGamificationStats,
  cadence: QuestCadence,
  periodKey: string,
  todayKey: string
): AnalysisSnapshot[] {

  if (cadence === "daily") {

    return stats.todayAnalyses;

  }
  return analysesInPeriod(stats, periodKey);

}

export async function computeQuestProgress(
  questKey: string,
  stats: UserGamificationStats,
  periodKey: string,
  userId: string,
  todayKey: string
): Promise<number> {

  const def = getQuestDef(questKey);
  if (!def) return 0;

  const cadence = def.cadence;
  const periodAnalyses = scopedAnalyses(stats, cadence, periodKey, todayKey);

  if (cadence === "daily" && stats.clientTrackedToday.has(questKey)) {

    return def.goal;

  }

  switch (questKey) {

    case "login-to-app":
    case "first-login-of-day":
      return cadence === "daily" && stats.loginStreak > 0 ? 1 : 0;

    case "complete-an-upload":
    case "upload-a-full-video":
      if (cadence === "daily") return stats.todayUploadCount > 0 ? 1 : 0;
      return uploadCountInPeriod(stats, periodKey) > 0 ? 1 : 0;

    case "complete-1-ai-analysis":
      return periodAnalyses.length > 0 ? 1 : 0;

    case "upload-analyze-full-video":
      if (cadence === "daily") {

        return stats.todayUploadCount > 0 && stats.todayAnalyses.length > 0
          ? 1
          : 0;

      }
      return uploadCountInPeriod(stats, periodKey) > 0 &&
        periodAnalyses.length > 0
        ? 1
        : 0;

    case "get-over-70-score":
      return periodAnalyses.some((a) => (a.score ?? 0) >= 70) ? 1 : 0;

    case "get-ai-score-above-80":
      return periodAnalyses.some((a) => (a.score ?? 0) >= 80) ? 1 : 0;

    case "achieve-s-rank-ai":
      return periodAnalyses.some((a) => isSRank(a.rating, a.score)) ? 1 : 0;

    case "get-80-above-smashes":
      return periodAnalyses.some((a) => {

        const stroke = a.strokeLabel ?? "";
        const isSmash =
          a.category === "overhead" ||
          stroke.includes("smash") ||
          stroke.includes("overhead");
        return isSmash && (a.score ?? 0) >= 80;

      })
        ? 1
        : 0;

    case "score-above-60-serves":
      return periodAnalyses.some(
        (a) =>
          (a.category === "save_return" ||
            analysisMatchesStroke(a.strokeLabel, ["serve", "return"])) &&
          (a.score ?? 0) >= 60
      )
        ? 1
        : 0;

    case "upload-1-backhand":
      return periodAnalyses.some((a) =>
        analysisMatchesStroke(a.strokeLabel, ["backhand"])
      )
        ? 1
        : 0;

    case "upload-3-volley-shots":
      return Math.min(def.goal, volleyCountInPeriod(stats, periodKey));

    case "get-perfect-volleys":
      return periodAnalyses.some(
        (a) =>
          (a.category === "net_play" ||
            analysisMatchesStroke(a.strokeLabel, ["volley"])) &&
          (a.score ?? 0) >= 90
      )
        ? 1
        : 0;

    case "hit-perfect-bandejas":
      return periodAnalyses.some(
        (a) =>
          analysisMatchesStroke(a.strokeLabel, ["bandeja"]) &&
          (a.score ?? 0) >= 90
      )
        ? 1
        : 0;

    case "improve-ai-score-yesterday":
      return stats.todayMaxScore != null &&
        stats.yesterdayMaxScore != null &&
        stats.todayMaxScore > stats.yesterdayMaxScore
        ? 1
        : 0;

    case "improve-shot-accuracy-15":
      return periodAnalyses.some((a) => {

        if (a.score == null || !a.strokeLabel) return false;
        const prior = stats.analyses
          .filter(
            (x) =>
              x.strokeLabel === a.strokeLabel &&
              x.id !== a.id &&
              x.createdAt < a.createdAt
          )
          .map((x) => x.score)
          .filter((s): s is number => s != null);
        if (prior.length === 0) return false;
        const bestPrior = Math.max(...prior);
        return a.score - bestPrior >= 15;

      })
        ? 1
        : 0;

    case "get-streak-50-points":
      return Math.min(
        def.goal,
        periodAnalyses.filter((a) => (a.score ?? 0) >= 50).length
      );

    case "maintain-5-day-streak":
      return Math.min(def.goal, stats.loginStreak);

    case "maintain-7-day-streak":
    case "complete-perfect-week":
      return Math.min(def.goal, stats.loginStreak);

    case "upload-3-consecutive-days":
      return Math.min(def.goal, maxUploadStreakInPeriod(stats, periodKey));

    case "invite-a-friend": {
      if (cadence === "daily") return stats.friendLinkToday ? 1 : 0;
      const { start, end } = periodBounds(periodKey);
      for (const dk of stats.friendLinkDateKeys) {
        if (dk >= start && dk <= end) return 1;
      }
      return 0;
    }

    case "complete-3-before-midday": {
      if (cadence !== "daily") return 0;
      const n = await countClaimsBeforeMidday(userId, periodKey);
      return Math.min(def.goal, n);
    }

    case "complete-3-daily-quests":
    case "complete-all-daily-quests": {

      if (cadence === "daily" && questKey === "complete-3-daily-quests") {
        const rows = await db.query.userDailyQuest.findMany({
          where: (q, { and: _and, eq: _eq }) =>
            _and(_eq(q.userId, userId), _eq(q.dateKey, todayKey)),
        });
        const claimed = rows.filter((r) => r.claimedAt != null).length;
        return Math.min(def.goal, claimed);
      }

      if (cadence === "weekly" && questKey === "complete-all-daily-quests") {
        const { start, end } = periodBounds(periodKey);
        const rows = await db.query.userDailyQuest.findMany({
          where: (q, { and: _and, eq: _eq }) => _and(_eq(q.userId, userId)),
        });
        let dk = start;
        while (dk <= end) {
          const dayKeys = pickDailyQuestKeysForDate(dk);
          const dayRows = rows.filter((r) => r.dateKey === dk);
          const claimed = dayRows.filter((r) => r.claimedAt != null).length;
          if (claimed >= dayKeys.length) return 1;
          const [y, m, d] = dk.split("-").map(Number);
          dk = localDateKey(new Date(y, m - 1, d + 1));
        }
        return 0;
      }

      return 0;

    }

    case "reach-new-division": {
      const g = await db.query.userGamification.findFirst({
        where: (row, { eq: _eq }) => _eq(row.userId, userId),
      });
      if (!g) return 0;
      const { start } = periodBounds(periodKey);
      const { levelFromXp } = await import("./definitions");
      const current = levelFromXp(g.totalXp).level;
      const seasonStart = new Date(
        Number(start.slice(0, 4)),
        Number(start.slice(5, 7)) - 1,
        Number(start.slice(8, 10))
      );
      const [beforeRow] = await db
        .select({ total: sql<number>`coalesce(sum(${xpEvent.amount}), 0)` })
        .from(xpEvent)
        .where(
          and(eq(xpEvent.userId, userId), sql`${xpEvent.createdAt} < ${seasonStart}`)
        );
      const xpBeforeSeason = Number(beforeRow?.total ?? 0);
      return current > levelFromXp(xpBeforeSeason).level ? 1 : 0;
    }

    default:
      return 0;

  }

}

async function syncQuestRowsForCadence(
  userId: string,
  cadence: QuestCadence,
  periodKey: string,
  stats: UserGamificationStats,
  todayKey: string
): Promise<QuestProgress[]> {

  const questKeys = pickQuestKeysForPeriod(cadence, periodKey);
  const now = new Date();
  const results: QuestProgress[] = [];

  for (const questKey of questKeys) {

    const def = getQuestDef(questKey);
    if (!def) continue;

    const progress = await computeQuestProgress(
      questKey,
      stats,
      periodKey,
      userId,
      todayKey
    );
    const capped = Math.min(def.goal, Math.max(0, progress));

    const existing = await db.query.userDailyQuest.findFirst({

      where: (q, { and: _and, eq: _eq }) =>
        _and(
          _eq(q.userId, userId),
          _eq(q.dateKey, periodKey),
          _eq(q.questKey, questKey)
        ),

    });

    if (existing) {
      const nextProgress = Math.max(existing.progress, capped);
      const needsUpdate =
        nextProgress !== existing.progress || existing.goal !== def.goal;
      if (needsUpdate) {
        await db
          .update(userDailyQuest)
          .set({ progress: nextProgress, goal: def.goal, updatedAt: now })
          .where(eq(userDailyQuest.id, existing.id));
      }
      results.push({

        questKey,
        progress: nextProgress,
        goal: def.goal,
        xp: def.xp,
        claimed: existing.claimedAt != null,
        cadence,
        periodKey,

      });

    } else {

      await db.insert(userDailyQuest).values({

        id: randomUUID(),
        userId,
        dateKey: periodKey,
        questKey,
        progress: capped,
        goal: def.goal,
        updatedAt: now,

      });
      results.push({

        questKey,
        progress: capped,
        goal: def.goal,
        xp: def.xp,
        claimed: false,
        cadence,
        periodKey,

      });

    }

  }

  return results;

}

export async function syncAllQuestRows(
  userId: string,
  todayKey: string,
  stats: UserGamificationStats
): Promise<{

  dailyQuests: QuestProgress[];
  weeklyQuests: QuestProgress[];
  seasonQuests: QuestProgress[];

}> {

  const weeklyKey = periodKeyForCadence("weekly");
  const seasonKey = periodKeyForCadence("season");

  const [dailyQuests, weeklyQuests, seasonQuests] = await Promise.all([
    syncQuestRowsForCadence(userId, "daily", todayKey, stats, todayKey),
    syncQuestRowsForCadence(userId, "weekly", weeklyKey, stats, todayKey),
    syncQuestRowsForCadence(userId, "season", seasonKey, stats, todayKey),
  ]);

  return { dailyQuests, weeklyQuests, seasonQuests };

}

/** @deprecated Use syncAllQuestRows */
export async function syncDailyQuestRows(
  userId: string,
  dateKey: string,
  stats: UserGamificationStats
): Promise<QuestProgress[]> {

  const all = await syncAllQuestRows(userId, dateKey, stats);
  return all.dailyQuests;

}

export function resolveQuestCadence(
  questKey: string,
  periodKey: string
): QuestCadence {

  const def = getQuestDef(questKey);
  if (def) return def.cadence;
  return cadenceFromPeriodKey(periodKey);

}

export {

  pickWeeklyQuestKeysForPeriod,
  pickSeasonQuestKeysForPeriod,
  periodKeyForCadence,

};

