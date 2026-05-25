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
import {
  trainCategoryEnum,
  trainSkillLevelEnum,
  trainStrokePresetEnum,
} from "../db/schema";
import { eq } from "drizzle-orm";
import {
  runTrainEmbeddingBackfill,
  indexTrainSampleEmbeddingIfReady,
} from "../technique/trainRetrieval";
import falLoraRouter from "./falLoraRouter";
import { fal } from "@fal-ai/client";

function resolveFalKey(): string {
  return String(process.env.FAL_API_KEY || process.env.FAL_KEY || "").trim();
}

/** Stage local train clip on fal CDN so Modal can GET bytes (ngrok often 404s server-side). */
async function uploadTrainVideoToFalCdn(absPath: string): Promise<string> {
  const key = resolveFalKey();
  if (!key) throw new Error("FAL_KEY or FAL_API_KEY is not set");
  fal.config({ credentials: key });
  const buf = await fs.promises.readFile(absPath);
  const ext = path.extname(absPath).toLowerCase();
  const contentType =
    ext === ".mp4"
      ? "video/mp4"
      : ext === ".mov"
        ? "video/quicktime"
        : "application/octet-stream";
  const blob = new Blob([buf], { type: contentType });
  return fal.storage.upload(blob, { lifecycle: { expiresIn: "1d" } });
}

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
/** Strip surrounding quotes from .env values (e.g. `"https://....modal.run/"`). */
function TRAIN_MODAL_WEBHOOK_URL(): string {
  let url = (process.env.TRAIN_MODAL_WEBHOOK_URL || "").trim();
  if (
    (url.startsWith('"') && url.endsWith('"')) ||
    (url.startsWith("'") && url.endsWith("'"))
  ) {
    url = url.slice(1, -1).trim();
  }
  return url;
}

async function markTrainSampleFailed(
  sampleId: string,
  errorMessage: string
): Promise<void> {
  await db
    .update(trainSample)
    .set({ status: "failed", errorMessage })
    .where(eq(trainSample.id, sampleId));
}

const router = express.Router();
router.use(express.json({ limit: "2mb" }));
router.use(express.urlencoded({ extended: true }));
type TrainViewProfile = "front" | "side" | "behind";

// fal.ai LoRA dataset + training routes (admin header required)
router.use("/fal-lora", falLoraRouter);

/** Allowlists must match `train_*` enums in schema.ts and `app/src/lib/train-taxonomy.ts`. */
const TRAIN_CATEGORIES = trainCategoryEnum.enumValues;
type TrainCategory = (typeof TRAIN_CATEGORIES)[number];

const TRAIN_STROKE_PRESETS = trainStrokePresetEnum.enumValues;
type TrainStrokePreset = (typeof TRAIN_STROKE_PRESETS)[number];

const TRAIN_SKILL_LEVELS = trainSkillLevelEnum.enumValues;
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
  forehand_chiquita: "Forehand chiquita",
  backhand_drive_with_wall: "Backhand drive (wall)",
  forehand_volley: "Forehand volley",
  backhand_volley: "Backhand volley",
  half_volley: "Half volley",
  backhand_return: "Backhand return",
  backhand_return_with_lob: "Backhand return with lob",
  forehand_return_with_lob: "Forehand return with lob",
  back_wall_backhand: "Back wall backhand",
  back_wall_forehand: "Back wall forehand",
  side_wall_backhand: "Side wall backhand",
  side_wall_forehand: "Side wall forehand",
  contrapared_boast: "Contrapared boast",
  bandeja: "Bandeja",
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
  return TRAIN_CATEGORIES.includes(v as TrainCategory) ? (v as TrainCategory) : null;
}

function parseStrokePreset(raw: unknown): TrainStrokePreset | null {
  const v = String(raw ?? "").trim();
  return TRAIN_STROKE_PRESETS.includes(v as TrainStrokePreset) ? (v as TrainStrokePreset) : null;
}

function parseSkillLevel(raw: unknown): TrainSkillLevel | null {
  const v = String(raw ?? "").trim();
  return TRAIN_SKILL_LEVELS.includes(v as TrainSkillLevel) ? (v as TrainSkillLevel) : null;
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

/**
 * POST train clip to Modal `process_video` (padel-trainset). Awaits full extraction like AI Coach analyze.
 * Throws on misconfiguration or Modal error so upload can return 500.
 */
async function triggerTrainExtraction(params: {
  sampleId: string;
  trainVideoId: string;
  strokeName: string;
  videoPublicPath: string;
  /** Absolute path on disk; staged on fal CDN for remote Modal when FAL_KEY is set. */
  videoAbsPath: string;
}): Promise<void> {
  const modalUrl = TRAIN_MODAL_WEBHOOK_URL();
  if (!modalUrl) {
    const msg = "TRAIN_MODAL_WEBHOOK_URL is not configured on the server.";
    await markTrainSampleFailed(params.sampleId, msg);
    throw new Error(msg);
  }

  const baseUrl = getPublicVideoBase().replace(/\/+$/, "");
  let videoUrl = params.videoPublicPath.startsWith("http")
    ? params.videoPublicPath
    : `${baseUrl}${params.videoPublicPath.startsWith("/") ? "" : "/"}${params.videoPublicPath}`;

  const modalRemote =
    !modalUrl.includes("localhost") && !/127\.0\.0\.1/i.test(modalUrl);
  const hasLocalFile =
    Boolean(params.videoAbsPath) && fs.existsSync(params.videoAbsPath);
  const falKey = resolveFalKey();

  if (modalRemote && hasLocalFile && falKey) {
    try {
      console.log("[Train] Staging train video via fal.storage for Modal", {
        sampleId: params.sampleId,
        videoAbsPath: params.videoAbsPath,
      });
      videoUrl = await uploadTrainVideoToFalCdn(params.videoAbsPath);
    } catch (e: unknown) {
      console.error("[Train] fal.storage upload failed (train Modal)", e);
      const msg =
        "Could not stage train video for Modal (fal upload failed). Check FAL_KEY and logs.";
      await markTrainSampleFailed(params.sampleId, msg);
      throw new Error(msg);
    }
  } else if (modalRemote && hasLocalFile && !falKey) {
    console.warn(
      "[Train] Modal is remote but FAL_KEY is unset; using public video URL (ngrok may block Modal). Set FAL_KEY to stage on fal CDN."
    );
  }

  if (modalRemote && /localhost|127\.0\.0\.1/i.test(videoUrl)) {
    const msg =
      "Video URL is not publicly reachable for Modal. Set PUBLIC_VIDEO_BASE_URL (or FAL_KEY for fal CDN staging).";
    console.error("[Train] Modal cannot reach local video URL", {
      sampleId: params.sampleId,
      videoUrl,
    });
    await markTrainSampleFailed(params.sampleId, msg);
    throw new Error(msg);
  }

  console.log("[Train] Calling Modal webhook...", {
    modalUrl,
    baseUrl,
    videoUrl,
    sampleId: params.sampleId,
    trainVideoId: params.trainVideoId,
  });

  const modalT0 = Date.now();
  let statusCode = 0;
  let body: { status?: string; message?: string } | null = null;
  try {
    const r = await fetch(modalUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        video_url: videoUrl,
        sample_id: params.sampleId,
        movement_label: params.strokeName,
        train_video_id: params.trainVideoId,
      }),
    });
    statusCode = r.status;
    body = (await r.json().catch(() => null)) as {
      status?: string;
      message?: string;
    } | null;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Modal request failed";
    console.error("[Train] Modal trigger exception", {
      sampleId: params.sampleId,
      message: msg,
    });
    await markTrainSampleFailed(params.sampleId, msg);
    throw new Error(msg);
  }

  console.log("[Train] Modal response", {
    sampleId: params.sampleId,
    statusCode,
    bodyStatus: body?.status,
    bodyMessage: body?.message ?? null,
    durationMs: Date.now() - modalT0,
  });

  if (!statusCode || statusCode < 200 || statusCode >= 300 || body?.status === "error") {
    const msg =
      body?.message?.trim() ||
      `Modal pose extraction failed (HTTP ${statusCode || "unknown"}).`;
    await markTrainSampleFailed(params.sampleId, msg);
    throw new Error(msg);
  }

  if (body?.status === "success") {
    await indexTrainSampleEmbeddingIfReady(params.sampleId);
    return;
  }

  const msg = body?.message?.trim() || "Modal returned an unexpected response.";
  await markTrainSampleFailed(params.sampleId, msg);
  throw new Error(msg);
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
        error: `strokePreset must be one of: ${TRAIN_STROKE_PRESETS.join(", ")}`,
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

    try {
      await triggerTrainExtraction({
        sampleId,
        trainVideoId: id,
        strokeName,
        videoPublicPath: publicPath,
        videoAbsPath: filePath,
      });
    } catch (modalErr: unknown) {
      const modalMessage =
        modalErr instanceof Error ? modalErr.message : "Modal pose extraction failed";
      console.error("[Train] Upload saved but Modal extraction failed", {
        sampleId,
        modalMessage,
      });
      return res.status(500).json({
        error: modalMessage,
        id,
        sampleId,
        url: publicPath,
      });
    }

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
        "Stored and pose extraction completed. DELETE /train/video/:id with admin header to remove.",
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

/**
 * Admin: list global train_video + train_sample + view coverage so UI shows what the
 * company model has already been trained on (not only one admin's uploads).
 */
router.get("/admin/pose-landmarks-coverage", async (req, res) => {
  try {
    if (!assertAdminTrain(req, res)) return;
    const userId = await resolveUserId(req);
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const rows = await db
      .select({
        sampleId: trainSample.id,
        trainVideoId: trainSample.trainVideoId,
        status: trainSample.status,
        frameCount: trainSample.frameCount,
        updatedAt: trainSample.updatedAt,
        category: trainVideo.category,
        strokePreset: trainVideo.strokePreset,
        skillLevel: trainVideo.skillLevel,
        strokeName: trainVideo.strokeName,
        viewProfile: trainVideoViewProfile.viewProfile,
      })
      .from(trainSample)
      .innerJoin(trainVideo, eq(trainSample.trainVideoId, trainVideo.id))
      .innerJoin(
        trainVideoViewProfile,
        eq(trainVideo.id, trainVideoViewProfile.trainVideoId)
      );

    type RowOut = {
      sampleId: string;
      trainVideoId: string;
      category: string;
      strokePreset: string;
      skillLevel: string;
      viewProfile: string;
      strokeName: string;
      status: string;
      poseFrameCount: number | null;
      poseLandmarksReady: boolean;
      updatedAt: string | null;
    };

    const coverage: RowOut[] = rows.map((r) => {
      const poseLandmarksReady =
        r.status === "completed" && Number(r.frameCount ?? 0) > 0;
      return {
        sampleId: r.sampleId,
        trainVideoId: r.trainVideoId,
        category: r.category,
        strokePreset: r.strokePreset,
        skillLevel: r.skillLevel,
        viewProfile: r.viewProfile,
        strokeName: r.strokeName,
        status: r.status,
        poseFrameCount: r.frameCount,
        poseLandmarksReady,
        updatedAt: r.updatedAt?.toISOString?.() ?? null,
      };
    });

    const comboKeys = new Set<string>();
    const categoryHasPoseLandmarks: Record<string, boolean> = {};
    for (const c of coverage) {
      if (c.poseLandmarksReady) {
        comboKeys.add(
          `${c.category}|${c.strokePreset}|${c.skillLevel}|${c.viewProfile}`
        );
        categoryHasPoseLandmarks[c.category] = true;
      }
    }

    // Return one row per trained combo (category + stroke + skill + view), latest first.
    const comboLatest = new Map<string, RowOut>();
    const comboSampleCounts = new Map<string, number>();
    for (const row of coverage) {
      if (!row.poseLandmarksReady) continue;
      const key = `${row.category}|${row.strokePreset}|${row.skillLevel}|${row.viewProfile}`;
      comboSampleCounts.set(key, (comboSampleCounts.get(key) ?? 0) + 1);
      const prev = comboLatest.get(key);
      if (
        !prev ||
        String(row.updatedAt ?? "").localeCompare(String(prev.updatedAt ?? "")) > 0
      ) {
        comboLatest.set(key, row);
      }
    }

    const trainedRows = Array.from(comboLatest.entries())
      .map(([key, row]) => ({
        ...row,
        // Keep payload self-descriptive in UI: how many completed samples feed this combo.
        sampleCount: comboSampleCounts.get(key) ?? 1,
      }))
      .sort((a, b) =>
        String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? ""))
      );

    return res.json({
      rows: trainedRows,
      comboKeys: Array.from(comboKeys),
      categoryHasPoseLandmarks,
    });
  } catch (e: any) {
    console.error("[Train] pose-landmarks-coverage error:", e);
    return res.status(500).json({ error: e?.message || "Failed" });
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
