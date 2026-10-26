// `./achievements` transitively imports `../db`, which throws at module load without DATABASE_URL.
import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import { ACHIEVEMENT_KEYS } from "./definitions";
import { achievementProgressList, evaluateNewAchievements, progressFor } from "./achievements";
import {
  analysisProgressStats,
  maxConsecutiveMonths,
  type AnalysisSnapshot,
  type UserGamificationStats,
} from "./stats";

const DAY = 24 * 60 * 60 * 1000;
const BASE = new Date(2026, 9, 5, 12).getTime(); // Monday 5 Oct 2026, local noon

function snap(i: number, score: number | null, opts: { day?: number; technique?: number | null } = {}): AnalysisSnapshot {
  const createdAt = new Date(BASE + (opts.day ?? i) * DAY);
  return {
    id: `a${i}`,
    createdAt,
    dateKey: "",
    score,
    techniqueScore: opts.technique ?? null,
    rating: null,
    category: null,
    strokeLabel: null,
    techniqueVideoId: `v${i}`,
  };
}

function stats(over: Partial<UserGamificationStats> = {}): UserGamificationStats {
  return {
    videoCount: 0,
    uploadDateKeys: new Set(),
    uploadMonthKeys: new Set(),
    maxUploadStreakDays: 0,
    hasMonthlyYearUploads: false,
    maxConsecutiveUploadMonths: 0,
    completedAnalysisCount: 0,
    scoredAnalysisCount: 0,
    bestWinStreak: 0,
    maxSessionsInWeek: 0,
    techniqueGain: 0,
    maxOverallScore: null,
    maxDefenceScore: null,
    maxNetPlayScore: null,
    maxSmashScore: null,
    techniquesWith90: new Set(),
    hasImprovedShot: false,
    hasCoachReview: false,
    hasCoachRated100: false,
    friendLinkCount: 0,
    friendLinkToday: false,
    friendLinkDateKeys: new Set(),
    loginStreak: 0,
    analyses: [],
    todayAnalyses: [],
    todayUploadCount: 0,
    yesterdayMaxScore: null,
    todayMaxScore: null,
    todayVolleyCount: 0,
    unlockedAchievementCount: 0,
    earnedKeys: new Set(),
    claimedKeys: new Set(),
    clientTrackedToday: new Set(),
    ...over,
  };
}

const scores = (xs: number[]) => xs.map((x, i) => snap(i, x));

test("win streak counts consecutive strict improvements", () => {
  assert.equal(analysisProgressStats(scores([60, 62, 65, 70])).bestWinStreak, 3);
  assert.equal(analysisProgressStats(scores([60, 62, 61, 65, 70])).bestWinStreak, 2);
  assert.equal(analysisProgressStats(scores([70, 70, 70])).bestWinStreak, 0);
  // Unscored analyses are skipped, not treated as losses.
  assert.equal(analysisProgressStats([snap(0, 60), snap(1, null), snap(2, 61), snap(3, 62), snap(4, 63)]).bestWinStreak, 3);
});

test("win streak follows creation order, not input order", () => {
  const xs = scores([60, 62, 65, 70]).reverse();
  assert.equal(analysisProgressStats(xs).bestWinStreak, 3);
});

test("sessions per week group by Monday-based weeks", () => {
  // Mon, Wed, Sun of one week, then next Monday.
  const xs = [snap(0, 50, { day: 0 }), snap(1, 50, { day: 2 }), snap(2, 50, { day: 6 }), snap(3, 50, { day: 7 })];
  assert.equal(analysisProgressStats(xs).maxSessionsInWeek, 3);
  assert.equal(analysisProgressStats([]).maxSessionsInWeek, 0);
});

test("technique gain is best minus first technique score", () => {
  const xs = [snap(0, 50, { technique: 55 }), snap(1, 50, { technique: 50 }), snap(2, 50, { technique: 66 })];
  assert.equal(analysisProgressStats(xs).techniqueGain, 11);
  assert.equal(analysisProgressStats([snap(0, 50, { technique: 70 }), snap(1, 50, { technique: 60 })]).techniqueGain, 0);
});

test("consecutive upload months", () => {
  assert.equal(maxConsecutiveMonths(new Set(["2025-11", "2025-12", "2026-01", "2026-03"])), 3);
  assert.equal(maxConsecutiveMonths(new Set()), 0);
});

test("spec scenarios for the new achievements", () => {
  const winning = stats(analysisProgressStats(scores([60, 62, 65, 70])));
  assert.ok(evaluateNewAchievements(winning).includes("win-streak-3"));
  const broken = stats(analysisProgressStats(scores([60, 62, 61, 65, 70])));
  assert.ok(!evaluateNewAchievements(broken).includes("win-streak-3"));

  const improver = stats({ techniqueGain: 11 });
  assert.ok(evaluateNewAchievements(improver).includes("technique-improver"));

  assert.deepEqual(progressFor("matches-10", stats({ videoCount: 3 })), { current: 3, goal: 10 });
});

test("every key has bounded progress, and earned means current >= goal", () => {
  const fixtures = [
    stats(),
    stats({ videoCount: 3, loginStreak: 2, maxOverallScore: 49.6, scoredAnalysisCount: 4 }),
    stats({
      videoCount: 50,
      loginStreak: 40,
      maxUploadStreakDays: 9,
      maxConsecutiveUploadMonths: 13,
      completedAnalysisCount: 30,
      scoredAnalysisCount: 30,
      bestWinStreak: 5,
      maxSessionsInWeek: 6,
      techniqueGain: 25,
      maxOverallScore: 99,
      maxDefenceScore: 70,
      maxNetPlayScore: 70,
      maxSmashScore: 70,
      techniquesWith90: new Set(["a", "b", "c"]),
      hasImprovedShot: true,
      hasCoachReview: true,
      hasCoachRated100: true,
      friendLinkCount: 2,
      claimedKeys: new Set(["a", "b", "c", "d", "e"]),
    }),
  ];
  for (const s of fixtures) {
    const newly = new Set(evaluateNewAchievements(s));
    for (const key of ACHIEVEMENT_KEYS) {
      const p = progressFor(key, s);
      assert.ok(Number.isInteger(p.goal) && p.goal > 0, `${key} goal`);
      assert.ok(p.current >= 0 && p.current <= p.goal, `${key} current in range`);
      assert.equal(newly.has(key), p.current >= p.goal, `${key} unlock matches progress`);
    }
  }
  // The maxed-out fixture earns everything.
  assert.equal(evaluateNewAchievements(fixtures[2]).length, ACHIEVEMENT_KEYS.length);
});

test("progress list covers every key and reports earned keys as complete", () => {
  const list = achievementProgressList(stats({ loginStreak: 2 }), new Set(["streak-7"]));
  assert.equal(list.length, ACHIEVEMENT_KEYS.length);
  assert.deepEqual(list.find((p) => p.key === "streak-7"), { key: "streak-7", current: 7, goal: 7 });
  assert.deepEqual(list.find((p) => p.key === "streak-3"), { key: "streak-3", current: 2, goal: 3 });
});
