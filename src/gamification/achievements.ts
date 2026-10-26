import { randomUUID } from "crypto";
import type { AchievementKey } from "./definitions";
import { ACHIEVEMENT_KEYS } from "./definitions";
import type { UserGamificationStats } from "./stats";
import { db, userAchievement } from "../db";

export type AchievementProgress = { current: number; goal: number };

function count(current: number, goal: number): AchievementProgress {
  return { current: Math.max(0, Math.min(goal, Math.floor(current))), goal };
}

function threshold(best: number | null, goal: number): AchievementProgress {
  return count(best ?? 0, goal);
}

function flag(done: boolean): AchievementProgress {
  return { current: done ? 1 : 0, goal: 1 };
}

/**
 * How far a player is toward an achievement. Single source of truth: an achievement is earned
 * exactly when `current >= goal`, so the unlock rule and the progress bar can't disagree.
 */
export function progressFor(key: AchievementKey, s: UserGamificationStats): AchievementProgress {
  switch (key) {
    case "streak-3":
      return count(s.loginStreak, 3);
    case "streak-7":
      return count(s.loginStreak, 7);
    case "streak-30":
      return count(s.loginStreak, 30);
    case "first-upload":
      return count(s.videoCount, 1);
    case "upload-10":
      return count(s.videoCount, 10);
    case "upload-20":
      return count(s.videoCount, 20);
    case "upload-40":
      return count(s.videoCount, 40);
    case "upload-full-week":
      return count(s.maxUploadStreakDays, 7);
    case "monthly-year":
      return count(s.maxConsecutiveUploadMonths, 12);
    case "first-ai":
      return count(s.completedAnalysisCount, 1);
    case "above-50":
      return threshold(s.maxOverallScore, 50);
    case "above-80":
      return threshold(s.maxOverallScore, 80);
    case "above-90":
      return threshold(s.maxOverallScore, 90);
    case "the-goat":
      return threshold(s.maxOverallScore, 95);
    case "above-60-defence":
      return threshold(s.maxDefenceScore, 60);
    case "net-play-60":
      return threshold(s.maxNetPlayScore, 60);
    case "smash-60":
      return threshold(s.maxSmashScore, 60);
    case "three-techniques-90":
      return count(s.techniquesWith90.size, 3);
    case "first-coach-review":
      return flag(s.hasCoachReview);
    case "coach-rate-100":
      return flag(s.hasCoachRated100);
    case "improve-shot":
      return flag(s.hasImprovedShot);
    case "add-friend":
      return count(s.friendLinkCount, 1);
    case "secret":
      return count(Array.from(s.claimedKeys).filter((k) => k !== "secret").length, 5);
    // A "match" is an uploaded video; a "win" is a scored analysis beating the previous one.
    case "first-match":
      return count(s.videoCount, 1);
    case "matches-10":
      return count(s.videoCount, 10);
    case "win-streak-3":
      return count(s.bestWinStreak, 3);
    case "shot-analyzer":
      return count(s.scoredAnalysisCount, 10);
    case "weekly-consistency":
      return count(s.maxSessionsInWeek, 3);
    case "technique-improver":
      return count(s.techniqueGain, 10);
    default:
      return { current: 0, goal: 1 };
  }
}

function meetsAchievement(key: AchievementKey, s: UserGamificationStats): boolean {
  const p = progressFor(key, s);
  return p.current >= p.goal;
}

/** Progress for every achievement key; anything already earned is reported as complete. */
export function achievementProgressList(
  stats: UserGamificationStats,
  earnedKeys: ReadonlySet<string>
): { key: AchievementKey; current: number; goal: number }[] {
  return ACHIEVEMENT_KEYS.map((key) => {
    const p = progressFor(key, stats);
    return { key, goal: p.goal, current: earnedKeys.has(key) ? p.goal : p.current };
  });
}

export function evaluateNewAchievements(
  stats: UserGamificationStats
): AchievementKey[] {
  const newly: AchievementKey[] = [];
  for (const key of ACHIEVEMENT_KEYS) {
    if (stats.earnedKeys.has(key)) continue;
    if (meetsAchievement(key, stats)) {
      newly.push(key);
    }
  }
  return newly;
}

export async function unlockAchievements(
  userId: string,
  keys: AchievementKey[]
): Promise<string[]> {
  if (keys.length === 0) return [];

  const now = new Date();
  const inserted = await db
    .insert(userAchievement)
    .values(
      keys.map((achievementKey) => ({
        id: randomUUID(),
        userId,
        achievementKey,
        unlockedAt: now,
        claimedAt: null,
      }))
    )
    .onConflictDoNothing()
    .returning({ achievementKey: userAchievement.achievementKey });

  return inserted.map((r) => r.achievementKey);
}
