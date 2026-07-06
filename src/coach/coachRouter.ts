import express from "express";
import multer from "multer";
import { fromNodeHeaders } from "better-auth/node";
import { randomUUID } from "crypto";
import { and, eq, inArray } from "drizzle-orm";
import fs from "fs";
import path from "path";
import { v2 as cloudinary } from "cloudinary";
import { auth } from "../auth";
import {
  db,
  coachReviewAnnotation,
  coachSentVideo,
  coachStudent,
  coachVideoReview,
  techniqueAnalysis,
  techniqueVideo,
  user,
  userNotification,
  userProfile,
} from "../db";
import { sendCoachReviewReadyEmail } from "../lib/email/sendCoachReviewReadyEmail";
import {
  storedAiBreakdownToPercent,
  storedAiConfidenceToPercent,
  storedAiScoreToPercent,
} from "../technique/techniqueScoreScale";
import { deriveHumanShotLabelFromMetrics } from "../train/trainShotDisplay";
import { onCoachReviewCompleted } from "../gamification/service";
import {
  type CoachAnnotationRow,
  coachMarksForClient,
  commentTonesForReview,
  normalizeCoachAnnotations,
} from "./coachAnnotations";

const router = express.Router();
router.use(express.json({ limit: "50mb" }));
router.use(express.urlencoded({ extended: true, limit: "50mb" }));

function isSafeImageUri(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const s = value.trim();
  if (!s) return false;
  if (/^https?:\/\//i.test(s)) return true;
  if (/^\/uploads\//i.test(s)) return true;
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(s)) return true;
  return false;
}

const COACH_REVIEW_UPLOAD_ROOT = path.join(
  process.cwd(),
  "uploads",
  "coach-review"
);

const COACH_SENT_VIDEO_MAX_BYTES = 50 * 1024 * 1024;
const TECHNIQUE_UPLOAD_ROOT = path.join(process.cwd(), "uploads", "technique");

const sentVideoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: COACH_SENT_VIDEO_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    const allowed = ["video/mp4", "video/quicktime"];
    if (allowed.includes(file.mimetype)) return cb(null, true);
    cb(new Error("Only MP4 and MOV videos up to 50MB are allowed"));
  },
});

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
    if (!row.imageUri) {
      out.push({ ...row, imageUri: "", cloudinaryUrl: row.cloudinaryUrl ?? null });
      continue;
    }
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
  const label = deriveHumanShotLabelFromMetrics(analysis.metrics as Record<string, unknown>);
  return label === "Technique" ? null : label;
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

    if (review.coachUserId === userId && !review.coachViewedAt) {
      await db
        .update(coachVideoReview)
        .set({ coachViewedAt: new Date(), updatedAt: new Date() })
        .where(eq(coachVideoReview.id, review.id));
    }

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
    const scorePercent = storedAiScoreToPercent(ai);
    const breakdown = storedAiBreakdownToPercent(ai);
    const confidence = storedAiConfidenceToPercent(ai);
    const rating = typeof ai?.rating === "string" ? ai.rating : null;
    const annRows = await db.query.coachReviewAnnotation.findMany({
      where: (a, { eq: _eq }) => _eq(a.reviewId, review.id),
      orderBy: (a, { asc: _asc }) => [_asc(a.timeMs), _asc(a.createdAt)],
      limit: 200,
    });
    const coachMarksForClientResponse = coachMarksForClient(
      review.coachMarksJson,
      annRows.map((a) => ({
        imageUri: a.imageUri,
        cloudinaryUrl: a.cloudinaryUrl ?? null,
        comment: a.comment ?? "",
        timeMs: a.timeMs,
        tone: a.tone ?? null,
      }))
    );

    return res.json({
      review: {
        id: review.id,
        status: review.status,
        techniqueVideoId: review.techniqueVideoId,
        techniqueAnalysisId: analysis?.id ?? review.techniqueAnalysisId ?? null,
        videoPath: `/technique/video/${review.techniqueVideoId}`,
        coachFeedbackText: review.coachFeedbackText ?? null,
        coachMarksJson: coachMarksForClientResponse.length > 0 ? coachMarksForClientResponse : null,
        submittedAt: review.submittedAt ?? null,
        aiSummary: {
          score: scorePercent,
          rating,
          techniqueScore: breakdown.technique,
          outcomeScore: breakdown.outcome,
          tacticsScore: breakdown.tactics,
          confidenceScore: confidence.score,
          confidenceBand: confidence.band,
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
        .json({ error: "Annotations must include a comment or image. Please try again." });
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
          imageUri: ann.imageUri || "",
          cloudinaryUrl: ann.cloudinaryUrl ?? null,
          comment: ann.comment || null,
          timeMs: ann.timeMs,
          tone: ann.tone ?? null,
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

    try {
      const student = await db.query.user.findFirst({
        where: (u, { eq: _eq }) => _eq(u.id, review.studentUserId),
        columns: { email: true, name: true },
      });
      if (student?.email) {
        const emailResult = await sendCoachReviewReadyEmail({
          reviewId: review.id,
          to: student.email,
          studentName: student.name,
          coachFeedbackText,
          annotationCount: persistedAnnotations.length,
        });
        if (emailResult.sent) {
          console.log("[Coach] coach_review_ready email sent", {
            reviewId: review.id,
            emailId: emailResult.emailId,
          });
        } else if (emailResult.skipped) {
          console.log("[Coach] coach_review_ready email skipped", {
            reviewId: review.id,
            reason: emailResult.skipped,
          });
        }
      }
    } catch (emailErr) {
      console.error("[Coach] coach_review_ready email failed", emailErr);
    }

    void onCoachReviewCompleted(review.studentUserId).catch((err) => {
      console.error("[Gamification] coach review hook failed", err);
    });

    return res.json({ ok: true });
  } catch (e: any) {
    console.error("[Coach] review submit error", e);
    return res.status(500).json({ error: "Failed to submit coach review" });
  }
});

/** Coach -> student: upload a tagged video and notify the student. */
router.post("/sent-video", sentVideoUpload.single("video"), async (req, res) => {
  try {
    const coachUserId = await resolveUserId(req);
    if (!coachUserId) return res.status(401).json({ error: "Unauthorized" });

    const studentUserId = String(req.body?.studentUserId || "").trim();
    if (!studentUserId) {
      return res.status(400).json({ error: "Missing studentUserId" });
    }
    if (!req.file?.buffer) {
      return res.status(400).json({ error: "No video file" });
    }

    // Must be a coach AND linked to this student.
    const coachProfile = await db.query.userProfile.findFirst({
      where: (p, { eq: _eq }) => _eq(p.userId, coachUserId),
    });
    if (coachProfile?.coachStudentRole !== "coach") {
      return res.status(403).json({ error: "Forbidden" });
    }
    const link = await db.query.coachStudent.findFirst({
      where: (cs, { and: _and, eq: _eq }) =>
        _and(
          _eq(cs.coachUserId, coachUserId),
          _eq(cs.studentUserId, studentUserId)
        ),
    });
    if (!link) {
      return res.status(403).json({ error: "Not linked to this student" });
    }

    if (!fs.existsSync(TECHNIQUE_UPLOAD_ROOT)) {
      fs.mkdirSync(TECHNIQUE_UPLOAD_ROOT, { recursive: true });
    }

    const videoId = randomUUID();
    const ext = path.extname(req.file.originalname || "") || ".mp4";
    const filePath = path.join(TECHNIQUE_UPLOAD_ROOT, `${videoId}${ext}`);
    await fs.promises.writeFile(filePath, req.file.buffer);
    const publicPath = `/technique/video/${videoId}`;

    await db.insert(techniqueVideo).values({
      id: videoId,
      userId: coachUserId,
      cloudinaryPublicId: filePath,
      cloudinaryUrl: publicPath,
      secureUrl: publicPath,
      bytes: req.file.size?.toString(),
      format: ext.replace(".", "") || undefined,
    });

    const category = String(req.body?.category || "").trim() || null;
    const strokePreset = String(req.body?.strokePreset || "").trim() || null;
    const shotLabel = String(req.body?.shotLabel || "").trim() || null;
    const skillLevel = String(req.body?.skillLevel || "").trim() || null;
    const viewId = String(req.body?.viewId || "").trim() || null;
    const note = String(req.body?.note || "").trim() || null;

    const sentId = randomUUID();
    const now = new Date();
    await db.insert(coachSentVideo).values({
      id: sentId,
      coachUserId,
      studentUserId,
      techniqueVideoId: videoId,
      category,
      strokePreset,
      shotLabel,
      skillLevel,
      viewId,
      note,
      createdAt: now,
    });

    const coach = await db.query.user.findFirst({
      where: (u, { eq: _eq }) => _eq(u.id, coachUserId),
    });
    const coachName = coach?.name?.trim() || "Your coach";
    const bodyParts = [shotLabel, skillLevel].filter(
      (x): x is string => !!x && x.length > 0
    );

    await db.insert(userNotification).values({
      id: randomUUID(),
      userId: studentUserId,
      kind: "coach_video_sent",
      title: `${coachName} sent you a video`,
      body: bodyParts.length > 0 ? bodyParts.join(" · ") : "Tap to watch it.",
      refType: "coach_sent_video",
      refId: sentId,
      createdAt: now,
    });

    return res.json({ ok: true, sentVideoId: sentId });
  } catch (e: any) {
    if (e?.message?.includes("Only MP4 and MOV")) {
      return res.status(400).json({ error: e.message });
    }
    console.error("[Coach] sent-video error", e);
    return res.status(500).json({ error: "Failed to send video" });
  }
});

/** Recipient (or sending coach) loads a coach-sent video. */
router.get("/sent-video/:id", async (req, res) => {
  try {
    const userId = await resolveUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const id = String(req.params?.id || "").trim();
    if (!id) return res.status(400).json({ error: "Missing id" });

    const sent = await db.query.coachSentVideo.findFirst({
      where: (s, { eq: _eq }) => _eq(s.id, id),
    });
    if (!sent) return res.status(404).json({ error: "Not found" });

    const canRead =
      sent.studentUserId === userId || sent.coachUserId === userId;
    if (!canRead) return res.status(403).json({ error: "Forbidden" });

    if (sent.studentUserId === userId && !sent.viewedAt) {
      await db
        .update(coachSentVideo)
        .set({ viewedAt: new Date() })
        .where(eq(coachSentVideo.id, sent.id));
    }

    const coach = await db.query.user.findFirst({
      where: (u, { eq: _eq }) => _eq(u.id, sent.coachUserId),
    });

    return res.json({
      sentVideo: {
        id: sent.id,
        videoPath: `/technique/video/${sent.techniqueVideoId}`,
        coachName: coach?.name?.trim() || "Your coach",
        category: sent.category,
        strokePreset: sent.strokePreset,
        shotLabel: sent.shotLabel,
        skillLevel: sent.skillLevel,
        viewId: sent.viewId,
        note: sent.note,
        createdAt: sent.createdAt,
      },
    });
  } catch (e: any) {
    console.error("[Coach] get sent-video error", e);
    return res.status(500).json({ error: "Failed to load video" });
  }
});

/** Coach inbox: all videos students have sent to this coach (for the Calendar tab). */
router.get("/submissions", async (req, res) => {
  try {
    const userId = await resolveUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const profile = await db.query.userProfile.findFirst({
      where: (p, { eq: _eq }) => _eq(p.userId, userId),
    });
    if (profile?.coachStudentRole !== "coach") {
      return res.json({ submissions: [] });
    }

    const reviews = await db.query.coachVideoReview.findMany({
      where: (r, { eq: _eq }) => _eq(r.coachUserId, userId),
      orderBy: (r, { desc: _desc }) => [_desc(r.createdAt)],
    });
    if (reviews.length === 0) return res.json({ submissions: [] });

    const studentIds = Array.from(new Set(reviews.map((r) => r.studentUserId)));
    const analysisIds = Array.from(
      new Set(
        reviews
          .map((r) => r.techniqueAnalysisId)
          .filter((id): id is string => !!id)
      )
    );

    const students = studentIds.length
      ? await db.query.user.findMany({
          where: (u) => inArray(u.id, studentIds),
        })
      : [];
    const studentById = new Map(students.map((s) => [s.id, s]));

    const analyses = analysisIds.length
      ? await db.query.techniqueAnalysis.findMany({
          where: (a) => inArray(a.id, analysisIds),
        })
      : [];
    const analysisById = new Map(analyses.map((a) => [a.id, a]));

    const submissions = reviews.map((r) => {
      const student = studentById.get(r.studentUserId);
      const analysis = r.techniqueAnalysisId
        ? analysisById.get(r.techniqueAnalysisId) ?? null
        : null;
      const ai = (analysis?.metrics as Record<string, unknown> | null | undefined)
        ?.ai_analysis as Record<string, unknown> | undefined;
      return {
        reviewId: r.id,
        createdAt: r.createdAt,
        status: r.status,
        studentUserId: r.studentUserId,
        studentName: student?.name?.trim() || "Student",
        studentImage: student?.image ?? null,
        techniqueVideoId: r.techniqueVideoId,
        techniqueAnalysisId: r.techniqueAnalysisId ?? null,
        shotLabel: deriveShotLabelFromAnalysis(analysis),
        score: storedAiScoreToPercent(ai),
      };
    });

    return res.json({ submissions });
  } catch (e: any) {
    console.error("[Coach] submissions error", e);
    return res.status(500).json({ error: "Failed to load submissions" });
  }
});

/** Student profile — uploads list for one linked student (student sends + coach-sent videos). */
router.get("/students/:studentUserId/uploads", async (req, res) => {
  try {
    const coachUserId = await resolveUserId(req);
    if (!coachUserId) return res.status(401).json({ error: "Unauthorized" });

    const studentUserId = String(req.params?.studentUserId || "").trim();
    if (!studentUserId) return res.status(400).json({ error: "Missing student id" });

    const coachProfile = await db.query.userProfile.findFirst({
      where: (p, { eq: _eq }) => _eq(p.userId, coachUserId),
    });
    if (coachProfile?.coachStudentRole !== "coach") {
      return res.status(403).json({ error: "Forbidden" });
    }

    const link = await db.query.coachStudent.findFirst({
      where: (cs, { and: _and, eq: _eq }) =>
        _and(_eq(cs.coachUserId, coachUserId), _eq(cs.studentUserId, studentUserId)),
    });
    if (!link) return res.status(403).json({ error: "Forbidden" });

    const reviews = await db.query.coachVideoReview.findMany({
      where: (r, { and: _and, eq: _eq }) =>
        _and(_eq(r.coachUserId, coachUserId), _eq(r.studentUserId, studentUserId)),
      orderBy: (r, { desc: _desc }) => [_desc(r.createdAt)],
    });

    const videoIds = Array.from(new Set(reviews.map((r) => r.techniqueVideoId)));
    const analysisIds = Array.from(
      new Set(
        reviews.map((r) => r.techniqueAnalysisId).filter((id): id is string => !!id)
      )
    );

    const analysesById = new Map<string, typeof techniqueAnalysis.$inferSelect>();
    const analysesByVideoId = new Map<string, typeof techniqueAnalysis.$inferSelect>();

    if (analysisIds.length > 0) {
      const rows = await db.query.techniqueAnalysis.findMany({
        where: (a, { inArray: _inArray }) => _inArray(a.id, analysisIds),
      });
      for (const a of rows) {
        analysesById.set(a.id, a);
        analysesByVideoId.set(a.techniqueVideoId, a);
      }
    }

    if (videoIds.length > 0) {
      const extra = await db.query.techniqueAnalysis.findMany({
        where: (a, { and: _and, eq: _eq, inArray: _inArray }) =>
          _and(_eq(a.userId, studentUserId), _inArray(a.techniqueVideoId, videoIds)),
        orderBy: (a, { desc: _desc }) => [_desc(a.createdAt)],
      });
      for (const a of extra) {
        if (!analysesById.has(a.id)) analysesById.set(a.id, a);
        if (!analysesByVideoId.has(a.techniqueVideoId)) {
          analysesByVideoId.set(a.techniqueVideoId, a);
        }
      }
    }

    const reviewIds = reviews.map((r) => r.id);
    const annotationRows =
      reviewIds.length > 0
        ? await db.query.coachReviewAnnotation.findMany({
            where: (a, { inArray: _inArray }) => _inArray(a.reviewId, reviewIds),
          })
        : [];
    const commentCountByReview = new Map<string, number>();
    for (const ann of annotationRows) {
      commentCountByReview.set(ann.reviewId, (commentCountByReview.get(ann.reviewId) ?? 0) + 1);
    }

    const studentRowsAsc = reviews
      .map((r) => {
        const analysis =
          (r.techniqueAnalysisId ? analysesById.get(r.techniqueAnalysisId) : null) ??
          analysesByVideoId.get(r.techniqueVideoId) ??
          null;
        const ai = (analysis?.metrics as Record<string, unknown> | null | undefined)
          ?.ai_analysis as Record<string, unknown> | undefined;
        const rating = typeof ai?.rating === "string" ? ai.rating : null;
        const shotLabel = deriveShotLabelFromAnalysis(analysis);
        const title = shotLabel?.trim() || "Technique";
        const annotationCount = commentCountByReview.get(r.id) ?? 0;
        const { goodCount, badCount } = commentTonesForReview(r.coachMarksJson, annotationCount);
        const commentCount = goodCount + badCount;
        return {
          id: r.id,
          kind: "student_upload" as const,
          reviewId: r.id,
          sentVideoId: null as string | null,
          techniqueVideoId: r.techniqueVideoId,
          techniqueAnalysisId: analysis?.id ?? r.techniqueAnalysisId ?? null,
          videoPath: `/technique/video/${r.techniqueVideoId}`,
          title,
          subtitle: null as string | null,
          score: storedAiScoreToPercent(ai),
          lastScore: null as number | null,
          commentCount,
          goodCommentCount: goodCount,
          badCommentCount: badCount,
          rating,
          coachReviewStatus: r.status,
          createdAt: r.createdAt.toISOString(),
        };
      })
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    let prevScore: number | null = null;
    for (const row of studentRowsAsc) {
      row.lastScore = prevScore;
      if (typeof row.score === "number") prevScore = row.score;
    }
    const studentRows = studentRowsAsc.reverse();

    const sentVideos = await db.query.coachSentVideo.findMany({
      where: (s, { and: _and, eq: _eq }) =>
        _and(_eq(s.coachUserId, coachUserId), _eq(s.studentUserId, studentUserId)),
      orderBy: (s, { desc: _desc }) => [_desc(s.createdAt)],
    });

    const coachSentRows = sentVideos.map((s) => {
      const title =
        (typeof s.shotLabel === "string" && s.shotLabel.trim()) ||
        (typeof s.strokePreset === "string" && s.strokePreset.trim()) ||
        (typeof s.category === "string" && s.category.trim()) ||
        "Technique";
      return {
        id: s.id,
        kind: "coach_sent" as const,
        reviewId: null as string | null,
        sentVideoId: s.id,
        techniqueVideoId: s.techniqueVideoId,
        techniqueAnalysisId: null as string | null,
        videoPath: `/technique/video/${s.techniqueVideoId}`,
        title,
        subtitle: "coach",
        score: null as number | null,
        lastScore: null as number | null,
        commentCount: 0,
        goodCommentCount: 0,
        badCommentCount: 0,
        rating: null as string | null,
        coachReviewStatus: null as string | null,
        createdAt: s.createdAt.toISOString(),
      };
    });

    const uploads = [...studentRows, ...coachSentRows].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    return res.json({ uploads });
  } catch (e: any) {
    console.error("[Coach] student uploads error", e);
    return res.status(500).json({ error: "Failed to load student uploads" });
  }
});

export default router;
