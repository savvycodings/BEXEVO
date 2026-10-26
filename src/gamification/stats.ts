import { and, eq } from "drizzle-orm";
import {
  db,
  coachStudent,
  coachVideoReview,
  techniqueAnalysis,
  techniqueVideo,
  userAchievement,
} from "../db";
import {
  storedAiBreakdownToPercent,
  storedAiScoreToPercent,
} from "../technique/techniqueScoreScale";

const VALID_TRAIN_CATEGORY = new Set([
  "ground_strokes",
  "net_play",
  "defence_glass",
  "save_return",
  "overhead",
  "tactical_specials",
]);

export type AnalysisSnapshot = {
  id: string;
  createdAt: Date;
  dateKey: string;
  score: number | null;
  techniqueScore: number | null;
  rating: string | null;
  category: string | null;
  strokeLabel: string | null;
  techniqueVideoId: string;
};

export type UserGamificationStats = {
  videoCount: number;
  uploadDateKeys: Set<string>;
  uploadMonthKeys: Set<string>;
  maxUploadStreakDays: number;
  hasMonthlyYearUploads: boolean;
  /** Longest run of consecutive calendar months with an upload. */
  maxConsecutiveUploadMonths: number;
  completedAnalysisCount: number;
  /** Completed analyses with an overall score. */
  scoredAnalysisCount: number;
  /** Longest run of scored analyses each beating the previous one ("wins"). */
  bestWinStreak: number;
  /** Most completed analyses in any Monday–Sunday week. */
  maxSessionsInWeek: number;
  /** Best technique score minus the first one (≥ 0). */
  techniqueGain: number;
  maxOverallScore: number | null;
  maxDefenceScore: number | null;
  maxNetPlayScore: number | null;
  maxSmashScore: number | null;
  techniquesWith90: Set<string>;
  hasImprovedShot: boolean;
  hasCoachReview: boolean;
  hasCoachRated100: boolean;
  friendLinkCount: number;
  friendLinkToday: boolean;
  friendLinkDateKeys: Set<string>;
  loginStreak: number;
  analyses: AnalysisSnapshot[];
  todayAnalyses: AnalysisSnapshot[];
  todayUploadCount: number;
  yesterdayMaxScore: number | null;
  todayMaxScore: number | null;
  todayVolleyCount: number;
  unlockedAchievementCount: number;
  earnedKeys: Set<string>;
  claimedKeys: Set<string>;
  clientTrackedToday: Set<string>;
};

export function localDateKey(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function addDays(dateKey: string, delta: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + delta);
  return localDateKey(dt);
}

function maxConsecutiveDays(dateKeys: Set<string>): number {
  if (dateKeys.size === 0) return 0;
  const sorted = Array.from(dateKeys).sort();
  let best = 1;
  let run = 1;
  for (let i = 1; i < sorted.length; i++) {
    if (addDays(sorted[i - 1], 1) === sorted[i]) {
      run += 1;
      best = Math.max(best, run);
    } else {
      run = 1;
    }
  }
  return best;
}

function nextMonthKey(key: string): string {
  const [y, m] = key.split("-").map(Number);
  const next = new Date(y, m - 1, 1);
  next.setMonth(next.getMonth() + 1);
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`;
}

export function maxConsecutiveMonths(monthKeys: Set<string>): number {
  if (monthKeys.size === 0) return 0;
  const sorted = Array.from(monthKeys).sort();
  let best = 1;
  let run = 1;
  for (let i = 1; i < sorted.length; i++) {
    run = nextMonthKey(sorted[i - 1]) === sorted[i] ? run + 1 : 1;
    best = Math.max(best, run);
  }
  return best;
}

/** Monday date key of the week containing `d` (local time). */
function weekKey(d: Date): string {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = x.getDay();
  x.setDate(x.getDate() + (day === 0 ? -6 : 1 - day));
  return localDateKey(x);
}

/** Derived counts for the progress-style achievements; pure so it can be unit-tested. */
export function analysisProgressStats(analyses: AnalysisSnapshot[]): {
  scoredAnalysisCount: number;
  bestWinStreak: number;
  maxSessionsInWeek: number;
  techniqueGain: number;
} {
  const ordered = [...analyses].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  let scoredAnalysisCount = 0;
  let bestWinStreak = 0;
  let run = 0;
  let prevScore: number | null = null;
  for (const a of ordered) {
    if (a.score == null) continue;
    scoredAnalysisCount += 1;
    run = prevScore != null && a.score > prevScore ? run + 1 : 0;
    bestWinStreak = Math.max(bestWinStreak, run);
    prevScore = a.score;
  }

  const perWeek = new Map<string, number>();
  for (const a of ordered) {
    const k = weekKey(a.createdAt);
    perWeek.set(k, (perWeek.get(k) ?? 0) + 1);
  }
  const maxSessionsInWeek = Math.max(0, ...perWeek.values());

  let firstTechnique: number | null = null;
  let bestTechnique: number | null = null;
  for (const a of ordered) {
    if (a.techniqueScore == null) continue;
    if (firstTechnique == null) firstTechnique = a.techniqueScore;
    bestTechnique = bestTechnique == null ? a.techniqueScore : Math.max(bestTechnique, a.techniqueScore);
  }
  const techniqueGain =
    firstTechnique != null && bestTechnique != null ? Math.max(0, bestTechnique - firstTechnique) : 0;

  return { scoredAnalysisCount, bestWinStreak, maxSessionsInWeek, techniqueGain };
}

export function trainCategoryFromMetrics(metrics: unknown): string | null {
  if (!metrics || typeof metrics !== "object") return null;
  const m = metrics as Record<string, unknown>;
  const ai = m.ai_analysis as Record<string, unknown> | undefined;
  const primary =
    typeof ai?.primary_train_category === "string"
      ? ai.primary_train_category.trim()
      : null;
  if (primary && VALID_TRAIN_CATEGORY.has(primary)) return primary;

  const retrieval = m.retrieval as Record<string, unknown> | undefined;
  const sh = retrieval?.shot_hypothesis as Record<string, unknown> | undefined;
  const c = typeof sh?.category === "string" ? sh.category.trim() : null;
  if (c && VALID_TRAIN_CATEGORY.has(c)) return c;
  return null;
}

export function strokeLabelFromMetrics(metrics: unknown): string | null {
  if (!metrics || typeof metrics !== "object") return null;
  const m = metrics as Record<string, unknown>;
  const retrieval = m.retrieval as Record<string, unknown> | undefined;
  const sh = retrieval?.shot_hypothesis as Record<string, unknown> | undefined;
  if (typeof sh?.stroke_label === "string") return sh.stroke_label.toLowerCase();
  const ai = m.ai_analysis as Record<string, unknown> | undefined;
  if (typeof ai?.stroke_label === "string") return ai.stroke_label.toLowerCase();
  const preset = typeof sh?.stroke_preset === "string" ? sh.stroke_preset : null;
  if (preset) return preset.toLowerCase();
  return null;
}

function coachMarksHasScore100(marks: unknown): boolean {
  if (!Array.isArray(marks)) return false;
  for (const item of marks) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const score = o.score ?? o.rating ?? o.coachScore;
    if (score === 100 || score === "100") return true;
  }
  return false;
}

function analysisFromRow(row: {
  id: string;
  createdAt: Date;
  metrics: unknown;
  techniqueVideoId: string;
}): AnalysisSnapshot {
  const ai =
    (row.metrics as Record<string, unknown> | null | undefined)?.ai_analysis as
      | Record<string, unknown>
      | undefined;
  return {
    id: row.id,
    createdAt: row.createdAt,
    dateKey: localDateKey(row.createdAt),
    score: storedAiScoreToPercent(ai),
    techniqueScore: storedAiBreakdownToPercent(ai).technique,
    rating: typeof ai?.rating === "string" ? ai.rating : null,
    category: trainCategoryFromMetrics(row.metrics),
    strokeLabel: strokeLabelFromMetrics(row.metrics),
    techniqueVideoId: row.techniqueVideoId,
  };
}

export async function loadUserGamificationStats(
  userId: string,
  opts: {
    loginStreak: number;
    todayKey: string;
    clientTrackedToday?: Set<string>;
  }
): Promise<UserGamificationStats> {
  const yesterdayKey = addDays(opts.todayKey, -1);

  const [videos, analyses, friendLinks, achievements, coachReviews] =
    await Promise.all([
      db
        .select({ createdAt: techniqueVideo.createdAt })
        .from(techniqueVideo)
        .where(eq(techniqueVideo.userId, userId)),
      db
        .select({
          id: techniqueAnalysis.id,
          createdAt: techniqueAnalysis.createdAt,
          metrics: techniqueAnalysis.metrics,
          techniqueVideoId: techniqueAnalysis.techniqueVideoId,
        })
        .from(techniqueAnalysis)
        .where(
          and(
            eq(techniqueAnalysis.userId, userId),
            eq(techniqueAnalysis.status, "completed")
          )
        ),
      db
        .select({ createdAt: coachStudent.createdAt })
        .from(coachStudent)
        .where(eq(coachStudent.studentUserId, userId)),
      db
        .select({
          achievementKey: userAchievement.achievementKey,
          claimedAt: userAchievement.claimedAt,
        })
        .from(userAchievement)
        .where(eq(userAchievement.userId, userId)),
      db
        .select({
          status: coachVideoReview.status,
          coachMarksJson: coachVideoReview.coachMarksJson,
          techniqueVideoId: coachVideoReview.techniqueVideoId,
          techniqueAnalysisId: coachVideoReview.techniqueAnalysisId,
        })
        .from(coachVideoReview)
        .where(eq(coachVideoReview.studentUserId, userId)),
    ]);

  const uploadDateKeys = new Set<string>();
  const uploadMonthKeys = new Set<string>();
  let todayUploadCount = 0;
  for (const v of videos) {
    const dk = localDateKey(v.createdAt);
    uploadDateKeys.add(dk);
    uploadMonthKeys.add(monthKey(v.createdAt));
    if (dk === opts.todayKey) todayUploadCount += 1;
  }

  const analysisSnaps = analyses.map(analysisFromRow);
  const todayAnalyses = analysisSnaps.filter((a) => a.dateKey === opts.todayKey);

  let maxOverallScore: number | null = null;
  let maxDefenceScore: number | null = null;
  let maxNetPlayScore: number | null = null;
  let maxSmashScore: number | null = null;
  const techniquesWith90 = new Set<string>();
  const bestByStroke = new Map<string, number>();
  let hasImprovedShot = false;

  let yesterdayMaxScore: number | null = null;
  let todayMaxScore: number | null = null;
  let todayVolleyCount = 0;

  for (const a of analysisSnaps) {
    if (a.score != null) {
      maxOverallScore =
        maxOverallScore == null ? a.score : Math.max(maxOverallScore, a.score);
      if (a.dateKey === yesterdayKey) {
        yesterdayMaxScore =
          yesterdayMaxScore == null
            ? a.score
            : Math.max(yesterdayMaxScore, a.score);
      }
      if (a.dateKey === opts.todayKey) {
        todayMaxScore =
          todayMaxScore == null ? a.score : Math.max(todayMaxScore, a.score);
      }
    }

    if (a.category === "defence_glass" && a.score != null) {
      maxDefenceScore =
        maxDefenceScore == null ? a.score : Math.max(maxDefenceScore, a.score);
    }
    if (a.category === "net_play" && a.score != null) {
      maxNetPlayScore =
        maxNetPlayScore == null ? a.score : Math.max(maxNetPlayScore, a.score);
    }

    const stroke = a.strokeLabel ?? "";
    const isSmash =
      a.category === "overhead" ||
      stroke.includes("smash") ||
      stroke.includes("overhead");
    if (isSmash && a.score != null) {
      maxSmashScore =
        maxSmashScore == null ? a.score : Math.max(maxSmashScore, a.score);
    }

    if (a.score != null && a.score >= 90) {
      const techKey = stroke || a.category || a.id;
      techniquesWith90.add(techKey);
    }

    if (a.score != null && stroke) {
      const prev = bestByStroke.get(stroke);
      if (prev != null && a.score > prev) {
        hasImprovedShot = true;
      }
      bestByStroke.set(
        stroke,
        prev == null ? a.score : Math.max(prev, a.score)
      );
    }

    if (a.dateKey === opts.todayKey) {
      const isVolley =
        a.category === "net_play" ||
        (stroke.includes("volley") && !stroke.includes("half"));
      if (isVolley) todayVolleyCount += 1;
    }
  }

  const completedCoachReviews = coachReviews.filter(
    (r) => r.status === "completed"
  );
  const hasCoachReview = completedCoachReviews.length > 0;

  const analysisByVideo = new Map(
    analysisSnaps.map((a) => [a.techniqueVideoId, a])
  );

  let hasCoachRated100 = false;
  for (const review of completedCoachReviews) {
    if (coachMarksHasScore100(review.coachMarksJson)) {
      hasCoachRated100 = true;
      break;
    }
    const linked =
      (review.techniqueAnalysisId
        ? analysisSnaps.find((a) => a.id === review.techniqueAnalysisId)
        : null) ?? analysisByVideo.get(review.techniqueVideoId);
    if (linked?.score === 100) {
      hasCoachRated100 = true;
      break;
    }
  }

  const earnedKeys = new Set(achievements.map((a) => a.achievementKey));
  const claimedKeys = new Set(
    achievements.filter((a) => a.claimedAt != null).map((a) => a.achievementKey)
  );
  const friendLinkDateKeys = new Set<string>();
  let friendLinkToday = false;
  for (const link of friendLinks) {
    const dk = localDateKey(link.createdAt);
    friendLinkDateKeys.add(dk);
    if (dk === opts.todayKey) {
      friendLinkToday = true;
    }
  }

  const maxConsecutiveUploadMonths = maxConsecutiveMonths(uploadMonthKeys);

  return {
    videoCount: videos.length,
    uploadDateKeys,
    uploadMonthKeys,
    maxUploadStreakDays: maxConsecutiveDays(uploadDateKeys),
    hasMonthlyYearUploads: maxConsecutiveUploadMonths >= 12,
    maxConsecutiveUploadMonths,
    completedAnalysisCount: analysisSnaps.length,
    ...analysisProgressStats(analysisSnaps),
    maxOverallScore,
    maxDefenceScore,
    maxNetPlayScore,
    maxSmashScore,
    techniquesWith90,
    hasImprovedShot,
    hasCoachReview,
    hasCoachRated100,
    friendLinkCount: friendLinks.length,
    friendLinkToday,
    friendLinkDateKeys,
    loginStreak: opts.loginStreak,
    analyses: analysisSnaps,
    todayAnalyses,
    todayUploadCount,
    yesterdayMaxScore,
    todayMaxScore,
    todayVolleyCount,
    unlockedAchievementCount: claimedKeys.size,
    earnedKeys,
    claimedKeys,
    clientTrackedToday: opts.clientTrackedToday ?? new Set(),
  };
}

/** UTC bounds for "yesterday" relative to a local date key (approximate). */
export function utcDayBounds(dateKey: string) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const start = new Date(y, m - 1, d, 0, 0, 0, 0);
  const end = new Date(y, m - 1, d + 1, 0, 0, 0, 0);
  return { start, end };
}

export async function countClaimsBeforeMidday(
  userId: string,
  dateKey: string
): Promise<number> {
  const { start } = utcDayBounds(dateKey);
  const midday = new Date(start);
  midday.setHours(12, 0, 0, 0);

  const rows = await db.query.userDailyQuest.findMany({
    where: (q, { and: _and, eq: _eq }) =>
      _and(_eq(q.userId, userId), _eq(q.dateKey, dateKey)),
  });

  return rows.filter(
    (r) => r.claimedAt && r.claimedAt < midday && r.claimedAt >= start
  ).length;
}
