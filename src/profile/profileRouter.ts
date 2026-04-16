import express from "express";
import fs from "fs";
import path from "path";
import multer from "multer";
import { randomUUID } from "crypto";
import { fromNodeHeaders } from "better-auth/node";
import { and, desc, eq, gte, inArray, lt } from "drizzle-orm";
import { auth } from "../auth";
import {
  db,
  user,
  userProfile,
  coachStudent,
  coachVideoReview,
  techniqueAnalysis,
  userNotification,
  coachStudentChat,
  coachStudentChatMessage,
} from "../db";

const router = express.Router();
router.use(express.json());
router.use(express.urlencoded({ extended: true }));
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});

const PROFILE_UPLOAD_ROOT = path.join(process.cwd(), "uploads", "profile");
const ADMIN_HUB_GATE_PASSWORD = process.env.ADMIN_HUB_GATE_PASSWORD || "xevodev";

type CoachStudentRole = "coach" | "student" | "none";

function normalizeCoachStudentRole(value: unknown): CoachStudentRole {
  if (value === "coach" || value === "student") return value;
  return "none";
}

async function getCoachStudentRole(userId: string): Promise<CoachStudentRole> {
  const profile = await db.query.userProfile.findFirst({
    where: (p, { eq: _eq }) => _eq(p.userId, userId),
  });
  return normalizeCoachStudentRole(profile?.coachStudentRole);
}

async function setCoachStudentRole(userId: string, role: CoachStudentRole): Promise<void> {
  const now = new Date();
  await db
    .insert(userProfile)
    .values({
      userId,
      coachStudentRole: role,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: userProfile.userId,
      set: {
        coachStudentRole: role,
        updatedAt: now,
      },
    });
}

async function resolveUserId(req: express.Request): Promise<string | null> {
  const authSession = await auth.api
    .getSession({
      headers: fromNodeHeaders(req.headers),
    })
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

  const resolvedUserId = sessionRow?.userId ?? null;
  if (!resolvedUserId) {
    console.log("[Profile] resolveUserId failed", {
      method: req.method,
      url: req.originalUrl,
      hasCookie: typeof req.headers.cookie === "string" && req.headers.cookie.length > 0,
      hasBearerAuth: !!bearerToken,
    });
  }
  return resolvedUserId;
}

const VALID_TRAIN_CATEGORY = new Set([
  "ground_strokes",
  "net_play",
  "defence_glass",
  "save_return",
  "overhead",
  "tactical_specials",
]);

/** Stable API order (matches Progress / profile rings). */
const TRAIN_CATEGORY_ORDER = [
  "save_return",
  "ground_strokes",
  "net_play",
  "defence_glass",
  "overhead",
  "tactical_specials",
] as const;

function utcMondayWeekBounds() {
  const now = new Date();
  const dayUtc = now.getUTCDay();
  const diffToMonday = (dayUtc + 6) % 7;
  const thisWeekStart = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - diffToMonday,
      0,
      0,
      0,
      0
    )
  );
  const nextWeekStart = new Date(thisWeekStart);
  nextWeekStart.setUTCDate(nextWeekStart.getUTCDate() + 7);
  const prevWeekStart = new Date(thisWeekStart);
  prevWeekStart.setUTCDate(prevWeekStart.getUTCDate() - 7);
  return { thisWeekStart, nextWeekStart, prevWeekStart };
}

function trainCategoryFromTechniqueMetrics(metrics: unknown): string | null {
  if (!metrics || typeof metrics !== "object") return null;
  const m = metrics as Record<string, unknown>;
  const ai = m.ai_analysis as Record<string, unknown> | undefined;
  const primary =
    typeof ai?.primary_train_category === "string" ? ai.primary_train_category.trim() : null;
  if (primary && VALID_TRAIN_CATEGORY.has(primary)) return primary;

  const retrieval = m.retrieval as Record<string, unknown> | undefined;
  const sh = retrieval?.shot_hypothesis as Record<string, unknown> | undefined;
  const c = typeof sh?.category === "string" ? sh.category.trim() : null;
  if (c && VALID_TRAIN_CATEGORY.has(c)) return c;
  return null;
}

function score10FromTechniqueMetrics(metrics: unknown): number | null {
  if (!metrics || typeof metrics !== "object") return null;
  const m = metrics as Record<string, unknown>;
  const ai = m.ai_analysis as Record<string, unknown> | undefined;
  const s = typeof ai?.score === "number" ? Number(ai.score) : null;
  if (s == null || !Number.isFinite(s)) return null;
  return Math.max(0, Math.min(10, s));
}

/** Profile + coach roster: per-train-category averages from technique_analysis (retrieval shot category). */
router.get("/rating-by-category", async (req, res) => {
  try {
    const userId = await resolveUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const { thisWeekStart, nextWeekStart, prevWeekStart } = utcMondayWeekBounds();

    const rows = await db
      .select({
        createdAt: techniqueAnalysis.createdAt,
        metrics: techniqueAnalysis.metrics,
        status: techniqueAnalysis.status,
      })
      .from(techniqueAnalysis)
      .where(
        and(
          eq(techniqueAnalysis.userId, userId),
          eq(techniqueAnalysis.status, "completed"),
          gte(techniqueAnalysis.createdAt, prevWeekStart),
          lt(techniqueAnalysis.createdAt, nextWeekStart)
        )
      );

    type Bucket = { twSum: number; twN: number; lwSum: number; lwN: number };
    const emptyBucket = (): Bucket => ({ twSum: 0, twN: 0, lwSum: 0, lwN: 0 });
    const byCat = new Map<string, Bucket>();
    for (const id of TRAIN_CATEGORY_ORDER) {
      byCat.set(id, emptyBucket());
    }

    let overallTw = 0,
      overallTwN = 0,
      overallLw = 0,
      overallLwN = 0;

    for (const row of rows) {
      const score = score10FromTechniqueMetrics(row.metrics);
      if (score == null) continue;
      const cat = trainCategoryFromTechniqueMetrics(row.metrics);
      const created = row.createdAt;
      const inThis = created >= thisWeekStart && created < nextWeekStart;
      const inLast = created >= prevWeekStart && created < thisWeekStart;

      if (inThis) {
        overallTw += score;
        overallTwN += 1;
      } else if (inLast) {
        overallLw += score;
        overallLwN += 1;
      }

      if (!cat) continue;
      const b = byCat.get(cat);
      if (!b) continue;
      if (inThis) {
        b.twSum += score;
        b.twN += 1;
      } else if (inLast) {
        b.lwSum += score;
        b.lwN += 1;
      }
    }

    const round1 = (v: number) => Math.round(v * 10) / 10;

    const categories = TRAIN_CATEGORY_ORDER.map((id) => {
      const b = byCat.get(id)!;
      return {
        id,
        thisWeek: b.twN > 0 ? round1(b.twSum / b.twN) : 0,
        lastWeek: b.lwN > 0 ? round1(b.lwSum / b.lwN) : 0,
        thisWeekCount: b.twN,
        lastWeekCount: b.lwN,
      };
    });

    return res.json({
      categories,
      overall: {
        thisWeek: overallTwN > 0 ? round1(overallTw / overallTwN) : null,
        lastWeek: overallLwN > 0 ? round1(overallLw / overallLwN) : null,
        thisWeekCount: overallTwN,
        lastWeekCount: overallLwN,
      },
    });
  } catch (e: any) {
    console.error("[Profile] rating-by-category GET error", e);
    return res.status(500).json({ error: "Failed to load rating by category" });
  }
});

router.get("/me", async (req, res) => {
  try {
    const userId = await resolveUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const userRow = await db.query.user.findFirst({
      where: (u, { eq: _eq }) => _eq(u.id, userId),
    });
    if (!userRow) return res.status(404).json({ error: "User not found" });

    const profile = await db.query.userProfile.findFirst({
      where: (p, { eq: _eq }) => _eq(p.userId, userId),
    });

    const hasRankedProfile =
      !!profile?.hasRanking && !!profile?.rankingOrg && !!profile?.rankingValue;
    const isComplete =
      !!profile?.courtSide && (!!profile?.level || hasRankedProfile);

    return res.json({
      user: {
        id: userRow.id,
        name: userRow.name,
        email: userRow.email,
        image: userRow.image,
      },
      profile: profile ?? null,
      isComplete,
    });
  } catch (e: any) {
    console.error("[Profile] me error", e);
    return res.status(500).json({ error: "Failed to fetch profile" });
  }
});

router.post("/setup", upload.single("avatar"), async (req, res) => {
  try {
    const userId = await resolveUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const dominantHand = (req.body?.dominantHand || "").trim() || null;
    const courtSide = (req.body?.courtSide || "").trim() || null;
    const hasRankingRaw = req.body?.hasRanking;
    const hasRanking =
      hasRankingRaw === "true" ? true : hasRankingRaw === "false" ? false : null;
    const level = (req.body?.level || "").trim() || null;
    const rankingOrg = (req.body?.rankingOrg || "").trim() || null;
    const rankingValue = (req.body?.rankingValue || "").trim() || null;
    const name = (req.body?.name || "").trim() || null;
    const username = (req.body?.username || "").trim() || null;
    const gender = (req.body?.gender || "").trim() || null;

    const hasRankedProfile = hasRanking === true && !!rankingOrg && !!rankingValue;

    if (!courtSide || (!level && !hasRankedProfile)) {
      return res.status(400).json({
        error:
          "Missing required setup fields (courtSide, and either level or ranking details).",
      });
    }

    let imageUrl: string | null = null;
    if (req.file?.buffer) {
      if (!fs.existsSync(PROFILE_UPLOAD_ROOT)) {
        fs.mkdirSync(PROFILE_UPLOAD_ROOT, { recursive: true });
      }
      const ext = path.extname(req.file.originalname || "") || ".jpg";
      const avatarFile = `${userId}-${randomUUID()}${ext}`;
      const avatarPath = path.join(PROFILE_UPLOAD_ROOT, avatarFile);
      await fs.promises.writeFile(avatarPath, req.file.buffer);
      imageUrl = `/uploads/profile/${avatarFile}`;
    }

    const now = new Date();
    await db
      .insert(userProfile)
      .values({
        userId,
        dominantHand,
        courtSide,
        hasRanking,
        gender,
        username,
        level,
        rankingOrg,
        rankingValue,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: userProfile.userId,
        set: {
          dominantHand,
          courtSide,
          hasRanking,
          gender,
          username,
          level,
          rankingOrg,
          rankingValue,
          updatedAt: now,
        },
      });

    const updates: Partial<typeof user.$inferInsert> = {};
    if (name) updates.name = name;
    if (imageUrl) updates.image = imageUrl;
    if (Object.keys(updates).length > 0) {
      await db.update(user).set(updates).where(eq(user.id, userId));
    }

    return res.json({ ok: true, image: imageUrl });
  } catch (e: any) {
    console.error("[Profile] setup error", e);
    return res.status(500).json({ error: "Failed to save profile setup" });
  }
});

router.post("/avatar", upload.single("avatar"), async (req, res) => {
  try {
    const userId = await resolveUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    if (!req.file?.buffer) {
      return res.status(400).json({ error: "No avatar image file" });
    }

    if (!fs.existsSync(PROFILE_UPLOAD_ROOT)) {
      fs.mkdirSync(PROFILE_UPLOAD_ROOT, { recursive: true });
    }

    const ext = path.extname(req.file.originalname || "") || ".jpg";
    const avatarFile = `${userId}-${randomUUID()}${ext}`;
    const avatarPath = path.join(PROFILE_UPLOAD_ROOT, avatarFile);
    await fs.promises.writeFile(avatarPath, req.file.buffer);
    const imageUrl = `/uploads/profile/${avatarFile}`;

    await db
      .update(user)
      .set({ image: imageUrl, updatedAt: new Date() })
      .where(eq(user.id, userId));

    return res.json({ ok: true, image: imageUrl });
  } catch (e: any) {
    console.error("[Profile] avatar error", e);
    return res.status(500).json({ error: "Failed to update avatar" });
  }
});

router.post("/basic", async (req, res) => {
  try {
    const userId = await resolveUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const name = (req.body?.name || "").trim() || null;
    const username = (req.body?.username || "").trim() || null;
    const gender = (req.body?.gender || "").trim() || null;

    const existingProfile = await db.query.userProfile.findFirst({
      where: (p, { eq: _eq }) => _eq(p.userId, userId),
    });
    const body = req.body as Record<string, unknown>;
    const includeAreaLocation = Object.prototype.hasOwnProperty.call(body, "areaLocation");
    let areaLocation: string | null;
    if (includeAreaLocation) {
      const raw = body.areaLocation;
      areaLocation =
        typeof raw === "string" && raw.trim().length > 0 ? raw.trim().slice(0, 200) : null;
    } else {
      areaLocation = existingProfile?.areaLocation ?? null;
    }

    const now = new Date();

    await db
      .insert(userProfile)
      .values({
        userId,
        username,
        gender,
        areaLocation,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: userProfile.userId,
        set: {
          username,
          gender,
          areaLocation,
          updatedAt: now,
        },
      });

    if (name) {
      await db.update(user).set({ name, updatedAt: now }).where(eq(user.id, userId));
    }

    return res.json({ ok: true });
  } catch (e: any) {
    console.error("[Profile] basic update error", e);
    return res.status(500).json({ error: "Failed to update profile" });
  }
});

router.post("/game", async (req, res) => {
  try {
    const userId = await resolveUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const hasRankingRaw = req.body?.hasRanking;
    const hasRanking =
      hasRankingRaw === true || hasRankingRaw === "true"
        ? true
        : hasRankingRaw === false || hasRankingRaw === "false"
        ? false
        : null;
    const level = (req.body?.level || "").trim() || null;
    const rankingOrg = (req.body?.rankingOrg || "").trim() || null;
    const rankingValue = (req.body?.rankingValue || "").trim() || null;

    if (hasRanking === null) {
      return res.status(400).json({ error: "hasRanking must be true or false." });
    }

    if (hasRanking === false && !level) {
      return res.status(400).json({ error: "Level is required when not ranked." });
    }

    if (hasRanking === true && (!rankingOrg || !rankingValue)) {
      return res
        .status(400)
        .json({ error: "Ranking organization and value are required when ranked." });
    }

    const now = new Date();
    await db
      .insert(userProfile)
      .values({
        userId,
        hasRanking,
        level: hasRanking ? null : level,
        rankingOrg: hasRanking ? rankingOrg : null,
        rankingValue: hasRanking ? rankingValue : null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: userProfile.userId,
        set: {
          hasRanking,
          level: hasRanking ? null : level,
          rankingOrg: hasRanking ? rankingOrg : null,
          rankingValue: hasRanking ? rankingValue : null,
          updatedAt: now,
        },
      });

    return res.json({ ok: true });
  } catch (e: any) {
    console.error("[Profile] game update error", e);
    return res.status(500).json({ error: "Failed to update game settings" });
  }
});

router.get("/directory", async (req, res) => {
  try {
    const requesterId = await resolveUserId(req);
    if (!requesterId) return res.status(401).json({ error: "Unauthorized" });

    const users = await db.query.user.findMany();
    const profiles = await db.query.userProfile.findMany();
    const profileByUserId = new Map(profiles.map((p) => [p.userId, p]));

    return res.json({
      users: users
        .sort((a, b) => {
          if (a.id === requesterId) return -1;
          if (b.id === requesterId) return 1;
          return a.name.localeCompare(b.name);
        })
        .map((u) => {
          const p = profileByUserId.get(u.id);
          return {
            id: u.id,
            name: u.name,
            image: u.image ?? null,
            username: p?.username ?? null,
            coachStudentRole: normalizeCoachStudentRole(p?.coachStudentRole),
          };
        }),
    });
  } catch (e: any) {
    console.error("[Profile] directory error", e);
    return res.status(500).json({ error: "Failed to load directory" });
  }
});

router.get("/coach-students", async (req, res) => {
  try {
    const coachUserId = await resolveUserId(req);
    if (!coachUserId) return res.status(401).json({ error: "Unauthorized" });

    const role = await getCoachStudentRole(coachUserId);
    if (role !== "coach") {
      return res.json({ students: [] });
    }

    const links = await db.query.coachStudent.findMany({
      where: (cs, { eq: _eq }) => _eq(cs.coachUserId, coachUserId),
    });
    const studentIds = Array.from(new Set(links.map((l) => l.studentUserId).filter(Boolean)));
    if (studentIds.length === 0) {
      return res.json({ students: [] });
    }

    const rows = await db
      .select({
        id: user.id,
        name: user.name,
        image: user.image,
        username: userProfile.username,
        areaLocation: userProfile.areaLocation,
        coachStudentRole: userProfile.coachStudentRole,
      })
      .from(user)
      .leftJoin(userProfile, eq(user.id, userProfile.userId))
      .where(inArray(user.id, studentIds));

    const pendingReviews = await db.query.coachVideoReview.findMany({
      where: (r, { and: _and, eq: _eq, inArray: _inArray }) =>
        _and(
          _eq(r.coachUserId, coachUserId),
          _eq(r.status, "pending"),
          _inArray(r.studentUserId, studentIds)
        ),
      orderBy: (r, { desc: _desc }) => [_desc(r.createdAt)],
    });
    const pendingByStudent = new Map<string, string>();
    for (const r of pendingReviews) {
      if (!pendingByStudent.has(r.studentUserId)) {
        pendingByStudent.set(r.studentUserId, r.id);
      }
    }

    const now = new Date();
    const dayUtc = now.getUTCDay();
    const diffToMonday = (dayUtc + 6) % 7;
    const thisWeekStart = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() - diffToMonday,
        0,
        0,
        0,
        0
      )
    );
    const nextWeekStart = new Date(thisWeekStart);
    nextWeekStart.setUTCDate(nextWeekStart.getUTCDate() + 7);
    const prevWeekStart = new Date(thisWeekStart);
    prevWeekStart.setUTCDate(prevWeekStart.getUTCDate() - 7);

    const scoreRows = await db
      .select({
        userId: techniqueAnalysis.userId,
        createdAt: techniqueAnalysis.createdAt,
        metrics: techniqueAnalysis.metrics,
      })
      .from(techniqueAnalysis)
      .where(
        and(
          inArray(techniqueAnalysis.userId, studentIds),
          gte(techniqueAnalysis.createdAt, prevWeekStart),
          lt(techniqueAnalysis.createdAt, nextWeekStart)
        )
      );

    const scoreAgg = new Map<
      string,
      { thisSum: number; thisCount: number; prevSum: number; prevCount: number }
    >();
    for (const row of scoreRows) {
      const metrics = row.metrics as Record<string, unknown> | null | undefined;
      const ai = metrics?.ai_analysis as Record<string, unknown> | undefined;
      const score0to10 = typeof ai?.score === "number" ? Number(ai.score) : null;
      if (score0to10 == null || !Number.isFinite(score0to10)) continue;
      const score0to100 = Math.round(Math.max(0, Math.min(100, score0to10 * 10)));
      const cur = scoreAgg.get(row.userId) ?? {
        thisSum: 0,
        thisCount: 0,
        prevSum: 0,
        prevCount: 0,
      };
      if (row.createdAt >= thisWeekStart && row.createdAt < nextWeekStart) {
        cur.thisSum += score0to100;
        cur.thisCount += 1;
      } else if (row.createdAt >= prevWeekStart && row.createdAt < thisWeekStart) {
        cur.prevSum += score0to100;
        cur.prevCount += 1;
      }
      scoreAgg.set(row.userId, cur);
    }

    return res.json({
      students: rows.map((r) => ({
        ...(function () {
          const agg = scoreAgg.get(r.id);
          const currentWeekScore =
            agg && agg.thisCount > 0 ? Math.round(agg.thisSum / agg.thisCount) : 0;
          const lastWeekScore =
            agg && agg.prevCount > 0 ? Math.round(agg.prevSum / agg.prevCount) : 0;
          return { currentWeekScore, lastWeekScore };
        })(),
        id: r.id,
        name: r.name,
        image: r.image ?? null,
        username: r.username ?? null,
        areaLocation: r.areaLocation?.trim() || null,
        coachStudentRole: normalizeCoachStudentRole(r.coachStudentRole),
        pendingCoachReviewId: pendingByStudent.get(r.id) ?? null,
      })),
    });
  } catch (e: any) {
    console.error("[Profile] coach-students GET error", e);
    return res.status(500).json({ error: "Failed to load coach students" });
  }
});

router.get("/student-coaches", async (req, res) => {
  try {
    const studentUserId = await resolveUserId(req);
    if (!studentUserId) return res.status(401).json({ error: "Unauthorized" });

    const links = await db.query.coachStudent.findMany({
      where: (cs, { eq: _eq }) => _eq(cs.studentUserId, studentUserId),
    });
    const coachIds = Array.from(new Set(links.map((l) => l.coachUserId).filter(Boolean)));
    if (coachIds.length === 0) {
      return res.json({ coaches: [] });
    }

    const rows = await db
      .select({
        id: user.id,
        name: user.name,
        image: user.image,
      })
      .from(user)
      .where(inArray(user.id, coachIds));

    return res.json({
      coaches: rows.map((r) => ({
        id: r.id,
        name: r.name,
        image: r.image ?? null,
      })),
    });
  } catch (e: any) {
    console.error("[Profile] student-coaches GET error", e);
    return res.status(500).json({ error: "Failed to load coaches" });
  }
});

router.post("/coach-students", async (req, res) => {
  try {
    const coachUserId = await resolveUserId(req);
    if (!coachUserId) return res.status(401).json({ error: "Unauthorized" });

    const role = await getCoachStudentRole(coachUserId);
    if (role !== "coach") {
      return res.status(403).json({ error: "Only coaches can add students" });
    }

    const studentUserId = String(req.body?.studentUserId || "").trim();
    if (!studentUserId) return res.status(400).json({ error: "studentUserId is required" });
    if (studentUserId === coachUserId) {
      return res.status(400).json({ error: "Cannot add yourself as a student" });
    }

    const student = await db.query.user.findFirst({
      where: (u, { eq: _eq }) => _eq(u.id, studentUserId),
    });
    if (!student) return res.status(404).json({ error: "Student not found" });

    await db
      .insert(coachStudent)
      .values({
        id: randomUUID(),
        coachUserId,
        studentUserId,
      })
      .onConflictDoNothing();

    const studentRole = await getCoachStudentRole(studentUserId);
    if (studentRole !== "coach") {
      await setCoachStudentRole(studentUserId, "student");
    }

    return res.json({ ok: true });
  } catch (e: any) {
    console.error("[Profile] coach-students POST error", e);
    return res.status(500).json({ error: "Failed to add student" });
  }
});

router.post("/promote-student-to-coach", async (req, res) => {
  try {
    const coachUserId = await resolveUserId(req);
    if (!coachUserId) return res.status(401).json({ error: "Unauthorized" });

    const role = await getCoachStudentRole(coachUserId);
    if (role !== "coach") {
      return res.status(403).json({ error: "Only coaches can promote students" });
    }

    const targetUserId = String(req.body?.targetUserId || "").trim();
    if (!targetUserId) return res.status(400).json({ error: "targetUserId is required" });

    const relation = await db.query.coachStudent.findFirst({
      where: (cs, { eq: _eq, and: _and }) =>
        _and(_eq(cs.coachUserId, coachUserId), _eq(cs.studentUserId, targetUserId)),
    });
    if (!relation) {
      return res.status(404).json({ error: "This user is not in your student list" });
    }

    await setCoachStudentRole(targetUserId, "coach");
    return res.json({ ok: true });
  } catch (e: any) {
    console.error("[Profile] promote-student-to-coach error", e);
    return res.status(500).json({ error: "Failed to promote student" });
  }
});

router.post("/admin-grant-coach", async (req, res) => {
  try {
    const userId = await resolveUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const providedPassword = String(req.headers["x-xevo-admin-hub-password"] || "").trim();
    if (!providedPassword || providedPassword !== ADMIN_HUB_GATE_PASSWORD) {
      return res.status(403).json({ error: "Invalid admin password" });
    }

    const targetUserId = String(req.body?.targetUserId || "").trim();
    if (!targetUserId) return res.status(400).json({ error: "targetUserId is required" });

    const target = await db.query.user.findFirst({
      where: (u, { eq: _eq }) => _eq(u.id, targetUserId),
    });
    if (!target) return res.status(404).json({ error: "User not found" });

    await setCoachStudentRole(targetUserId, "coach");
    return res.json({ ok: true });
  } catch (e: any) {
    console.error("[Profile] admin-grant-coach error", e);
    return res.status(500).json({ error: "Failed to set coach role" });
  }
});

async function coachStudentLinkForPeer(requesterId: string, peerUserId: string) {
  return db.query.coachStudent.findFirst({
    where: (cs, { or, and, eq: _eq }) =>
      or(
        and(_eq(cs.coachUserId, requesterId), _eq(cs.studentUserId, peerUserId)),
        and(_eq(cs.studentUserId, requesterId), _eq(cs.coachUserId, peerUserId))
      ),
  });
}

async function ensureCoachStudentChatRow(coachStudentId: string): Promise<string> {
  const existing = await db
    .select({ id: coachStudentChat.id })
    .from(coachStudentChat)
    .where(eq(coachStudentChat.coachStudentId, coachStudentId))
    .limit(1);
  if (existing[0]?.id) return existing[0].id;
  const id = randomUUID();
  const now = new Date();
  await db.insert(coachStudentChat).values({
    id,
    coachStudentId,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

/** Private coach ↔ student messages (one chat per `coach_student` row). */
router.get("/coach-student-chat/:peerUserId/messages", async (req, res) => {
  try {
    const requesterId = await resolveUserId(req);
    if (!requesterId) return res.status(401).json({ error: "Unauthorized" });

    const peerUserId = String(req.params?.peerUserId || "").trim();
    if (!peerUserId) return res.status(400).json({ error: "Missing peer user id" });

    const link = await coachStudentLinkForPeer(requesterId, peerUserId);
    if (!link) {
      return res.status(403).json({ error: "No coach-student link with this user" });
    }

    const chatId = await ensureCoachStudentChatRow(link.id);
    const rows = await db
      .select()
      .from(coachStudentChatMessage)
      .where(eq(coachStudentChatMessage.chatId, chatId))
      .orderBy(desc(coachStudentChatMessage.createdAt))
      .limit(200);

    const chronological = [...rows].reverse();
    return res.json({ chatId, messages: chronological });
  } catch (e: any) {
    console.error("[Profile] coach-student-chat GET error", e);
    return res.status(500).json({ error: "Failed to load messages" });
  }
});

router.post("/coach-student-chat/:peerUserId/messages", async (req, res) => {
  try {
    const requesterId = await resolveUserId(req);
    if (!requesterId) return res.status(401).json({ error: "Unauthorized" });

    const peerUserId = String(req.params?.peerUserId || "").trim();
    if (!peerUserId) return res.status(400).json({ error: "Missing peer user id" });

    const bodyText = String((req.body as { body?: unknown })?.body ?? "").trim();
    if (!bodyText) return res.status(400).json({ error: "body is required" });
    if (bodyText.length > 8000) return res.status(400).json({ error: "Message too long" });

    const link = await coachStudentLinkForPeer(requesterId, peerUserId);
    if (!link) {
      return res.status(403).json({ error: "No coach-student link with this user" });
    }

    const chatId = await ensureCoachStudentChatRow(link.id);
    const msgId = randomUUID();
    const now = new Date();
    await db.insert(coachStudentChatMessage).values({
      id: msgId,
      chatId,
      senderUserId: requesterId,
      kind: "text",
      body: bodyText,
      createdAt: now,
    });
    await db
      .update(coachStudentChat)
      .set({ lastMessageAt: now, updatedAt: now })
      .where(eq(coachStudentChat.id, chatId));

    return res.json({
      message: {
        id: msgId,
        chatId,
        senderUserId: requesterId,
        kind: "text",
        body: bodyText,
        createdAt: now.toISOString(),
      },
    });
  } catch (e: any) {
    console.error("[Profile] coach-student-chat POST error", e);
    return res.status(500).json({ error: "Failed to send message" });
  }
});

router.get("/notifications", async (req, res) => {
  try {
    const userId = await resolveUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const notifications = await db.query.userNotification.findMany({
      where: (n, { eq: _eq }) => _eq(n.userId, userId),
      orderBy: (n, { desc: _desc }) => [_desc(n.createdAt)],
      limit: 200,
    });

    return res.json({ notifications });
  } catch (e: any) {
    console.error("[Profile] notifications GET error", e);
    return res.status(500).json({ error: "Failed to load notifications" });
  }
});

router.post("/notifications/:id/read", async (req, res) => {
  try {
    const userId = await resolveUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const id = String(req.params?.id || "").trim();
    if (!id) return res.status(400).json({ error: "Missing notification id" });

    const row = await db.query.userNotification.findFirst({
      where: (n, { and: _and, eq: _eq }) =>
        _and(_eq(n.id, id), _eq(n.userId, userId)),
    });
    if (!row) return res.status(404).json({ error: "Notification not found" });

    if (!row.readAt) {
      await db
        .update(userNotification)
        .set({ readAt: new Date() })
        .where(and(eq(userNotification.id, id), eq(userNotification.userId, userId)));
    }

    return res.json({ ok: true });
  } catch (e: any) {
    console.error("[Profile] notifications read error", e);
    return res.status(500).json({ error: "Failed to mark notification read" });
  }
});

export default router;
