import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import {
  getDailyQuestDef,
  pickDailyQuestKeysForDate,
} from "./definitions";
import type { UserGamificationStats } from "./stats";
import { countClaimsBeforeMidday } from "./stats";
import { db, userDailyQuest } from "../db";

export type QuestProgress = {
  questKey: string;
  progress: number;
  goal: number;
  xp: number;
  claimed: boolean;
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

export async function computeQuestProgress(
  questKey: string,
  stats: UserGamificationStats,
  dateKey: string,
  userId: string
): Promise<number> {
  const def = getDailyQuestDef(questKey);
  if (!def) return 0;

  if (stats.clientTrackedToday.has(questKey)) {
    return def.goal;
  }

  switch (questKey) {
    case "login-to-app":
    case "first-login-of-day":
      return stats.loginStreak > 0 ? 1 : 0;

    case "complete-an-upload":
    case "upload-a-full-video":
      return stats.todayUploadCount > 0 ? 1 : 0;

    case "complete-1-ai-analysis":
      return stats.todayAnalyses.length > 0 ? 1 : 0;

    case "upload-analyze-full-video":
      return stats.todayUploadCount > 0 && stats.todayAnalyses.length > 0 ? 1 : 0;

    case "get-over-70-score":
      return stats.todayAnalyses.some((a) => (a.score ?? 0) >= 70) ? 1 : 0;

    case "get-ai-score-above-80":
      return stats.todayAnalyses.some((a) => (a.score ?? 0) >= 80) ? 1 : 0;

    case "achieve-s-rank-ai":
      return stats.todayAnalyses.some((a) => isSRank(a.rating, a.score)) ? 1 : 0;

    case "get-80-above-smashes":
      return stats.todayAnalyses.some((a) => {
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
      return stats.todayAnalyses.some(
        (a) =>
          (a.category === "save_return" ||
            analysisMatchesStroke(a.strokeLabel, ["serve", "return"])) &&
          (a.score ?? 0) >= 60
      )
        ? 1
        : 0;

    case "upload-successful-serve":
      return stats.todayAnalyses.some(
        (a) =>
          (a.category === "save_return" ||
            analysisMatchesStroke(a.strokeLabel, ["serve"])) &&
          (a.score ?? 0) >= 60
      )
        ? 1
        : 0;

    case "upload-1-forehand":
      return stats.todayAnalyses.some((a) =>
        analysisMatchesStroke(a.strokeLabel, ["forehand"])
      )
        ? 1
        : 0;

    case "upload-1-backhand":
      return stats.todayAnalyses.some((a) =>
        analysisMatchesStroke(a.strokeLabel, ["backhand"])
      )
        ? 1
        : 0;

    case "upload-3-volley-shots":
      return Math.min(def.goal, stats.todayVolleyCount);

    case "get-perfect-volleys":
      return stats.todayAnalyses.some(
        (a) =>
          (a.category === "net_play" ||
            analysisMatchesStroke(a.strokeLabel, ["volley"])) &&
          (a.score ?? 0) >= 90
      )
        ? 1
        : 0;

    case "hit-perfect-bandejas":
      return stats.todayAnalyses.some(
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
      return stats.todayAnalyses.some((a) => {
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
      return stats.todayAnalyses.filter((a) => (a.score ?? 0) >= 50).length >= 3
        ? 1
        : 0;

    case "maintain-5-day-streak":
      return stats.loginStreak >= 5 ? 1 : 0;

    case "maintain-7-day-streak":
    case "complete-perfect-week":
      return stats.loginStreak >= 7 ? 1 : 0;

    case "upload-3-consecutive-days":
      return stats.maxUploadStreakDays >= 3 ? 1 : 0;

    case "invite-a-friend":
      return stats.friendLinkToday ? 1 : 0;

    case "complete-3-before-midday": {
      const n = await countClaimsBeforeMidday(userId, dateKey);
      return n >= 3 ? 1 : 0;
    }

    case "complete-3-daily-quests":
    case "complete-all-daily-quests": {
      const rows = await db.query.userDailyQuest.findMany({
        where: (q, { and: _and, eq: _eq }) =>
          _and(_eq(q.userId, userId), _eq(q.dateKey, dateKey)),
      });
      const claimed = rows.filter((r) => r.claimedAt != null).length;
      if (questKey === "complete-3-daily-quests") {
        return claimed >= 3 ? 1 : 0;
      }
      const todaysKeys = pickDailyQuestKeysForDate(dateKey);
      return claimed >= todaysKeys.length ? 1 : 0;
    }

    case "reach-new-division": {
      const g = await db.query.userGamification.findFirst({
        where: (row, { eq: _eq }) => _eq(row.userId, userId),
      });
      if (!g || g.dayStartDate !== dateKey) return 0;
      const { levelFromXp } = await import("./definitions");
      const current = levelFromXp(g.totalXp).level;
      return current > g.dayStartLevel ? 1 : 0;
    }

    default:
      return 0;
  }
}

export async function syncDailyQuestRows(
  userId: string,
  dateKey: string,
  stats: UserGamificationStats
): Promise<QuestProgress[]> {
  const questKeys = pickDailyQuestKeysForDate(dateKey);
  const now = new Date();
  const results: QuestProgress[] = [];

  for (const questKey of questKeys) {
    const def = getDailyQuestDef(questKey);
    if (!def) continue;

    const progress = await computeQuestProgress(
      questKey,
      stats,
      dateKey,
      userId
    );
    const capped = Math.min(def.goal, Math.max(0, progress));

    const existing = await db.query.userDailyQuest.findFirst({
      where: (q, { and: _and, eq: _eq }) =>
        _and(
          _eq(q.userId, userId),
          _eq(q.dateKey, dateKey),
          _eq(q.questKey, questKey)
        ),
    });

    if (existing) {
      const nextProgress = Math.max(existing.progress, capped);
      if (nextProgress !== existing.progress) {
        await db
          .update(userDailyQuest)
          .set({ progress: nextProgress, updatedAt: now })
          .where(eq(userDailyQuest.id, existing.id));
      }
      results.push({
        questKey,
        progress: nextProgress,
        goal: def.goal,
        xp: def.xp,
        claimed: existing.claimedAt != null,
      });
    } else {
      await db.insert(userDailyQuest).values({
        id: randomUUID(),
        userId,
        dateKey,
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
      });
    }
  }

  return results;
}
