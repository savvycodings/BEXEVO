/**
 * Training dataset uploads (admin-only via X-Admin-Train-Secret).
 *
 * Parallels technique video storage:
 * - POST multipart: video + viewProfile + category + strokePreset + skillLevel (strokeName is derived for Modal)
 * - File written under uploads/train/{id}{ext}
 * - Row in train_video; public path /train/video/:id (also served under /api/auth/train/video/:id)
 * - GET streams bytes with Range support like techniqueRouter /video/:id
 */
import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "../auth";
import { db, trainSample, trainVideo, trainVideoViewProfile } from "../db";
import { eq } from "drizzle-orm";
import {
  runTrainEmbeddingBackfill,
  indexTrainSampleEmbeddingIfReady,
} from "../technique/trainRetrieval";

const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_VIDEO_BYTES },
  fileFilter: (_req, file, cb) => {
    const allowed = ["video/mp4", "video/quicktime"];
    if (allowed.includes(file.mimetype)) return cb(null, true);
    cb(new Error("Only MP4 and MOV videos up to 50MB are allowed"));
  },
});

const UPLOAD_ROOT = path.join(process.cwd(), "uploads", "train");
const ADMIN_SECRET = (): string =>
  (process.env.ADMIN_TRAIN_SECRET || "xevodev").trim();
const TRAIN_MODAL_WEBHOOK_URL = (): string =>
  (process.env.TRAIN_MODAL_WEBHOOK_URL || "").trim();

const router = express.Router();
router.use(express.json({ limit: "2mb" }));
router.use(express.urlencoded({ extended: true }));
type TrainViewProfile = "front" | "side" | "behind";

const TRAIN_CATEGORIES = [
  "ground_strokes",
  "net_play",
  "defence_glass",
  "save_return",
  "overhead",
  "tactical_specials",
] as const;
type TrainCategory = (typeof TRAIN_CATEGORIES)[number];

const TRAIN_STROKE_PRESETS = [
  "forehand_drive",
  "backhand_drive",
  "forehand_lob",
  "backhand_lob",
] as const;
type TrainStrokePreset = (typeof TRAIN_STROKE_PRESETS)[number];

const TRAIN_SKILL_LEVELS = ["beginner", "intermediate", "advanced"] as const;
type TrainSkillLevel = (typeof TRAIN_SKILL_LEVELS)[number];

const CATEGORY_LABEL: Record<TrainCategory, string> = {
  ground_strokes: "Ground strokes",
  net_play: "Net play",
  defence_glass: "Defence & glass",
  save_return: "Save & return",
  overhead: "Overhead",
  tactical_specials: "Tactical specials",
};

const PRESET_LABEL: Record<TrainStrokePreset, string> = {
  forehand_drive: "Forehand drive",
  backhand_drive: "Backhand drive",
  forehand_lob: "Forehand lob",
  backhand_lob: "Backhand lob",
};

const LEVEL_LABEL: Record<TrainSkillLevel, string> = {
  beginner: "Beginner",
  intermediate: "Intermediate",
  advanced: "Advanced",
};

function parseViewProfile(raw: unknown): TrainViewProfile | null {
  const v = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (v === "front" || v === "side" || v === "behind") return v;
  return null;
}

function parseCategory(raw: unknown): TrainCategory | null {
  const v = String(raw ?? "").trim();
  return (TRAIN_CATEGORIES as readonly string[]).includes(v) ? (v as TrainCategory) : null;
}

function parseStrokePreset(raw: unknown): TrainStrokePreset | null {
  const v = String(raw ?? "").trim();
  return (TRAIN_STROKE_PRESETS as readonly string[]).includes(v) ? (v as TrainStrokePreset) : null;
}

function parseSkillLevel(raw: unknown): TrainSkillLevel | null {
  const v = String(raw ?? "").trim();
  return (TRAIN_SKILL_LEVELS as readonly string[]).includes(v) ? (v as TrainSkillLevel) : null;
}

/** Single line for strokeName column + Modal movement_label (Modal contract unchanged). */
function buildMovementLabel(
  preset: TrainStrokePreset,
  category: TrainCategory,
  level: TrainSkillLevel
): string {
  return `${PRESET_LABEL[preset]} · ${CATEGORY_LABEL[category]} · ${LEVEL_LABEL[level]}`;
}

function getPublicVideoBase(): string {
  const publicVideoBase = (process.env.PUBLIC_VIDEO_BASE_URL || "").trim();
  const publicBase = (process.env.PUBLIC_BASE_URL || "").trim();
  const authBase = (process.env.BETTER_AUTH_URL || "").trim();
  return publicVideoBase || publicBase || authBase || "http://localhost:3050";
}

async function triggerTrainExtraction(params: {
  sampleId: string;
  trainVideoId: string;
  strokeName: string;
  videoPublicPath: string;
}): Promise<void> {
  const modalUrl = TRAIN_MODAL_WEBHOOK_URL();
  if (!modalUrl) {
    console.warn("[Train] TRAIN_MODAL_WEBHOOK_URL missing; sample left queued", {
      sampleId: params.sampleId,
    });
    return;
  }

  const baseUrl = getPublicVideoBase().replace(/\/+$/, "");
  const videoUrl = params.videoPublicPath.startsWith("http")
    ? params.videoPublicPath
    : `${baseUrl}${params.videoPublicPath.startsWith("/") ? "" : "/"}${params.videoPublicPath}`;

  if (
    !/localhost|127\.0\.0\.1/i.test(modalUrl) &&
    /localhost|127\.0\.0\.1/i.test(videoUrl)
  ) {
    console.error("[Train] Modal cannot reach local video URL; marking sample failed", {
      sampleId: params.sampleId,
      videoUrl,
    });
    await db
      .update(trainSample)
      .set({
        status: "failed",
        errorMessage:
          "Server misconfiguration: set PUBLIC_VIDEO_BASE_URL (or PUBLIC_BASE_URL) to a public URL reachable by Modal.",
      })
      .where(eq(trainSample.id, params.sampleId));
    return;
  }

  void fetch(modalUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      video_url: videoUrl,
      sample_id: params.sampleId,
      movement_label: params.strokeName,
      train_video_id: params.trainVideoId,
    }),
  })
    .then(async (r) => {
      const body = (await r.json().catch(() => null)) as any;
      console.log("[Train] Modal trigger response", {
        sampleId: params.sampleId,
        statusCode: r.status,
        bodyStatus: body?.status,
        bodyMessage: body?.message ?? null,
      });
      if (!r.ok || body?.status === "error") {
        await db
          .update(trainSample)
          .set({
            status: "failed",
            errorMessage:
              body?.message ||
              `Modal trigger failed with HTTP ${r.status}`,
          })
          .where(eq(trainSample.id, params.sampleId));
      } else if (body?.status === "success") {
        await indexTrainSampleEmbeddingIfReady(params.sampleId);
      }
    })
    .catch(async (err: any) => {
      console.error("[Train] Modal trigger exception", {
        sampleId: params.sampleId,
        message: err?.message ?? String(err),
      });
      await db
        .update(trainSample)
        .set({
          status: "failed",
          errorMessage: err?.message || "Modal request failed",
        })
        .where(eq(trainSample.id, params.sampleId));
    });
}

function assertAdminTrain(req: express.Request, res: express.Response): boolean {
  const expected = ADMIN_SECRET();
  const raw = req.headers["x-admin-train-secret"];
  const provided = typeof raw === "string" ? raw : raw?.[0] ?? "";
  if (!provided || provided !== expected) {
    console.log("[Train] Upload rejected: X-Admin-Train-Secret missing or wrong", {
      hasHeader: !!provided,
    });
    res.status(403).json({ error: "Forbidden" });
    return false;
  }
  return true;
}

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

/** Multer errors (size limit, wrong type) skip the route handler unless we catch them here. */
function parseTrainVideo(req: express.Request, res: express.Response, next: express.NextFunction) {
  upload.single("video")(req, res, (err: unknown) => {
    if (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = (err as { code?: string })?.code;
      console.error("[Train] Multer rejected upload:", { message: msg, code });
      return res.status(400).json({ error: msg || "Invalid upload" });
    }
    next();
  });
}

router.post("/upload", parseTrainVideo, async (req, res) => {
  try {
    console.log("[Train] Upload request received", {
      hasAuthHeader: !!req.headers.authorization,
      hasCookie: !!req.headers.cookie,
      contentType: req.headers["content-type"]?.slice(0, 60) ?? null,
    });

    if (!assertAdminTrain(req, res)) return;

    const userId = await resolveUserId(req);
    if (!userId) {
      console.log("[Train] Upload rejected: no session / unknown user");
      return res.status(401).json({ error: "Unauthorized" });
    }

    const category = parseCategory(req.body?.category);
    if (!category) {
      return res.status(400).json({
        error:
          "category must be one of: ground_strokes, net_play, defence_glass, save_return, overhead, tactical_specials",
      });
    }
    const strokePreset = parseStrokePreset(req.body?.strokePreset);
    if (!strokePreset) {
      return res.status(400).json({
        error:
          "strokePreset must be one of: forehand_drive, backhand_drive, forehand_lob, backhand_lob",
      });
    }
    const skillLevel = parseSkillLevel(req.body?.skillLevel);
    if (!skillLevel) {
      return res.status(400).json({
        error: "skillLevel must be one of: beginner, intermediate, advanced",
      });
    }
    const strokeName = buildMovementLabel(strokePreset, category, skillLevel);
    const viewProfile = parseViewProfile(req.body?.viewProfile);
    if (!viewProfile) {
      console.log("[Train] Upload rejected: invalid viewProfile", {
        raw: req.body?.viewProfile,
      });
      return res.status(400).json({ error: "viewProfile must be one of front, side, behind" });
    }

    if (!req.file?.buffer) {
      console.log("[Train] Upload rejected: no video file in multipart", {
        hasFile: !!req.file,
        fieldname: req.file?.fieldname,
        originalname: req.file?.originalname,
        mimetype: req.file?.mimetype,
        size: req.file?.size,
      });
      return res.status(400).json({ error: "No video file" });
    }

    console.log("[Train] Accepting upload", {
      userId: `${userId.slice(0, 8)}…`,
      category,
      strokePreset,
      skillLevel,
      strokeName,
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
      sizeBytes: req.file.size,
    });

    if (!fs.existsSync(UPLOAD_ROOT)) {
      fs.mkdirSync(UPLOAD_ROOT, { recursive: true });
      console.log("[Train] Created upload dir:", UPLOAD_ROOT);
    }

    const id = randomUUID();
    const ext = path.extname(req.file.originalname || "") || ".mp4";
    const filePath = path.join(UPLOAD_ROOT, `${id}${ext}`);

    console.log("[Train] Writing video to disk…", { filePath });
    await fs.promises.writeFile(filePath, req.file.buffer);

    const publicPath = `/train/video/${id}`;

    await db.insert(trainVideo).values({
      id,
      userId,
      strokeName,
      category,
      strokePreset,
      skillLevel,
      cloudinaryPublicId: filePath,
      cloudinaryUrl: publicPath,
      secureUrl: publicPath,
      bytes: String(req.file.size ?? ""),
      format: ext.replace(".", "") || undefined,
    });
    const viewProfileId = randomUUID();
    await db.insert(trainVideoViewProfile).values({
      id: viewProfileId,
      trainVideoId: id,
      viewProfile,
    });
    const sampleId = randomUUID();
    await db.insert(trainSample).values({
      id: sampleId,
      trainVideoId: id,
      userId,
      strokeNameSnapshot: strokeName,
      status: "queued",
    });

    console.log("[Train] Upload OK — saved and DB row inserted", {
      id,
      category,
      strokePreset,
      skillLevel,
      strokeName,
      viewProfile,
      sampleId,
      publicPath,
      bytes: req.file.size,
    });

    await triggerTrainExtraction({
      sampleId,
      trainVideoId: id,
      strokeName,
      videoPublicPath: publicPath,
    });

    return res.json({
      id,
      sampleId,
      url: publicPath,
      strokeName,
      category,
      strokePreset,
      skillLevel,
      viewProfile,
      message:
        "Stored for training and queued for extraction. DELETE /train/video/:id with admin header to remove.",
    });
  } catch (e: any) {
    console.error("[Train] Upload error (exception):", e?.message ?? e, e?.stack);
    if (e.message?.includes("Only MP4 and MOV")) {
      return res.status(400).json({ error: e.message });
    }
    return res.status(500).json({ error: e.message || "Upload failed" });
  }
});

router.delete("/video/:id", async (req, res) => {
  try {
    if (!assertAdminTrain(req, res)) return;

    const userId = await resolveUserId(req);
    if (!userId) {
      console.log("[Train] Delete rejected: no session");
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { id } = req.params;
    if (!id) return res.status(400).json({ error: "Missing id" });

    console.log("[Train] Delete request", { id, userId: `${userId.slice(0, 8)}…` });

    const row = await db.query.trainVideo.findFirst({
      where: (tv, { and, eq: _eq }) => and(_eq(tv.id, id), _eq(tv.userId, userId)),
    });

    if (!row) {
      console.log("[Train] Delete: not found or wrong owner", { id });
      return res.status(404).json({ error: "Not found" });
    }

    const filePath = row.cloudinaryPublicId;
    try {
      if (filePath && fs.existsSync(filePath)) {
        await fs.promises.unlink(filePath);
        console.log("[Train] Deleted file from disk", { filePath });
      } else {
        console.warn("[Train] Delete: no file on disk (continuing)", { filePath });
      }
    } catch (unlinkErr) {
      console.warn("[Train] File unlink failed", unlinkErr);
    }

    await db.delete(trainVideo).where(eq(trainVideo.id, id));
    console.log("[Train] Delete OK", { id });
    return res.json({ ok: true });
  } catch (e: any) {
    console.error("[Train] Delete error:", e);
    return res.status(500).json({ error: "Delete failed" });
  }
});

router.get("/video/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: "Missing id" });

    const video = await db.query.trainVideo.findFirst({
      where: (tv, { eq: _eq }) => _eq(tv.id, id),
    });

    if (!video?.cloudinaryPublicId) {
      console.log("[Train] Stream 404: no DB row", { id });
      return res.status(404).json({ error: "Video not found" });
    }

    const filePath = video.cloudinaryPublicId;
    if (!fs.existsSync(filePath)) {
      console.warn("[Train] Stream 404: DB row exists but file missing", { id, filePath });
      return res.status(404).json({ error: "Video file missing" });
    }

    const ext = path.extname(filePath).toLowerCase();
    let mime = "application/octet-stream";
    if (ext === ".mp4") mime = "video/mp4";
    else if (ext === ".mov" || ext === ".qt") mime = "video/quicktime";

    const stat = await fs.promises.stat(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (process.env.DEBUG_TRAIN_STREAM === "1") {
      console.log("[Train] Stream", { id, range: range ?? null, fileSize });
    }

    res.setHeader("Content-Type", mime);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "public, max-age=3600");

    if (range) {
      const matches = /bytes=(\d*)-(\d*)/.exec(range);
      const start = matches?.[1] ? parseInt(matches[1], 10) : 0;
      const end = matches?.[2] ? parseInt(matches[2], 10) : fileSize - 1;

      const safeStart = Number.isFinite(start) ? Math.max(0, start) : 0;
      const safeEnd = Number.isFinite(end) ? Math.min(end, fileSize - 1) : fileSize - 1;

      if (safeStart > safeEnd || safeStart >= fileSize) {
        res.status(416).setHeader("Content-Range", `bytes */${fileSize}`);
        return res.end();
      }

      const chunkSize = safeEnd - safeStart + 1;
      res.status(206);
      res.setHeader("Content-Range", `bytes ${safeStart}-${safeEnd}/${fileSize}`);
      res.setHeader("Content-Length", chunkSize.toString());
      const stream = fs.createReadStream(filePath, { start: safeStart, end: safeEnd });
      stream.pipe(res);
      return;
    }

    res.setHeader("Content-Length", fileSize.toString());
    fs.createReadStream(filePath).pipe(res);
  } catch (e: any) {
    console.error("[Train] Stream error:", e);
    return res.status(500).json({ error: "Failed to stream video" });
  }
});

/** Build pgvector rows for all completed train_sample pose sequences (admin). Run after migration 0011 + Neon `vector` extension. */
router.post("/embeddings/backfill", async (req, res) => {
  try {
    if (!assertAdminTrain(req, res)) return;
    const userId = await resolveUserId(req);
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const out = await runTrainEmbeddingBackfill();
    return res.json({
      ok: true,
      ...out,
      specVersion: "v1",
      dims: 128,
    });
  } catch (e: any) {
    console.error("[Train] Embeddings backfill error:", e);
    return res.status(500).json({
      error: e?.message || "Backfill failed",
      hint: "Ensure migration 0011 ran and CREATE EXTENSION vector is allowed on this database.",
    });
  }
});

router.get("/sample/:id", async (req, res) => {
  try {
    if (!assertAdminTrain(req, res)) return;
    const userId = await resolveUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const { id } = req.params;
    if (!id) return res.status(400).json({ error: "Missing id" });

    const row = await db.query.trainSample.findFirst({
      where: (ts, { and, eq: _eq }) => and(_eq(ts.id, id), _eq(ts.userId, userId)),
    });
    if (!row) return res.status(404).json({ error: "Not found" });
    return res.json(row);
  } catch (e: any) {
    console.error("[Train] Sample fetch error:", e);
    return res.status(500).json({ error: "Failed to fetch sample" });
  }
});

export default router;
