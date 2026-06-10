/** Achievement keys — must match `app/src/lib/achievementsCatalog.ts`. */
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

export type DailyQuestDef = {
  key: string;
  xp: number;
  goal: number;
};

/** XP + goals — must match `app/src/lib/dailyQuestsCatalog.ts`. */
export const ALL_DAILY_QUESTS: DailyQuestDef[] = [
  { key: "achieve-s-rank-ai", xp: 700, goal: 1 },
  { key: "complete-1-ai-analysis", xp: 130, goal: 1 },
  { key: "complete-3-before-midday", xp: 20, goal: 1 },
  { key: "complete-3-daily-quests", xp: 300, goal: 1 },
  { key: "complete-all-daily-quests", xp: 1000, goal: 1 },
  { key: "complete-an-upload", xp: 35, goal: 1 },
  { key: "complete-perfect-week", xp: 2000, goal: 1 },
  { key: "first-login-of-day", xp: 15, goal: 1 },
  { key: "get-80-above-smashes", xp: 240, goal: 1 },
  { key: "get-ai-score-above-80", xp: 150, goal: 1 },
  { key: "get-over-70-score", xp: 30, goal: 1 },
  { key: "get-perfect-volleys", xp: 260, goal: 1 },
  { key: "get-streak-50-points", xp: 120, goal: 1 },
  { key: "hit-perfect-bandejas", xp: 110, goal: 1 },
  { key: "improve-ai-score-yesterday", xp: 280, goal: 1 },
  { key: "improve-shot-accuracy-15", xp: 900, goal: 1 },
  { key: "invite-a-friend", xp: 200, goal: 1 },
  { key: "login-to-app", xp: 20, goal: 1 },
  { key: "maintain-5-day-streak", xp: 320, goal: 1 },
  { key: "maintain-7-day-streak", xp: 800, goal: 1 },
  { key: "reach-new-division", xp: 1300, goal: 1 },
  { key: "score-above-60-serves", xp: 70, goal: 1 },
  { key: "share-result", xp: 40, goal: 1 },
  { key: "share-your-profile", xp: 20, goal: 1 },
  { key: "upload-1-backhand", xp: 50, goal: 1 },
  { key: "upload-1-forehand", xp: 50, goal: 1 },
  { key: "upload-3-consecutive-days", xp: 40, goal: 1 },
  { key: "upload-3-volley-shots", xp: 100, goal: 3 },
  { key: "upload-a-full-video", xp: 120, goal: 1 },
  { key: "upload-analyze-full-video", xp: 250, goal: 1 },
  { key: "upload-successful-serve", xp: 60, goal: 1 },
  { key: "watch-ai-replay", xp: 35, goal: 1 },
];

export const DAILY_QUESTS_PER_DAY = 4;

export const CLIENT_TRACKABLE_QUEST_KEYS = new Set([
  "share-result",
  "share-your-profile",
  "watch-ai-replay",
]);

const DAILY_QUEST_BY_KEY = new Map(ALL_DAILY_QUESTS.map((q) => [q.key, q]));

export function getDailyQuestDef(key: string): DailyQuestDef | undefined {
  return DAILY_QUEST_BY_KEY.get(key);
}

function hashString(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Same algorithm as the app — 4 quests per calendar day. */
export function pickDailyQuestKeysForDate(
  dateKey: string,
  count = DAILY_QUESTS_PER_DAY
): string[] {
  const pool = [...ALL_DAILY_QUESTS];
  let seed = hashString(dateKey);
  for (let i = pool.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = seed % (i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.min(count, pool.length)).map((q) => q.key);
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
