// Direct-DB seed helpers for the achievements e2e flow.
//
// `/analyze`, a second coach account's review UI, 30 real days of logins, and a real
// score >=95 clip aren't things a test can drive live (see e2e/README.md's "Known limitation").
// What every achievement actually keys off, per src/gamification/stats.ts, is a handful of DB
// rows (technique_video, technique_analysis.metrics.ai_analysis, coach_student,
// coach_video_review, user_gamification.loginStreak) — the same rows the real trigger points
// (onVideoUploaded, onAnalysisCompleted, onCoachReviewCompleted, onFriendLinked in
// gamification/service.ts) leave behind once a real action completes. These helpers write those
// rows directly so the achievements.flow.e2e.ts suite can drive the real evaluate/unlock/claim
// code path (via the real HTTP endpoints) deterministically and fast.

// This file is imported by the e2e test process, a separate Node process from the running
// server — it needs its own DATABASE_URL, which the server gets via its `dotenv/config` import
// in index.ts but this process otherwise wouldn't.
import "dotenv/config";
import { randomUUID } from "crypto";
import {
  db,
  techniqueVideo,
  techniqueAnalysis,
  coachStudent,
  coachVideoReview,
  userGamification,
  type TechniqueAiAnalysisV61,
} from "../../db";
import { localDateKey } from "../../gamification/stats";

function fixtureVideoRow(userId: string, createdAt: Date) {
  const id = randomUUID();
  return {
    id,
    userId,
    cloudinaryPublicId: `e2e-seed/${id}`,
    cloudinaryUrl: `https://example.test/e2e-seed/${id}.mp4`,
    createdAt,
  };
}

/** Insert `count` bare technique_video rows. With `daysApart`/`startDaysAgo`, spreads them
 * across consecutive calendar days (for upload-streak achievements); otherwise all "now". */
export async function seedTechniqueVideos(
  userId: string,
  count: number,
  opts: { daysApart?: number; startDaysAgo?: number } = {}
): Promise<string[]> {
  const daysApart = opts.daysApart ?? 0;
  const startDaysAgo = opts.startDaysAgo ?? 0;
  const now = Date.now();
  const DAY_MS = 86_400_000;
  const rows = Array.from({ length: count }, (_, i) =>
    fixtureVideoRow(userId, new Date(now - startDaysAgo * DAY_MS + i * daysApart * DAY_MS))
  );
  await db.insert(techniqueVideo).values(rows);
  return rows.map((r) => r.id);
}

/** Insert one technique_video row per calendar month for `months` consecutive months ending
 * this month (for the monthly-year achievement). */
export async function seedTechniqueVideosAcrossMonths(
  userId: string,
  months: number
): Promise<string[]> {
  const base = new Date();
  const rows = Array.from({ length: months }, (_, idx) => {
    const monthsAgo = months - 1 - idx;
    const d = new Date(base.getFullYear(), base.getMonth() - monthsAgo, 15);
    return fixtureVideoRow(userId, d);
  });
  await db.insert(techniqueVideo).values(rows);
  return rows.map((r) => r.id);
}

/** Insert a completed technique_analysis row with a synthetic ai_analysis score/category/stroke
 * — exactly the fields src/gamification/stats.ts reads to compute score + technique-key stats. */
export async function seedCompletedAnalysis(
  userId: string,
  score: number,
  opts: { category?: string; strokeLabel?: string } = {}
): Promise<{ videoId: string; analysisId: string }> {
  const [videoId] = await seedTechniqueVideos(userId, 1);
  const analysisId = randomUUID();
  const aiAnalysis: TechniqueAiAnalysisV61 = {
    score,
    score_scale: "percent",
    ...(opts.category ? { primary_train_category: opts.category } : {}),
    ...(opts.strokeLabel ? { stroke_label: opts.strokeLabel } : {}),
  };
  await db.insert(techniqueAnalysis).values({
    id: analysisId,
    techniqueVideoId: videoId,
    userId,
    status: "completed",
    metrics: { ai_analysis: aiAnalysis },
  });
  return { videoId, analysisId };
}

/** Insert a coach_student link (the "add-friend" achievement's real trigger,
 * onFriendLinked, fires whenever this row is created for a student). */
export async function seedCoachStudentLink(coachUserId: string, studentUserId: string) {
  await db
    .insert(coachStudent)
    .values({ id: randomUUID(), coachUserId, studentUserId })
    .onConflictDoNothing();
}

/** Insert a completed coach_video_review. Pass `coachMarksJson: [{ score: 100 }]` for the
 * coach-rate-100 achievement; any completed review satisfies first-coach-review. */
export async function seedCoachVideoReview(
  coachUserId: string,
  studentUserId: string,
  opts: { coachMarksJson?: unknown } = {}
) {
  const [videoId] = await seedTechniqueVideos(studentUserId, 1);
  await db.insert(coachVideoReview).values({
    id: randomUUID(),
    coachUserId,
    studentUserId,
    techniqueVideoId: videoId,
    status: "completed",
    coachMarksJson: opts.coachMarksJson ?? [{ note: "e2e seed" }],
    submittedAt: new Date(),
  });
}

/** Sets loginStreak directly, with lastLoginDate pinned to today so refreshGamification's
 * recordDailyLogin sees "already logged in today" and leaves the seeded streak untouched. */
export async function seedLoginStreak(userId: string, streak: number) {
  const today = localDateKey();
  const now = new Date();
  await db
    .insert(userGamification)
    .values({
      userId,
      totalXp: 0,
      loginStreak: streak,
      lastLoginDate: today,
      lastLevel: 1,
      dayStartDate: today,
      dayStartLevel: 1,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: userGamification.userId,
      set: { loginStreak: streak, lastLoginDate: today, updatedAt: now },
    });
}
