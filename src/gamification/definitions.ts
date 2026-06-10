/** Achievement keys — must match `app/src/lib/achievementsCatalog.ts`. */

import type { QuestCadence } from "./questPeriods";

import {

  periodKeyForCadence,

  weeklyPeriodKey,

  seasonPeriodKey,

} from "./questPeriods";

import { localDateKey } from "./stats";



export const ACHIEVEMENT_KEYS = [

  "streak-3",

  "first-upload",

  "streak-7",

  "streak-30",

  "above-50",

  "above-60-defence",

  "above-80",

  "above-90",

  "net-play-60",

  "smash-60",

  "three-techniques-90",

  "the-goat",

  "coach-rate-100",

  "first-ai",

  "first-coach-review",

  "improve-shot",

  "add-friend",

  "upload-10",

  "upload-20",

  "upload-40",

  "upload-full-week",

  "monthly-year",

  "secret",

] as const;



export type AchievementKey = (typeof ACHIEVEMENT_KEYS)[number];



export type QuestDef = {

  key: string;

  xp: number;

  goal: number;

  cadence: QuestCadence;

};



/** XP + goals + cadence — must match `app/src/lib/dailyQuestsCatalog.ts`. */

export const ALL_QUESTS: QuestDef[] = [

  // Daily — small XP (15–60), refresh at midnight

  { key: "first-login-of-day", xp: 15, goal: 1, cadence: "daily" },

  { key: "login-to-app", xp: 20, goal: 1, cadence: "daily" },

  { key: "share-your-profile", xp: 20, goal: 1, cadence: "daily" },

  { key: "complete-3-before-midday", xp: 25, goal: 3, cadence: "daily" },

  { key: "complete-3-daily-quests", xp: 30, goal: 3, cadence: "daily" },

  { key: "complete-an-upload", xp: 35, goal: 1, cadence: "daily" },

  { key: "watch-ai-replay", xp: 35, goal: 1, cadence: "daily" },

  { key: "get-over-70-score", xp: 40, goal: 1, cadence: "daily" },

  { key: "share-result", xp: 45, goal: 1, cadence: "daily" },

  { key: "improve-ai-score-yesterday", xp: 50, goal: 1, cadence: "daily" },

  { key: "upload-1-backhand", xp: 50, goal: 1, cadence: "daily" },

  { key: "get-ai-score-above-80", xp: 55, goal: 1, cadence: "daily" },

  { key: "score-above-60-serves", xp: 55, goal: 1, cadence: "daily" },

  { key: "complete-1-ai-analysis", xp: 60, goal: 1, cadence: "daily" },



  // Weekly — medium XP (180–380), refresh each ISO week

  { key: "upload-3-volley-shots", xp: 180, goal: 3, cadence: "weekly" },

  { key: "upload-a-full-video", xp: 200, goal: 1, cadence: "weekly" },

  { key: "hit-perfect-bandejas", xp: 220, goal: 1, cadence: "weekly" },

  { key: "get-streak-50-points", xp: 250, goal: 3, cadence: "weekly" },

  { key: "invite-a-friend", xp: 280, goal: 1, cadence: "weekly" },

  { key: "get-80-above-smashes", xp: 280, goal: 1, cadence: "weekly" },

  { key: "get-perfect-volleys", xp: 300, goal: 1, cadence: "weekly" },

  { key: "upload-analyze-full-video", xp: 320, goal: 1, cadence: "weekly" },

  { key: "upload-3-consecutive-days", xp: 350, goal: 3, cadence: "weekly" },

  { key: "complete-all-daily-quests", xp: 380, goal: 1, cadence: "weekly" },



  // Season — large XP (900–2400), refresh every 4 months

  { key: "achieve-s-rank-ai", xp: 900, goal: 1, cadence: "season" },

  { key: "improve-shot-accuracy-15", xp: 1100, goal: 1, cadence: "season" },

  { key: "maintain-5-day-streak", xp: 1300, goal: 5, cadence: "season" },

  { key: "maintain-7-day-streak", xp: 1600, goal: 7, cadence: "season" },

  { key: "complete-perfect-week", xp: 1900, goal: 7, cadence: "season" },

  { key: "reach-new-division", xp: 2400, goal: 1, cadence: "season" },

];



/** @deprecated Use ALL_QUESTS */

export const ALL_DAILY_QUESTS = ALL_QUESTS;



export type DailyQuestDef = QuestDef;



export const DAILY_QUESTS_PER_DAY = 4;

export const WEEKLY_QUESTS_PER_WEEK = 3;

export const SEASON_QUESTS_PER_SEASON = 2;



export const CLIENT_TRACKABLE_QUEST_KEYS = new Set([

  "share-result",

  "share-your-profile",

  "watch-ai-replay",

]);



const QUEST_BY_KEY = new Map(ALL_QUESTS.map((q) => [q.key, q]));



export function getQuestDef(key: string): QuestDef | undefined {

  return QUEST_BY_KEY.get(key);

}



/** @deprecated Use getQuestDef */

export function getDailyQuestDef(key: string): QuestDef | undefined {

  return getQuestDef(key);

}



function hashString(input: string): number {

  let h = 2166136261;

  for (let i = 0; i < input.length; i++) {

    h ^= input.charCodeAt(i);

    h = Math.imul(h, 16777619);

  }

  return h >>> 0;

}



function pickQuestKeysFromPool(

  pool: QuestDef[],

  periodKey: string,

  count: number

): string[] {

  const copy = [...pool];

  let seed = hashString(periodKey);

  for (let i = copy.length - 1; i > 0; i--) {

    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;

    const j = seed % (i + 1);

    [copy[i], copy[j]] = [copy[j], copy[i]];

  }

  return copy.slice(0, Math.min(count, copy.length)).map((q) => q.key);

}



const DAILY_POOL = ALL_QUESTS.filter((q) => q.cadence === "daily");

const WEEKLY_POOL = ALL_QUESTS.filter((q) => q.cadence === "weekly");

const SEASON_POOL = ALL_QUESTS.filter((q) => q.cadence === "season");



export function pickDailyQuestKeysForDate(

  dateKey: string,

  count = DAILY_QUESTS_PER_DAY

): string[] {

  return pickQuestKeysFromPool(DAILY_POOL, dateKey, count);

}



export function pickWeeklyQuestKeysForPeriod(

  periodKey: string = weeklyPeriodKey(),

  count = WEEKLY_QUESTS_PER_WEEK

): string[] {

  return pickQuestKeysFromPool(WEEKLY_POOL, periodKey, count);

}



export function pickSeasonQuestKeysForPeriod(

  periodKey: string = seasonPeriodKey(),

  count = SEASON_QUESTS_PER_SEASON

): string[] {

  return pickQuestKeysFromPool(SEASON_POOL, periodKey, count);

}



export function pickQuestKeysForPeriod(

  cadence: QuestCadence,

  periodKey: string

): string[] {

  if (cadence === "weekly") {

    return pickWeeklyQuestKeysForPeriod(periodKey);

  }

  if (cadence === "season") {

    return pickSeasonQuestKeysForPeriod(periodKey);

  }

  return pickDailyQuestKeysForDate(periodKey);

}



export function isQuestActiveInPeriod(

  questKey: string,

  cadence: QuestCadence,

  periodKey: string

): boolean {

  return pickQuestKeysForPeriod(cadence, periodKey).includes(questKey);

}



export const XP_PER_LEVEL = 2500;



const LEVEL_TIERS = [

  "Rookie",

  "Bronze",

  "Silver",

  "Gold",

  "Platinum",

  "Elite",

  "Master",

  "Legend",

] as const;



export function levelFromXp(totalXp: number) {

  const safeXp = Math.max(0, Math.floor(totalXp));

  const level = Math.max(1, Math.floor(safeXp / XP_PER_LEVEL) + 1);

  const xpInLevel = safeXp % XP_PER_LEVEL;

  const tier =

    LEVEL_TIERS[Math.min(level - 1, LEVEL_TIERS.length - 1)] ?? "Legend";

  return {

    level,

    xpInLevel,

    xpGoal: XP_PER_LEVEL,

    totalXp: safeXp,

    tier,

  };

}



export { periodKeyForCadence, weeklyPeriodKey, seasonPeriodKey };


