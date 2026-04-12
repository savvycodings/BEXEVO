import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import archiver from "archiver";
import { fal } from "@fal-ai/client";
import { Agent, fetch as undiciFetch } from "undici";
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

/** fal docs use FAL_KEY; we also accept FAL_API_KEY for backwards compatibility */
function resolveFalKey(): string {
  return String(process.env.FAL_API_KEY || process.env.FAL_KEY || "").trim();
}

/**
 * Upload the dataset zip to fal CDN via @fal-ai/client so training sees real zip bytes.
 * (URLs like ngrok often return HTML interstitials to server-side GETs — fal then says "not a zip file".)
 */
async function uploadTrainingZipToFalStorage(zipAbsPath: string): Promise<string> {
  const key = resolveFalKey();
  if (!key) throw new Error("FAL_KEY or FAL_API_KEY is not set");
  fal.config({ credentials: key });
  const buf = await fs.promises.readFile(zipAbsPath);
  const blob = new Blob([buf], { type: "application/zip" });
  return fal.storage.upload(blob, { lifecycle: { expiresIn: "7d" } });
}

/**
 * fal HTTP 422 uses FastAPI/Pydantic shape: { detail: [{ loc, msg, type, input, ... }, ...] }.
 * Sync POST body matches OpenAPI `FluxLoraFastTrainingInput` (flat JSON, not wrapped in `input`):
 * @see https://fal.ai/models/fal-ai/flux-lora-fast-training/api
 * @see https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/flux-lora-fast-training
 */
/** Safe subset of fal output — avoids shipping huge/ambiguous blobs to the client. */
function summarizeFalTrainingFiles(data: unknown): {
  diffusers_lora_file: Record<string, unknown> | null;
  config_file: Record<string, unknown> | null;
  debug_preprocessed_output: Record<string, unknown> | null;
} {
  const pick = (f: unknown) => {
    if (!f || typeof f !== "object") return null;
    const o = f as Record<string, unknown>;
    return {
      url: typeof o.url === "string" ? o.url : null,
      file_name: typeof o.file_name === "string" ? o.file_name : null,
      file_size_bytes: typeof o.file_size === "number" ? o.file_size : null,
      content_type: typeof o.content_type === "string" ? o.content_type : null,
    };
  };
  if (!data || typeof data !== "object") {
    return { diffusers_lora_file: null, config_file: null, debug_preprocessed_output: null };
  }
  const d = data as Record<string, unknown>;
  return {
    diffusers_lora_file: pick(d.diffusers_lora_file),
    config_file: pick(d.config_file),
    debug_preprocessed_output: pick(d.debug_preprocessed_output),
  };
}

function humanReadableFalError(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const d = data as Record<string, unknown>;
  const detail = d.detail;
  if (Array.isArray(detail)) {
    return detail
      .map((item: unknown) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          const o = item as Record<string, unknown>;
          const loc = Array.isArray(o.loc) ? (o.loc as unknown[]).join(".") : "";
          const msg = typeof o.msg === "string" ? o.msg : JSON.stringify(item);
          return loc ? `${loc}: ${msg}` : msg;
        }
        return String(item);
      })
      .join(" | ");
  }
  if (typeof detail === "string") return detail;
  return "";
}

function getNetworkErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as { code?: string; cause?: { code?: string } };
  return e.cause?.code || e.code;
}

function isLikelyNetworkFailure(err: unknown): boolean {
  const code = getNetworkErrorCode(err);
  if (
    code === "ENOTFOUND" ||
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "EAI_AGAIN" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "UND_ERR_BODY_TIMEOUT"
  ) {
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/fetch failed|Headers Timeout|Body Timeout|network/i.test(msg)) return true;
  return false;
}

function extractFalClientErrorBody(err: unknown): unknown {
  if (!err || typeof err !== "object") return null;
  const o = err as Record<string, unknown>;
  if ("body" in o) return o.body;
  if ("response" in o && o.response && typeof o.response === "object") {
    const r = o.response as Record<string, unknown>;
    if ("data" in r) return r.data;
  }
  return null;
}

function getErrHostname(err: unknown): string | undefined {
  const c = err && typeof err === "object" ? (err as { cause?: { hostname?: string } }).cause : undefined;
  return c?.hostname;
}

/** fal.subscribe talks to queue.fal.run — some networks/DNS resolve fal.run but not the queue host. */
function isQueueHostNotFound(err: unknown): boolean {
  if (getNetworkErrorCode(err) !== "ENOTFOUND") return false;
  const h = getErrHostname(err);
  if (h && /queue\.fal\.run/i.test(h)) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /queue\.fal\.run/i.test(msg);
}

/** Single long-lived HTTP POST to fal.run (not queue) — use when queue.fal.run is unreachable. */
const FLUX_LORA_SYNC_AGENT = new Agent({
  headersTimeout: 2 * 60 * 60 * 1000,
  bodyTimeout: 2 * 60 * 60 * 1000,
  connectTimeout: 120_000,
});

function falRunHttpsUrlForEndpoint(endpointId: string): string {
  const id = endpointId.replace(/^\//, "").trim();
  return `https://fal.run/${id}`;
}

async function fetchFluxLoraTrainingSyncLong(
  falKey: string,
  payload: Record<string, unknown>,
  trainingEndpoint: string
): Promise<any> {
  const url = falRunHttpsUrlForEndpoint(trainingEndpoint);
  const r = await undiciFetch(url, {
    method: "POST",
    headers: {
      Authorization: `Key ${falKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    dispatcher: FLUX_LORA_SYNC_AGENT,
  });
  const data = (await r.json().catch(() => null)) as any;
  if (!r.ok) {
    const e = new Error(`fal_http_${r.status}`);
    (e as { body?: unknown; status?: number }).body = data;
    (e as { body?: unknown; status?: number }).status = r.status;
    throw e;
  }
  return data;
}

/** Best-effort persist so a flaky Neon/DNS does not turn a fal 503 into an unhandled 500. */
async function persistTrainingRunFailed(runId: string, errorMessage: string): Promise<void> {
  try {
    await db
      .update(falLoraTrainingRun)
      .set({
        status: "failed",
        errorMessage: errorMessage.slice(0, 2000),
        updatedAt: new Date(),
      })
      .where(eq(falLoraTrainingRun.id, runId));
  } catch (dbErr: unknown) {
    console.error("[fal-lora/run] Could not persist run failure to database (Neon unreachable?)", {
      runId,
      message: dbErr instanceof Error ? dbErr.message : String(dbErr),
      hostname: getErrHostname(dbErr),
    });
  }
}

async function runFluxLoraTrainingWithQueueFallback(
  falKey: string,
  trainingEndpoint: string,
  payload: Record<string, unknown>
): Promise<any> {
  fal.config({ credentials: falKey });
  try {
    return await fal.subscribe(trainingEndpoint, {
      input: payload,
      logs: false,
    });
  } catch (e: unknown) {
    if (!isQueueHostNotFound(e)) throw e;
    console.warn(
      "[fal-lora/run] queue.fal.run not resolvable (subscribe uses queue API). Retrying with sync POST to https://fal.run (2h undici timeout).",
      { hostname: getErrHostname(e) }
    );
    return await fetchFluxLoraTrainingSyncLong(falKey, payload, trainingEndpoint);
  }
}

/** Undici/node fetch wraps DNS errors in TypeError with cause ENOTFOUND */
function messageForFalNetworkFailure(err: unknown): { message: string; hint: string } {
  const code = getNetworkErrorCode(err);
  const raw = err instanceof Error ? err.message : String(err);
  if (code === "ENOTFOUND") {
    const host = getErrHostname(err);
    const h = host ? String(host).toLowerCase() : "";
    if (h === "fal.run") {
      return {
        message: raw,
        hint:
          "Could not resolve fal.run. Training already tried fal.subscribe (queue.fal.run) and then a direct HTTPS POST to fal.run — your PC still cannot resolve fal.ai. This is a DNS/network issue on the machine running Node, not the Expo app. Fix: set DNS to 8.8.8.8 or 1.1.1.1, turn off VPN/ad-block DNS, check hosts file for fal entries, run `nslookup fal.run` in PowerShell. Or run the API on a host that can reach the internet (cloud). No code change will bypass missing DNS.",
      };
    }
    if (h.includes("queue.fal.run")) {
      return {
        message: raw,
        hint:
          "Could not resolve queue.fal.run (used by fal.subscribe). The server retries with fal.run next; if you then see ENOTFOUND fal.run, your network cannot reach fal.ai at all.",
      };
    }
    return {
      message: raw,
      hint:
        `DNS could not resolve ${host || "hostname"}. fal needs queue.fal.run and fal.run. Check VPN, firewall, corporate DNS, and run nslookup.`,
    };
  }
  if (code === "EAI_AGAIN" || code === "ECONNREFUSED" || code === "ETIMEDOUT") {
    return {
      message: raw,
      hint: `Network error (${code}) reaching fal. Check firewall/proxy and try again.`,
    };
  }
  if (code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT") {
    return {
      message: raw,
      hint:
        "Undici hit its default ~300s headers/body timeout on a single long HTTP request. The server now uses fal.subscribe (queue polling) for training — retry; if you still see this, the network to fal.ai may be unstable (VPN, proxy).",
    };
  }
  return { message: raw, hint: "" };
}

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

    const triggerWord =
      String(req.body?.triggerWord ?? dataset.triggerWord ?? "").trim() || undefined;
    const isStyle =
      typeof req.body?.isStyle === "boolean"
        ? req.body.isStyle
        : dataset.isStyle;
    const stepsRaw = Number(req.body?.steps);
    const steps = Number.isFinite(stepsRaw) ? Math.max(1, Math.min(10000, Math.round(stepsRaw))) : undefined;

    if (!resolveFalKey()) {
      return res.status(500).json({
        error: "FAL_KEY or FAL_API_KEY is not set (fal.ai docs use FAL_KEY)",
      });
    }

    const zipAbsPath = path.join(process.cwd(), dataset.zipPath.replace(/^\//, ""));
    if (!fs.existsSync(zipAbsPath)) {
      return res.status(400).json({
        error: "Zip file not found on this server; create the dataset again from Admin.",
        path: zipAbsPath,
      });
    }

    let images_data_url: string;
    try {
      images_data_url = await uploadTrainingZipToFalStorage(zipAbsPath);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const { hint: netHint } = messageForFalNetworkFailure(e);
      console.error("[fal-lora/run] fal.storage.upload failed", e);
      return res.status(500).json({
        error: msg || "Failed to upload zip to fal storage",
        hint:
          netHint ||
          "Ensure FAL_KEY/FAL_API_KEY is valid. Upload uses fal.ai CDN; this machine must reach the public internet.",
      });
    }

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

    const falKey = resolveFalKey()!;

    /** Matches OpenAPI `FluxLoraFastTrainingInput` — flat JSON on POST (same as official curl). */
    const payload: Record<string, unknown> = {
      images_data_url,
      ...(triggerWord ? { trigger_word: triggerWord } : {}),
      ...(typeof steps === "number" ? { steps } : {}),
      ...(typeof isStyle === "boolean" ? { is_style: isStyle } : {}),
    };

    const trainingEndpoint =
      String(process.env.FAL_FLUX_LORA_TRAINING_ENDPOINT || "").trim() ||
      "fal-ai/flux-lora-fast-training";

    let data: any;
    try {
      /** Prefer fal.subscribe (queue.fal.run). If queue host does not resolve, fall back to sync fal.run with long timeout. */
      data = await runFluxLoraTrainingWithQueueFallback(falKey, trainingEndpoint, payload);
    } catch (err: unknown) {
      console.error("[fal-lora/run] LoRA training request failed", err);
      if (isLikelyNetworkFailure(err)) {
        const { message, hint } = messageForFalNetworkFailure(err);
        const fullMsg = [message, hint].filter(Boolean).join(" — ").slice(0, 2000);
        await persistTrainingRunFailed(runId, `network: ${fullMsg}`);
        return res.status(503).json({
          ok: false,
          error: "fal_network_error",
          message,
          hint: hint || undefined,
        });
      }

      const errBody = extractFalClientErrorBody(err);
      const detail =
        errBody && typeof errBody === "object"
          ? JSON.stringify(errBody).slice(0, 4000)
          : err instanceof Error
            ? err.message
            : String(err);
      console.warn(
        `[fal-lora/run] fal training error\n` +
          `payload keys: ${JSON.stringify(Object.keys(payload))}\n` +
          `images_data_url (first 120 chars): ${String(images_data_url).slice(0, 120)}\n` +
          `error body:\n${JSON.stringify(errBody ?? err, null, 2)}`
      );
      const falSummary =
        humanReadableFalError(errBody) ||
        (errBody &&
        typeof errBody === "object" &&
        typeof (errBody as Record<string, unknown>).detail === "string"
          ? String((errBody as Record<string, unknown>).detail)
          : "") ||
        (typeof (errBody as Record<string, unknown> | null)?.message === "string"
          ? String((errBody as Record<string, unknown>).message)
          : "") ||
        detail.slice(0, 800);
      await persistTrainingRunFailed(runId, `fal_train: ${detail}`);
      return res.status(502).json({
        ok: false,
        error: "fal_train_failed",
        message: falSummary || "fal training failed",
        details: errBody ?? (err instanceof Error ? { message: err.message } : err),
      });
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

    const datasetImageRows = await db.query.falLoraImage.findMany({
      where: (img, { eq: _eq }) => _eq(img.datasetId, datasetId),
    });

    return res.json({
      ok: true,
      runId,
      diffusers_lora_file_url: data?.diffusers_lora_file?.url ?? null,
      config_file_url: data?.config_file?.url ?? null,
      /** fal.ai `steps` input = optimizer iterations (often 500–2000), NOT number of images */
      training_steps_requested: steps ?? null,
      dataset_image_count: datasetImageRows.length,
      note:
        "training_steps_requested is LoRA optimizer steps (your Steps field). dataset_image_count is images in this dataset zip. If a UI showed ~1000, that is usually this step count, not '1000 images generated'.",
      fal_file_outputs: summarizeFalTrainingFiles(data),
    });
  } catch (e: any) {
    console.error("[fal-lora/run]", e);
    return res.status(500).json({ error: e?.message || "Failed to run training" });
  }
});

export default router;

