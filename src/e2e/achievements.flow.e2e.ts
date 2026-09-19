// Backend E2E flow: every achievement in the catalog, unlocked progressively by seeding the
// exact DB rows the real action that earns it leaves behind, then claimed through the real
// gamification API.
//
// Why seed instead of driving the real actions end-to-end: several achievements key off things
// this suite can't produce live and deterministically — a real AI analysis scoring >=95 (`/analyze`
// is a real, non-deterministic external call that frequently comes back `failed` on a synthetic
// clip, see e2e/README.md), a second coach account rating a review 100, or 30 real days of
// logins. What actually drives every achievement, per src/gamification/stats.ts, is a small set
// of DB rows (technique_video, technique_analysis.metrics.ai_analysis, coach_student,
// coach_video_review, user_gamification.loginStreak) — the same rows onVideoUploaded /
// onAnalysisCompleted / onCoachReviewCompleted / onFriendLinked (gamification/service.ts) leave
// behind once a real action completes. lib/achievementSeed.ts writes those rows directly; this
// suite then drives the real evaluate -> unlock -> claim path through the real HTTP endpoints
// (GET /gamification/state, POST /gamification/achievements/:key/claim), so it's the wiring
// between "action happened" and "achievement awarded + claimable" that's actually under test.
//
// Run: start the server (`pnpm run dev`) in one terminal, then in another:
//   pnpm run test:e2e
//
// Env: E2E_BASE_URL (default http://localhost:3050). Each run creates two brand-new throwaway
// accounts (student + coach) so the locked -> claimable -> claimed progression is observed from
// a clean slate every time, unlike the fixed shared user in lib/testUser.ts's signInE2EUser.

import test from "node:test";
import assert from "node:assert/strict";
import { E2EClient } from "./lib/http";
import { signUpFreshE2EUser } from "./lib/testUser";
import {
  seedTechniqueVideos,
  seedTechniqueVideosAcrossMonths,
  seedCompletedAnalysis,
  seedCoachStudentLink,
  seedCoachVideoReview,
  seedLoginStreak,
} from "./lib/achievementSeed";
import { ACHIEVEMENT_KEYS } from "../gamification/definitions";

const STATE_PATH = "/api/auth/profile/gamification/state";
const claimPath = (key: string) => `/api/auth/profile/gamification/achievements/${key}/claim`;

async function getUserId(client: E2EClient): Promise<string> {
  const { status, body } = await client.getJson("/api/auth/profile/me");
  assert.equal(status, 200, `GET /me failed: ${JSON.stringify(body)}`);
  assert.ok(body?.user?.id, "/me response missing user.id");
  return body.user.id as string;
}

function claimableKeys(body: any): string[] {
  return (body?.claimableAchievements ?? []).map((a: any) => a.key);
}

function claimedKeys(body: any): string[] {
  return (body?.achievements ?? []).map((a: any) => a.key);
}

/** Asserts `key` is claimable (proves the seeded action was correctly recognized as meeting the
 * achievement), then claims it (proves the claim endpoint moves it into the claimed list). */
async function expectClaimableThenClaim(
  t: any,
  client: E2EClient,
  key: string,
  becauseOf: string
) {
  await t.test(`"${key}" is claimable after ${becauseOf}`, async () => {
    const { status, body } = await client.getJson(STATE_PATH);
    assert.equal(status, 200);
    assert.ok(
      claimableKeys(body).includes(key),
      `expected "${key}" claimable; got claimable=${JSON.stringify(claimableKeys(body))}`
    );
  });

  await t.test(`"${key}" claim succeeds and moves it to claimed`, async () => {
    const res = await client.postJson(claimPath(key), {});
    const bodyText = await res.text();
    assert.equal(res.status, 200, `claim "${key}" failed: ${bodyText}`);
    const body = JSON.parse(bodyText);
    assert.ok(
      claimedKeys(body).includes(key),
      `expected "${key}" in claimed list after claiming; got ${JSON.stringify(claimedKeys(body))}`
    );
  });
}

test("achievements: every catalog key unlocks from its real trigger action, then claims", async (t) => {
  const student = await signUpFreshE2EUser("achv-student");
  const coach = await signUpFreshE2EUser("achv-coach");
  const studentId = await getUserId(student);
  const coachId = await getUserId(coach);

  // --- Upload volume: first-upload -> upload-10 -> upload-20 -> upload-40 ---
  await seedTechniqueVideos(studentId, 1);
  await expectClaimableThenClaim(t, student, "first-upload", "1st video upload");

  await seedTechniqueVideos(studentId, 9);
  await expectClaimableThenClaim(t, student, "upload-10", "10 total uploads");

  await seedTechniqueVideos(studentId, 10);
  await expectClaimableThenClaim(t, student, "upload-20", "20 total uploads");

  await seedTechniqueVideos(studentId, 20);
  await expectClaimableThenClaim(t, student, "upload-40", "40 total uploads");

  // --- Upload cadence: 7 consecutive days, 12 consecutive months ---
  await seedTechniqueVideos(studentId, 7, { daysApart: 1, startDaysAgo: 6 });
  await expectClaimableThenClaim(t, student, "upload-full-week", "7 consecutive daily uploads");

  await seedTechniqueVideosAcrossMonths(studentId, 12);
  await expectClaimableThenClaim(
    t,
    student,
    "monthly-year",
    "one upload/month for 12 consecutive months"
  );

  // --- Login streaks ---
  await seedLoginStreak(studentId, 3);
  await expectClaimableThenClaim(t, student, "streak-3", "3-day login streak");

  await seedLoginStreak(studentId, 7);
  await expectClaimableThenClaim(t, student, "streak-7", "7-day login streak");

  await seedLoginStreak(studentId, 30);
  await expectClaimableThenClaim(t, student, "streak-30", "30-day login streak");

  // 9 other achievements already claimed above (>= the 5 "secret" requires) -> should already
  // be claimable with no seeding of its own.
  await expectClaimableThenClaim(t, student, "secret", "5+ other achievements already claimed");

  // --- AI analysis score thresholds ---
  await seedCompletedAnalysis(studentId, 55, { strokeLabel: "forehand" });
  await expectClaimableThenClaim(t, student, "first-ai", "1st completed AI analysis");
  await expectClaimableThenClaim(t, student, "above-50", "analysis scored >=50");

  await seedCompletedAnalysis(studentId, 85, { strokeLabel: "backhand" });
  await expectClaimableThenClaim(t, student, "above-80", "analysis scored >=80");

  await seedCompletedAnalysis(studentId, 92, { strokeLabel: "smash" });
  await expectClaimableThenClaim(t, student, "above-90", "analysis scored >=90");

  await seedCompletedAnalysis(studentId, 97, { strokeLabel: "slice" });
  await expectClaimableThenClaim(t, student, "the-goat", "analysis scored >=95");

  // --- Category-specific score thresholds ---
  await seedCompletedAnalysis(studentId, 65, { category: "defence_glass" });
  await expectClaimableThenClaim(
    t,
    student,
    "above-60-defence",
    "defence_glass analysis scored >=60"
  );

  await seedCompletedAnalysis(studentId, 65, { category: "net_play" });
  await expectClaimableThenClaim(t, student, "net-play-60", "net_play analysis scored >=60");

  await seedCompletedAnalysis(studentId, 65, { category: "overhead" });
  await expectClaimableThenClaim(t, student, "smash-60", "overhead (smash) analysis scored >=60");

  // --- Three distinct techniques >=90 (smash + slice above already qualify; add a third) ---
  await seedCompletedAnalysis(studentId, 91, { strokeLabel: "volley" });
  await expectClaimableThenClaim(
    t,
    student,
    "three-techniques-90",
    "3 distinct strokes each scored >=90"
  );

  // --- Improve a shot: same stroke re-analyzed at a strictly higher score ---
  await seedCompletedAnalysis(studentId, 60, { strokeLabel: "lob" });
  await seedCompletedAnalysis(studentId, 75, { strokeLabel: "lob" });
  await expectClaimableThenClaim(
    t,
    student,
    "improve-shot",
    "same stroke re-analyzed at a higher score"
  );

  // --- Coach review flow ---
  await seedCoachVideoReview(coachId, studentId);
  await expectClaimableThenClaim(t, student, "first-coach-review", "1st completed coach review");

  await seedCoachVideoReview(coachId, studentId, { coachMarksJson: [{ score: 100 }] });
  await expectClaimableThenClaim(t, student, "coach-rate-100", "coach marked a review 100");

  // --- Friend link (coach adds student to their roster) ---
  await seedCoachStudentLink(coachId, studentId);
  await expectClaimableThenClaim(t, student, "add-friend", "coach linked the student");

  await t.test("every catalog achievement ended up claimed", async () => {
    const { status, body } = await student.getJson(STATE_PATH);
    assert.equal(status, 200);
    const claimed = new Set(claimedKeys(body));
    const missing = ACHIEVEMENT_KEYS.filter((k) => !claimed.has(k));
    assert.equal(
      missing.length,
      0,
      `achievements never unlocked/claimed by the end of the happy path: ${missing.join(", ")}`
    );
  });
});
