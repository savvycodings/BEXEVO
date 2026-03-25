/**
 * Training dataset uploads (admin-only via X-Admin-Train-Secret).
 *
 * Parallels technique video storage:
 * - POST multipart: field "video" (mp4/mov), field "strokeName" (e.g. backhand)
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
import { db, trainVideo } from "../db";
import { eq } from "drizzle-orm";

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

const router = express.Router();
router.use(express.json({ limit: "2mb" }));
router.use(express.urlencoded({ extended: true }));

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

    const strokeName = String(req.body?.strokeName ?? "")
      .trim()
      .slice(0, 120);
    if (!strokeName) {
      console.log("[Train] Upload rejected: strokeName missing or empty", {
        bodyKeys: req.body && typeof req.body === "object" ? Object.keys(req.body) : [],
      });
      return res.status(400).json({ error: "strokeName is required" });
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
      cloudinaryPublicId: filePath,
      cloudinaryUrl: publicPath,
      secureUrl: publicPath,
      bytes: String(req.file.size ?? ""),
      format: ext.replace(".", "") || undefined,
    });

    console.log("[Train] Upload OK — saved and DB row inserted", {
      id,
      strokeName,
      publicPath,
      bytes: req.file.size,
    });

    return res.json({
      id,
      url: publicPath,
      strokeName,
      message:
        "Stored for training. DELETE /train/video/:id with admin header to remove.",
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

export default router;
