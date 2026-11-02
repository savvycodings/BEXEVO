import express from "express";
import { fromNodeHeaders } from "better-auth/node";
import { randomUUID } from "crypto";
import { and, count, desc, eq } from "drizzle-orm";
import { auth } from "../auth";
import { db, follow, user, userProfile } from "../db";
import { normalizeTarget, type FollowTarget } from "./followTargets";

/**
 * One-way follows of coaches and countries (no approval, no notification).
 *   GET    /me                      -> { coaches: string[], countries: string[] } newest first
 *   GET    /:targetType/:targetId   -> { following, followerCount }
 *   PUT    /:targetType/:targetId   -> follow (idempotent)
 *   DELETE /:targetType/:targetId   -> unfollow (idempotent, no role check)
 */
const router = express.Router();
router.use(express.json());

async function resolveUserId(req: express.Request): Promise<string | null> {
  const authSession = await auth.api
    .getSession({ headers: fromNodeHeaders(req.headers) })
    .catch(() => null);
  if (authSession?.user?.id) return authSession.user.id;

  const authHeader = req.headers.authorization;
  const bearerToken =
    typeof authHeader === "string" && authHeader.toLowerCase().startsWith("bearer ")
      ? authHeader.slice(7).trim()
      : null;
  if (!bearerToken) return null;
  const sessionRow = await db.query.session.findFirst({
    where: (s, { eq: _eq }) => _eq(s.token, bearerToken),
  });
  return sessionRow?.userId ?? null;
}

async function followerCount(target: FollowTarget): Promise<number> {
  const rows = await db
    .select({ n: count() })
    .from(follow)
    .where(and(eq(follow.targetType, target.targetType), eq(follow.targetId, target.targetId)));
  return Number(rows[0]?.n ?? 0);
}

async function isFollowing(followerUserId: string, target: FollowTarget): Promise<boolean> {
  const rows = await db
    .select({ id: follow.id })
    .from(follow)
    .where(
      and(
        eq(follow.followerUserId, followerUserId),
        eq(follow.targetType, target.targetType),
        eq(follow.targetId, target.targetId)
      )
    )
    .limit(1);
  return rows.length > 0;
}

type TargetCheck =
  | { ok: true; target: FollowTarget }
  | { ok: false; status: number; error: string };

/**
 * Parses the URL target. `mode` decides how strict coach targets are:
 * - follow: no self-follow, the user must exist (404) and be a coach (400)
 * - read: the user must exist (404)
 * - unfollow: syntax only, so a follow can always be removed
 */
async function checkTarget(
  req: express.Request,
  requesterId: string,
  mode: "follow" | "read" | "unfollow"
): Promise<TargetCheck> {
  const parsed = normalizeTarget(req.params.targetType, req.params.targetId);
  if (!parsed.ok) {
    return {
      ok: false,
      status: 400,
      error: parsed.error === "bad_target_type" ? "Unsupported follow target type" : "Invalid follow target",
    };
  }
  const target = parsed.target;
  if (target.targetType !== "coach" || mode === "unfollow") return { ok: true, target };

  if (mode === "follow" && target.targetId === requesterId) {
    return { ok: false, status: 400, error: "You can't follow yourself" };
  }
  const rows = await db
    .select({ id: user.id, role: userProfile.coachStudentRole })
    .from(user)
    .leftJoin(userProfile, eq(userProfile.userId, user.id))
    .where(eq(user.id, target.targetId))
    .limit(1);
  if (!rows[0]) return { ok: false, status: 404, error: "Coach not found" };
  if (mode === "follow" && rows[0].role !== "coach") {
    return { ok: false, status: 400, error: "That user is not a coach" };
  }
  return { ok: true, target };
}

router.get("/me", async (req, res) => {
  try {
    const userId = await resolveUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    // Coach follows inner-join `user`, so follows of deleted coaches drop out.
    const coachRows = await db
      .select({ targetId: follow.targetId })
      .from(follow)
      .innerJoin(user, eq(user.id, follow.targetId))
      .where(and(eq(follow.followerUserId, userId), eq(follow.targetType, "coach")))
      .orderBy(desc(follow.createdAt));
    const countryRows = await db
      .select({ targetId: follow.targetId })
      .from(follow)
      .where(and(eq(follow.followerUserId, userId), eq(follow.targetType, "country")))
      .orderBy(desc(follow.createdAt));

    return res.json({
      coaches: coachRows.map((r) => r.targetId),
      countries: countryRows.map((r) => r.targetId),
    });
  } catch (e) {
    console.error("[Follows] list error", e);
    return res.status(500).json({ error: "Failed to load follows" });
  }
});

router.get("/:targetType/:targetId", async (req, res) => {
  try {
    const userId = await resolveUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const check = await checkTarget(req, userId, "read");
    if (!check.ok) return res.status(check.status).json({ error: check.error });

    const [following, followers] = await Promise.all([
      isFollowing(userId, check.target),
      followerCount(check.target),
    ]);
    return res.json({ following, followerCount: followers });
  } catch (e) {
    console.error("[Follows] state error", e);
    return res.status(500).json({ error: "Failed to load follow state" });
  }
});

router.put("/:targetType/:targetId", async (req, res) => {
  try {
    const userId = await resolveUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const check = await checkTarget(req, userId, "follow");
    if (!check.ok) return res.status(check.status).json({ error: check.error });

    await db
      .insert(follow)
      .values({ id: randomUUID(), followerUserId: userId, ...check.target })
      .onConflictDoNothing({ target: [follow.followerUserId, follow.targetType, follow.targetId] });
    return res.json({ following: true, followerCount: await followerCount(check.target) });
  } catch (e) {
    console.error("[Follows] follow error", e);
    return res.status(500).json({ error: "Failed to follow" });
  }
});

router.delete("/:targetType/:targetId", async (req, res) => {
  try {
    const userId = await resolveUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const check = await checkTarget(req, userId, "unfollow");
    if (!check.ok) return res.status(check.status).json({ error: check.error });

    await db
      .delete(follow)
      .where(
        and(
          eq(follow.followerUserId, userId),
          eq(follow.targetType, check.target.targetType),
          eq(follow.targetId, check.target.targetId)
        )
      );
    return res.json({ following: false, followerCount: await followerCount(check.target) });
  } catch (e) {
    console.error("[Follows] unfollow error", e);
    return res.status(500).json({ error: "Failed to unfollow" });
  }
});

export default router;
