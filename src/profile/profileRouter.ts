import express from "express";
import fs from "fs";
import path from "path";
import multer from "multer";
import { randomUUID } from "crypto";
import { fromNodeHeaders } from "better-auth/node";
import { eq, inArray } from "drizzle-orm";
import { auth } from "../auth";
import { db, user, userProfile, coachStudent } from "../db";

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

    const now = new Date();

    await db
      .insert(userProfile)
      .values({
        userId,
        username,
        gender,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: userProfile.userId,
        set: {
          username,
          gender,
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
        coachStudentRole: userProfile.coachStudentRole,
      })
      .from(user)
      .leftJoin(userProfile, eq(user.id, userProfile.userId))
      .where(inArray(user.id, studentIds));

    return res.json({
      students: rows.map((r) => ({
        id: r.id,
        name: r.name,
        image: r.image ?? null,
        username: r.username ?? null,
        coachStudentRole: normalizeCoachStudentRole(r.coachStudentRole),
        pendingCoachReviewId: null,
      })),
    });
  } catch (e: any) {
    console.error("[Profile] coach-students GET error", e);
    return res.status(500).json({ error: "Failed to load coach students" });
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

export default router;
