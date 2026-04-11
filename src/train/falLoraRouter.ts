import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import archiver from "archiver";
import { fromNodeHeaders } from "better-auth/node";
import { eq, desc } from "drizzle-orm";
import { auth } from "../auth";
import {
  db,
  falLoraDataset,
  falLoraImage,
  falLoraTrainingRun,
} from "../db";

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 }, // per image
});

const ADMIN_SECRET = (): string =>
  (process.env.ADMIN_TRAIN_SECRET || "xevodev").trim();

function assertAdminTrain(req: express.Request, res: express.Response): boolean {
  const expected = ADMIN_SECRET();
  const raw = req.headers["x-admin-train-secret"];
  const provided = typeof raw === "string" ? raw : raw?.[0] ?? "";
  if (!provided || provided !== expected) {
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

function safeExtFromMime(mime: string | undefined): string {
  const m = String(mime || "").toLowerCase();
  if (m.includes("png")) return ".png";
  if (m.includes("webp")) return ".webp";
  return ".jpg";
}

function buildMovementLabel(params: {
  strokePreset: string;
  category: string;
  skillLevel: string;
}): string {
  // mirror trainRouter convention: "preset · category · level"
  const preset = params.strokePreset.replace(/_/g, " ");
  const cat = params.category.replace(/_/g, " ");
  const level = params.skillLevel.replace(/_/g, " ");
  return `${preset} · ${cat} · ${level}`;
}

const UPLOAD_ROOT = path.join(process.cwd(), "uploads", "fal-train");
const IMAGES_ROOT = path.join(UPLOAD_ROOT, "images");
const ZIPS_ROOT = path.join(UPLOAD_ROOT, "zips");

async function ensureDirs() {
  for (const p of [UPLOAD_ROOT, IMAGES_ROOT, ZIPS_ROOT]) {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  }
}

async function writeZipFromDataset(opts: {
  datasetId: string;
  files: Array<{ filePath: string; fileName: string; caption?: string | null }>;
}): Promise<{ zipAbsPath: string; zipPublicPath: string }> {
  await ensureDirs();
  const zipAbsPath = path.join(ZIPS_ROOT, `${opts.datasetId}.zip`);
  const zipPublicPath = `/uploads/fal-train/zips/${opts.datasetId}.zip`;

  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(zipAbsPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", () => resolve());
    output.on("error", (err: unknown) => reject(err));
    archive.on("error", (err: unknown) => reject(err));

    archive.pipe(output);
    for (const f of opts.files) {
      archive.file(f.filePath, { name: f.fileName });
      if (f.caption) {
        const base = f.fileName.replace(/\.[^.]+$/, "");
        archive.append(String(f.caption), { name: `${base}.txt` });
      }
    }
    void archive.finalize();
  });

  return { zipAbsPath, zipPublicPath };
}

/**
 * POST /train/fal-lora/dataset
 * multipart:
 * - images[]: one or more image files
 * - name: dataset name
 * - triggerWord (optional)
 * - isStyle: "true" | "false"
 * - category, strokePreset, skillLevel, viewProfile (optional viewProfile)
 */
router.post(
  "/dataset",
  upload.array("images", 30),
  async (req, res) => {
    try {
      if (!assertAdminTrain(req, res)) return;
      const userId = await resolveUserId(req);
      if (!userId) return res.status(401).json({ error: "Unauthorized" });

      const name = String(req.body?.name ?? "").trim();
      if (!name) return res.status(400).json({ error: "name is required" });

      const triggerWord = String(req.body?.triggerWord ?? req.body?.trigger_word ?? "").trim() || null;
      const isStyle =
        String(req.body?.isStyle ?? req.body?.is_style ?? "false").toLowerCase() === "true";

      const category = String(req.body?.category ?? "").trim();
      const strokePreset = String(req.body?.strokePreset ?? "").trim();
      const skillLevel = String(req.body?.skillLevel ?? "").trim();
      const viewProfileRaw = String(req.body?.viewProfile ?? "").trim();
      const viewProfile = viewProfileRaw ? viewProfileRaw : null;

      if (!category || !strokePreset || !skillLevel) {
        return res.status(400).json({
          error: "category, strokePreset, and skillLevel are required",
        });
      }

      const files = (req.files as Express.Multer.File[]) || [];
      if (!files.length) return res.status(400).json({ error: "images[] is required" });

      await ensureDirs();

      const datasetId = randomUUID();
      const datasetImagesDir = path.join(IMAGES_ROOT, datasetId);
      if (!fs.existsSync(datasetImagesDir)) fs.mkdirSync(datasetImagesDir, { recursive: true });

      const now = new Date();
      await db.insert(falLoraDataset).values({
        id: datasetId,
        userId,
        name,
        triggerWord,
        isStyle,
        zipPath: null,
        createdAt: now,
        updatedAt: now,
      });

      const imageRows: Array<{
        id: string;
        filePath: string;
        publicPath: string;
        fileName: string;
        caption: string | null;
      }> = [];

      for (const f of files) {
        const id = randomUUID();
        const ext = path.extname(f.originalname || "") || safeExtFromMime(f.mimetype);
        const safeExt = ext.toLowerCase().match(/^\.(png|jpg|jpeg|webp)$/) ? ext.toLowerCase() : safeExtFromMime(f.mimetype);
        const fileName = `${id}${safeExt === ".jpeg" ? ".jpg" : safeExt}`;
        const absPath = path.join(datasetImagesDir, fileName);
        await fs.promises.writeFile(absPath, f.buffer);

        const publicPath = `/uploads/fal-train/images/${datasetId}/${fileName}`;

        // Captions: only include when NOT style training (fal style mode ignores captions and uses trigger_word).
        const movementLabel = buildMovementLabel({ strokePreset, category, skillLevel });
        const caption =
          isStyle
            ? null
            : triggerWord
            ? `${triggerWord} ${movementLabel}`
            : movementLabel;

        await db.insert(falLoraImage).values({
          id,
          datasetId,
          userId,
          category: category as any,
          strokePreset: strokePreset as any,
          skillLevel: skillLevel as any,
          viewProfile: (viewProfile as any) ?? null,
          filePath: absPath,
          publicPath,
          caption,
          createdAt: now,
        });

        imageRows.push({
          id,
          filePath: absPath,
          publicPath,
          fileName,
          caption,
        });
      }

      const zip = await writeZipFromDataset({
        datasetId,
        files: imageRows.map((r) => ({
          filePath: r.filePath,
          fileName: r.fileName,
          caption: r.caption,
        })),
      });

      await db
        .update(falLoraDataset)
        .set({ zipPath: zip.zipPublicPath, updatedAt: new Date() })
        .where(eq(falLoraDataset.id, datasetId));

      return res.json({
        ok: true,
        datasetId,
        imageCount: imageRows.length,
        zipPath: zip.zipPublicPath,
        images: imageRows.map((r) => ({ id: r.id, publicPath: r.publicPath })),
      });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || "Failed to create dataset" });
    }
  }
);

/** GET /train/fal-lora/datasets (admin) */
router.get("/datasets", async (req, res) => {
  try {
    if (!assertAdminTrain(req, res)) return;
    const userId = await resolveUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const rows = await db
      .select()
      .from(falLoraDataset)
      .where(eq(falLoraDataset.userId, userId))
      .orderBy(desc(falLoraDataset.createdAt));

    return res.json({ ok: true, datasets: rows });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "Failed to list datasets" });
  }
});

/** GET /train/fal-lora/dataset/:id/images (admin) */
router.get("/dataset/:id/images", async (req, res) => {
  try {
    if (!assertAdminTrain(req, res)) return;
    const userId = await resolveUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const datasetId = String(req.params.id || "");
    if (!datasetId) return res.status(400).json({ error: "Missing id" });

    const dataset = await db.query.falLoraDataset.findFirst({
      where: (d, { and, eq: _eq }) => and(_eq(d.id, datasetId), _eq(d.userId, userId)),
    });
    if (!dataset) return res.status(404).json({ error: "Not found" });

    const images = await db.query.falLoraImage.findMany({
      where: (i, { and, eq: _eq }) => and(_eq(i.datasetId, datasetId), _eq(i.userId, userId)),
    });

    return res.json({ ok: true, dataset, images });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "Failed to list images" });
  }
});

/** POST /train/fal-lora/run (admin) */
router.post("/run", express.json({ limit: "2mb" }), async (req, res) => {
  try {
    if (!assertAdminTrain(req, res)) return;
    const userId = await resolveUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const datasetId = String(req.body?.datasetId ?? "").trim();
    if (!datasetId) return res.status(400).json({ error: "datasetId is required" });

    const dataset = await db.query.falLoraDataset.findFirst({
      where: (d, { and, eq: _eq }) => and(_eq(d.id, datasetId), _eq(d.userId, userId)),
    });
    if (!dataset?.zipPath) {
      return res.status(400).json({ error: "Dataset missing zipPath (upload again)" });
    }

    const publicBase =
      (process.env.PUBLIC_VIDEO_BASE_URL || "").trim() ||
      (process.env.PUBLIC_BASE_URL || "").trim() ||
      (process.env.BETTER_AUTH_URL || "").trim() ||
      "http://localhost:3050";
    const images_data_url = dataset.zipPath.startsWith("http")
      ? dataset.zipPath
      : `${publicBase.replace(/\/+$/, "")}${dataset.zipPath}`;

    const triggerWord =
      String(req.body?.triggerWord ?? dataset.triggerWord ?? "").trim() || undefined;
    const isStyle =
      typeof req.body?.isStyle === "boolean"
        ? req.body.isStyle
        : dataset.isStyle;
    const stepsRaw = Number(req.body?.steps);
    const steps = Number.isFinite(stepsRaw) ? Math.max(1, Math.min(10000, Math.round(stepsRaw))) : undefined;

    const runId = randomUUID();
    const now = new Date();
    await db.insert(falLoraTrainingRun).values({
      id: runId,
      datasetId,
      userId,
      status: "queued",
      imagesDataUrl: images_data_url,
      triggerWord: triggerWord ?? null,
      isStyle: !!isStyle,
      steps: steps ?? null,
      diffusersLoraFileUrl: null,
      configFileUrl: null,
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
    });

    // Call fal training via our existing server endpoint module (avoid client exposing FAL key).
    const falKey = String(process.env.FAL_API_KEY || "").trim();
    if (!falKey) {
      await db
        .update(falLoraTrainingRun)
        .set({ status: "failed", errorMessage: "FAL_API_KEY is not set", updatedAt: new Date() })
        .where(eq(falLoraTrainingRun.id, runId));
      return res.status(500).json({ error: "FAL_API_KEY is not set" });
    }

    const payload: any = {
      images_data_url,
      ...(triggerWord ? { trigger_word: triggerWord } : {}),
      ...(typeof steps === "number" ? { steps } : {}),
      ...(typeof isStyle === "boolean" ? { is_style: isStyle } : {}),
    };

    const r = await fetch("https://fal.run/fal-ai/flux-lora-fast-training", {
      method: "POST",
      headers: {
        Authorization: `Key ${falKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const data = (await r.json().catch(() => null)) as any;

    if (!r.ok) {
      await db
        .update(falLoraTrainingRun)
        .set({
          status: "failed",
          errorMessage: `fal_train_failed_http_${r.status}`,
          updatedAt: new Date(),
        })
        .where(eq(falLoraTrainingRun.id, runId));
      return res.status(502).json({ error: "fal_train_failed", status: r.status, details: data ?? null });
    }

    await db
      .update(falLoraTrainingRun)
      .set({
        status: "completed",
        diffusersLoraFileUrl: data?.diffusers_lora_file?.url ?? null,
        configFileUrl: data?.config_file?.url ?? null,
        updatedAt: new Date(),
      })
      .where(eq(falLoraTrainingRun.id, runId));

    return res.json({
      ok: true,
      runId,
      diffusers_lora_file_url: data?.diffusers_lora_file?.url ?? null,
      config_file_url: data?.config_file?.url ?? null,
      raw: data,
    });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "Failed to run training" });
  }
});

export default router;

