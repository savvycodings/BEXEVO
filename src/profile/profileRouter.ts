import express from "express";
import fs from "fs";
import path from "path";
import multer from "multer";
import { randomUUID } from "crypto";
import { fromNodeHeaders } from "better-auth/node";
import { eq } from "drizzle-orm";
import { auth } from "../auth";
import { db, user, userProfile } from "../db";

const router = express.Router();
router.use(express.json());
router.use(express.urlencoded({ extended: true }));
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});

const PROFILE_UPLOAD_ROOT = path.join(process.cwd(), "uploads", "profile");

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

export default router;
