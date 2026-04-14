import express from "express";
import { fromNodeHeaders } from "better-auth/node";
import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import fs from "fs";
import path from "path";
import { v2 as cloudinary } from "cloudinary";
import { auth } from "../auth";
import {
  db,
  coachReviewAnnotation,
  coachVideoReview,
  techniqueAnalysis,
  techniqueVideo,
  userNotification,
} from "../db";

const router = express.Router();
router.use(express.json({ limit: "50mb" }));
router.use(express.urlencoded({ extended: true, limit: "50mb" }));

type CoachAnnotationRow = {
  imageUri: string;
  comment: string;
  timeMs: number;
  cloudinaryUrl: string | null;
};

function isSafeImageUri(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const s = value.trim();
  if (!s) return false;
  if (/^https?:\/\//i.test(s)) return true;
  if (/^\/uploads\//i.test(s)) return true;
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(s)) return true;
  return false;
}

function normalizeCoachAnnotations(input: unknown): CoachAnnotationRow[] {
  if (!Array.isArray(input)) return [];
  return input
    .slice(0, 40)
    .map((row) => {
      const r = row as Record<string, unknown>;
      const imageUri = isSafeImageUri(r.imageUri) ? String(r.imageUri).trim() : "";
      const commentRaw = typeof r.comment === "string" ? r.comment.trim() : "";
      const comment = commentRaw.slice(0, 1200);
      const timeMsRaw = r.timeMs;
      const timeMs =
        typeof timeMsRaw === "number" && Number.isFinite(timeMsRaw)
          ? Math.max(0, Math.round(timeMsRaw))
          : 0;
      const cloudinaryUrl =
        typeof r.cloudinaryUrl === "string" && /^https?:\/\//i.test(r.cloudinaryUrl.trim())
          ? r.cloudinaryUrl.trim()
          : null;
      if (!imageUri) return null;
      return { imageUri, comment, timeMs, cloudinaryUrl };
    })
    .filter((r): r is CoachAnnotationRow => !!r);
}

const COACH_REVIEW_UPLOAD_ROOT = path.join(
  process.cwd(),
  "uploads",
  "coach-review"
);

function parseDataImage(imageUri: string): { mime: string; base64: string } | null {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(imageUri.trim());
  if (!m) return null;
  return { mime: m[1], base64: m[2].replace(/\s+/g, "") };
}

function extForMime(mime: string): string {
  const low = mime.toLowerCase();
  if (low.includes("png")) return ".png";
  if (low.includes("webp")) return ".webp";
  if (low.includes("jpeg") || low.includes("jpg")) return ".jpg";
  return ".png";
}

let cloudinaryReady = false;
function initCloudinaryIfConfigured(): boolean {
  if (cloudinaryReady) return true;
  const cloudName = String(process.env.CLOUDINARY_CLOUD_NAME || "").trim();
  const apiKey = String(process.env.CLOUDINARY_API_KEY || "").trim();
  const apiSecret = String(process.env.CLOUDINARY_API_SECRET || "").trim();
  const cloudinaryUrl = String(process.env.CLOUDINARY_URL || "").trim();
  if (!cloudinaryUrl && (!cloudName || !apiKey || !apiSecret)) return false;
  cloudinary.config(
    cloudinaryUrl
      ? { secure: true }
      : {
          cloud_name: cloudName,
          api_key: apiKey,
          api_secret: apiSecret,
          secure: true,
        }
  );
  cloudinaryReady = true;
  return true;
}

async function uploadAnnotationToCloudinary(
  imageUri: string,
  reviewId: string,
  idx: number
): Promise<string | null> {
  if (!/^data:image\/[a-z0-9.+-]+;base64,/i.test(imageUri)) return null;
  if (!initCloudinaryIfConfigured()) return null;
  try {
    const result = await cloudinary.uploader.upload(imageUri, {
      folder: "xevo/coach-review",
      public_id: `${reviewId}-${Date.now()}-${idx}`,
      overwrite: true,
      resource_type: "image",
    });
    return typeof result?.secure_url === "string" ? result.secure_url : null;
  } catch {
    return null;
  }
}

async function persistCoachAnnotationImages(
  reviewId: string,
  rows: CoachAnnotationRow[]
): Promise<CoachAnnotationRow[]> {
  if (!fs.existsSync(COACH_REVIEW_UPLOAD_ROOT)) {
    fs.mkdirSync(COACH_REVIEW_UPLOAD_ROOT, { recursive: true });
  }
  const out: CoachAnnotationRow[] = [];
  console.log("[Coach] persistCoachAnnotationImages:start", {
    reviewId,
    inputCount: rows.length,
  });
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    console.log("[Coach] persistCoachAnnotationImages:row", {
      reviewId,
      idx: i,
      hasImageUri: !!row.imageUri,
      imagePrefix: row.imageUri ? row.imageUri.slice(0, 36) : null,
      hasComment: !!row.comment,
      hasCloudinaryUrl: !!row.cloudinaryUrl,
      timeMs: row.timeMs,
    });
    const cloudinaryUrl = await uploadAnnotationToCloudinary(
      row.imageUri,
      reviewId,
      i
    );
    if (cloudinaryUrl) {
      out.push({
        ...row,
        imageUri: cloudinaryUrl,
        cloudinaryUrl,
      });
      console.log("[Coach] persistCoachAnnotationImages:row:cloudinary", {
        reviewId,
        idx: i,
        cloudinaryUrlPrefix: cloudinaryUrl.slice(0, 60),
      });
      continue;
    }
    const parsed = parseDataImage(row.imageUri);
    if (!parsed) {
      out.push(row);
      console.log("[Coach] persistCoachAnnotationImages:row:kept-original", {
        reviewId,
        idx: i,
        reason: "not-data-image",
      });
      continue;
    }
    try {
      const ext = extForMime(parsed.mime);
      const fileName = `${reviewId}-${Date.now()}-${i}${ext}`;
      const filePath = path.join(COACH_REVIEW_UPLOAD_ROOT, fileName);
      const buf = Buffer.from(parsed.base64, "base64");
      await fs.promises.writeFile(filePath, buf);
      out.push({
        ...row,
        imageUri: `/uploads/coach-review/${fileName}`,
        cloudinaryUrl: row.cloudinaryUrl ?? null,
      });
      console.log("[Coach] persistCoachAnnotationImages:row:local-upload", {
        reviewId,
        idx: i,
        imageUri: `/uploads/coach-review/${fileName}`,
      });
    } catch {
      // Keep original value as fallback if disk write fails.
      out.push(row);
      console.log("[Coach] persistCoachAnnotationImages:row:disk-write-failed", {
        reviewId,
        idx: i,
      });
    }
  }
  console.log("[Coach] persistCoachAnnotationImages:done", {
    reviewId,
    outputCount: out.length,
    cloudinaryCount: out.filter((r) => /^https?:\/\//i.test(r.imageUri)).length,
    uploadPathCount: out.filter((r) => /^\/uploads\//i.test(r.imageUri)).length,
    dataUriCount: out.filter((r) => /^data:image\//i.test(r.imageUri)).length,
    emptyImageCount: out.filter((r) => !r.imageUri).length,
  });
  return out;
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

  return sessionRow?.userId ?? null;
}

function deriveShotLabelFromAnalysis(analysis: typeof techniqueAnalysis.$inferSelect | null): string | null {
  if (!analysis?.metrics || typeof analysis.metrics !== "object") return null;
  const metrics = analysis.metrics as Record<string, unknown>;
  const ai = metrics.ai_analysis as Record<string, unknown> | undefined;
  const retrieval = metrics.retrieval as Record<string, unknown> | undefined;
  const hyp = retrieval?.shot_hypothesis as Record<string, unknown> | undefined;
  if (typeof hyp?.stroke_preset === "string" && hyp.stroke_preset.trim()) {
    return hyp.stroke_preset
      .replace(/_/g, " ")
      .replace(/\b\w/g, (ch) => ch.toUpperCase());
  }
  const en = ai?.en as Record<string, unknown> | undefined;
  if (typeof en?.shot_context === "string" && en.shot_context.trim()) {
    const first = en.shot_context.split(/[.!?]/)[0]?.trim() ?? "";
    return first || null;
  }
  return null;
}

router.get("/review/:id", async (req, res) => {
  try {
    const userId = await resolveUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const id = String(req.params?.id || "").trim();
    if (!id) return res.status(400).json({ error: "Missing review id" });

    const review = await db.query.coachVideoReview.findFirst({
      where: (r, { eq: _eq }) => _eq(r.id, id),
    });
    if (!review) return res.status(404).json({ error: "Review not found" });

    const canRead =
      review.coachUserId === userId || review.studentUserId === userId;
    if (!canRead) return res.status(403).json({ error: "Forbidden" });

    const video = await db.query.techniqueVideo.findFirst({
      where: (v, { eq: _eq }) => _eq(v.id, review.techniqueVideoId),
    });
    if (!video) return res.status(404).json({ error: "Video not found" });

    let analysis = review.techniqueAnalysisId
      ? await db.query.techniqueAnalysis.findFirst({
          where: (a, { eq: _eq }) => _eq(a.id, review.techniqueAnalysisId!),
        })
      : null;

    if (!analysis) {
      analysis = await db.query.techniqueAnalysis.findFirst({
        where: (a, { and: _and, eq: _eq }) =>
          _and(
            _eq(a.techniqueVideoId, review.techniqueVideoId),
            _eq(a.userId, review.studentUserId)
          ),
        orderBy: (a, { desc: _desc }) => [_desc(a.createdAt)],
      });
      if (analysis && !review.techniqueAnalysisId) {
        await db
          .update(coachVideoReview)
          .set({ techniqueAnalysisId: analysis.id, updatedAt: new Date() })
          .where(eq(coachVideoReview.id, review.id));
      }
    }

    const ai = (analysis?.metrics as Record<string, unknown> | null | undefined)
      ?.ai_analysis as Record<string, unknown> | undefined;
    const scoreRaw = typeof ai?.score === "number" ? Number(ai.score) : null;
    const scorePercent =
      scoreRaw != null ? Math.round(Math.max(0, Math.min(100, scoreRaw * 10))) : null;
    const rating = typeof ai?.rating === "string" ? ai.rating : null;
    const annRows = await db.query.coachReviewAnnotation.findMany({
      where: (a, { eq: _eq }) => _eq(a.reviewId, review.id),
      orderBy: (a, { asc: _asc }) => [_asc(a.timeMs), _asc(a.createdAt)],
      limit: 200,
    });
    const annotationsFromTable =
      annRows.length > 0
        ? annRows.map((a) => ({
            imageUri: a.imageUri,
            cloudinaryUrl: a.cloudinaryUrl ?? null,
            comment: a.comment ?? "",
            timeMs: a.timeMs,
          }))
        : null;

    return res.json({
      review: {
        id: review.id,
        status: review.status,
        techniqueVideoId: review.techniqueVideoId,
        techniqueAnalysisId: analysis?.id ?? review.techniqueAnalysisId ?? null,
        videoPath: `/technique/video/${review.techniqueVideoId}`,
        coachFeedbackText: review.coachFeedbackText ?? null,
        coachMarksJson:
          annotationsFromTable ??
          normalizeCoachAnnotations(review.coachMarksJson),
        submittedAt: review.submittedAt ?? null,
        aiSummary: {
          score: scorePercent,
          rating,
          shotLabel: deriveShotLabelFromAnalysis(analysis ?? null),
        },
      },
    });
  } catch (e: any) {
    console.error("[Coach] review GET error", e);
    return res.status(500).json({ error: "Failed to load coach review" });
  }
});

router.post("/review/:id/submit", async (req, res) => {
  try {
    const userId = await resolveUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const id = String(req.params?.id || "").trim();
    if (!id) return res.status(400).json({ error: "Missing review id" });

    const review = await db.query.coachVideoReview.findFirst({
      where: (r, { eq: _eq }) => _eq(r.id, id),
    });
    if (!review) return res.status(404).json({ error: "Review not found" });
    if (review.coachUserId !== userId) {
      return res.status(403).json({ error: "Only the assigned coach can submit this review" });
    }

    const now = new Date();
    const coachFeedbackTextRaw = req.body?.coachFeedbackText;
    const coachFeedbackText =
      typeof coachFeedbackTextRaw === "string" && coachFeedbackTextRaw.trim().length > 0
        ? coachFeedbackTextRaw.trim()
        : null;
    console.log("[Coach] review submit payload", {
      reviewId: id,
      coachUserId: userId,
      hasFeedback: !!coachFeedbackText,
      inputIsArray: Array.isArray(req.body?.coachMarksJson),
      inputCount: Array.isArray(req.body?.coachMarksJson)
        ? req.body.coachMarksJson.length
        : 0,
    });
    const normalizedAnnotations = normalizeCoachAnnotations(req.body?.coachMarksJson);
    console.log("[Coach] review submit normalized", {
      reviewId: id,
      normalizedCount: normalizedAnnotations.length,
      normalizedWithImage: normalizedAnnotations.filter((r) => !!r.imageUri).length,
      normalizedWithCloudinaryUrl: normalizedAnnotations.filter((r) => !!r.cloudinaryUrl)
        .length,
    });
    if (
      Array.isArray(req.body?.coachMarksJson) &&
      req.body.coachMarksJson.length > 0 &&
      normalizedAnnotations.length === 0
    ) {
      return res
        .status(400)
        .json({ error: "Annotation images are required. Please re-capture and submit again." });
    }
    const persistedAnnotations = await persistCoachAnnotationImages(
      id,
      normalizedAnnotations
    );
    console.log("[Coach] review submit persisted", {
      reviewId: id,
      persistedCount: persistedAnnotations.length,
      persistedWithImage: persistedAnnotations.filter((r) => !!r.imageUri).length,
      persistedWithCloudinaryUrl: persistedAnnotations.filter((r) => !!r.cloudinaryUrl)
        .length,
      persistedEmptyImage: persistedAnnotations.filter((r) => !r.imageUri).length,
    });
    const coachMarksJson =
      persistedAnnotations.length > 0 ? persistedAnnotations : null;

    await db
      .delete(coachReviewAnnotation)
      .where(eq(coachReviewAnnotation.reviewId, id));
    if (persistedAnnotations.length > 0) {
      await db.insert(coachReviewAnnotation).values(
        persistedAnnotations.map((ann) => ({
          id: randomUUID(),
          reviewId: id,
          imageUri: ann.imageUri,
          cloudinaryUrl: ann.cloudinaryUrl ?? null,
          comment: ann.comment || null,
          timeMs: ann.timeMs,
          createdAt: now,
        }))
      );
    }

    await db
      .update(coachVideoReview)
      .set({
        status: "completed",
        coachFeedbackText,
        coachMarksJson,
        submittedAt: now,
        updatedAt: now,
      })
      .where(and(eq(coachVideoReview.id, id), eq(coachVideoReview.coachUserId, userId)));

    await db.insert(userNotification).values({
      id: randomUUID(),
      userId: review.studentUserId,
      kind: "coach_review_ready",
      title: "Coach feedback is ready",
      body: coachFeedbackText
        ? coachFeedbackText.slice(0, 180)
        : "Open your activity to see the coach review and marks.",
      refType: "coach_video_review",
      refId: review.id,
      createdAt: now,
    });

    return res.json({ ok: true });
  } catch (e: any) {
    console.error("[Coach] review submit error", e);
    return res.status(500).json({ error: "Failed to submit coach review" });
  }
});

export default router;
