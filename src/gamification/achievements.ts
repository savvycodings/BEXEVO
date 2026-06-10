import { randomUUID } from "crypto";
import type { AchievementKey } from "./definitions";
import { ACHIEVEMENT_KEYS } from "./definitions";
import type { UserGamificationStats } from "./stats";
import { db, userAchievement } from "../db";

function meetsAchievement(key: AchievementKey, s: UserGamificationStats): boolean {
  switch (key) {
    case "streak-3":
      return s.loginStreak >= 3;
    case "streak-7":
      return s.loginStreak >= 7;
    case "streak-30":
      return s.loginStreak >= 30;
    case "first-upload":
      return s.videoCount >= 1;
    case "upload-10":
      return s.videoCount >= 10;
    case "upload-20":
      return s.videoCount >= 20;
    case "upload-40":
      return s.videoCount >= 40;
    case "upload-full-week":
      return s.maxUploadStreakDays >= 7;
    case "monthly-year":
      return s.hasMonthlyYearUploads;
    case "first-ai":
      return s.completedAnalysisCount >= 1;
    case "above-50":
      return s.maxOverallScore != null && s.maxOverallScore >= 50;
    case "above-80":
      return s.maxOverallScore != null && s.maxOverallScore >= 80;
    case "above-90":
      return s.maxOverallScore != null && s.maxOverallScore >= 90;
    case "the-goat":
      return s.maxOverallScore != null && s.maxOverallScore >= 95;
    case "above-60-defence":
      return s.maxDefenceScore != null && s.maxDefenceScore >= 60;
    case "net-play-60":
      return s.maxNetPlayScore != null && s.maxNetPlayScore >= 60;
    case "smash-60":
      return s.maxSmashScore != null && s.maxSmashScore >= 60;
    case "three-techniques-90":
      return s.techniquesWith90.size >= 3;
    case "first-coach-review":
      return s.hasCoachReview;
    case "coach-rate-100":
      return s.hasCoachRated100;
    case "improve-shot":
      return s.hasImprovedShot;
    case "add-friend":
      return s.friendLinkCount >= 1;
    case "secret": {
      const nonSecret = Array.from(s.claimedKeys).filter((k) => k !== "secret");
      return nonSecret.length >= 5;
    }
    default:
      return false;
  }
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
