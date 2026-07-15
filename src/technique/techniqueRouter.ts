import express from 'express'
import multer from 'multer'
import fs from 'fs'
import path from 'path'
import { fromNodeHeaders } from 'better-auth/node'
import { auth } from '../auth'
import {
  db,
  techniqueVideo,
  techniqueAnalysis,
  techniqueDetectionFrame,
  trainVideo,
  trainSample,
  user,
  userProfile,
  coachStudent,
  coachReviewAnnotation,
  coachVideoReview,
  userNotification,
  techniqueCorrectionRegenerationFeedback,
  type TechniqueDetectionSummary,
  type TechniqueCorrectionFrameInsight,
} from '../db'
import { randomUUID, createHash } from 'crypto'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import {
  extractFrame,
  extractProReferenceFrame,
  probeVideoFrameCount,
  resolveVideoPath,
} from './frameExtractor'
import {
  translateRecommendationsToDeltas,
  classifyHandednessOnly,
  mergeCorrectionShotAndHandedness,
  computeRacketHandConsensusForFrames,
  profileTextToDominantHand,
  generateCorrectedImage,
  generateCorrectedImageFal,
  buildProNeighborCorrectionContext,
  mergeLandmarkDeltas,
  proGapToLandmarkDeltas,
  type FrameLandmarks,
  type LandmarkDelta,
  type CorrectionResult,
  type ShotAndHandedness,
} from './correctionPrompt'
import { generateCorrectedImageComfy, isComfyCorrectionConfigured } from './comfyCorrection'
import { runChat, chatContent } from '../lib/chatProvider'
import {
  llmContentHasJsonObject,
  parseJsonFromLlmContent,
} from '../lib/llmResponse'
import { createAnalyzeTimer, slimMetricsForFailedPersist } from '../lib/analyzeTimings'
import { onAnalysisCompleted, onVideoUploaded } from '../gamification/service'
import {
  calibrateTechniqueScore,
  calibrateTechniqueScoreV61,
  averagePillarOverall,
  finalizeDisplayedScores,
  penaltyAdjustedOverallLegacy,
  applyProLibraryTierScoreConstraint,
} from './scoreCalibration'
import {
  storedAiBreakdownToPercent,
  storedAiConfidenceToPercent,
  storedAiScoreToPercent,
} from './techniqueScoreScale'
import {
  applyUserClipImpactToMetrics,
  estimateFps,
  type ClipMsRange,
  resolveVideoDurationMsForImpact,
  type LabeledPoseFrame,
} from './impactPoseContext'
import {
  retrieveForTechniqueMetrics,
  formatRetrievalForPrompt,
  getTrainSamplePoseSequence,
  pickAlignedProPoseFrame,
  proReferenceFrameCandidates,
  proTimelineRatioForUserFrame,
} from './trainRetrieval'
import {
  computeLobSignal,
  ballPointsFromDetections,
  applyLobTieBreak,
} from './ballTrajectory'
import { attachEvalToMetrics } from '../adminAccuracy/evalSnapshot'
import {
  downsamplePoseFramesForPrompt,
  MAX_POSE_FRAMES_IN_GPT_PROMPT,
  maxCorrectionImageFrames,
  maxPoseFramesForAnalyzePrompt,
} from './poseEmbedding'
import { metricsForClientFetch } from './clientMetrics'
import { sanitizeUserClips } from './techniqueClipLimits'
import {
  deriveHumanShotLabelFromMetrics,
  resolveCanonicalShotFromMetrics,
  shotClassificationFromResolved,
  RETRIEVAL_CONFIDENCE_THRESHOLD,
} from '../train/trainShotDisplay'
import { coachMarksForClient } from '../coach/coachAnnotations'
import {
  attachClipLocalContactFrames,
  contactFramesForPrompt,
} from './yoloContactHints'
import {
  buildCorrectionFrameInsight,
  orderFrameInsights,
} from './correctionFrameInsights'
import { normalizePhysicalMetricsOnAnalysis, parsePhysicalMetrics } from './physicalMetrics'
import { normalizeCorrectionsForClient } from './correctionImageStorage'
import { poseDataForOverlayFetch } from './poseOverlay'
import { fal } from '@fal-ai/client'

function resolveFalKey(): string {
  return String(process.env.FAL_API_KEY || process.env.FAL_KEY || '').trim()
}

const TRANSIENT_PG_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT'])

function buildCompactAnalyzeRetryPrompt(
  metrics: Record<string, unknown>,
  poseFrames: Array<Record<string, unknown>>
): string {
  const frames = poseFrames.slice(0, 4)
  const retrieval = metrics.retrieval as Record<string, unknown> | undefined
  return [
    'Output ONLY one JSON object for padel technique analysis. The first character must be {.',
    'Required keys include: is_padel, score, rating, technique_score, outcome_score, tactics_score, confidence_score, en, es, shot_context, primary_train_category.',
    `retrieval: ${JSON.stringify(retrieval?.shot_hypothesis ?? null)}`,
    `detection_summary: ${JSON.stringify(metrics.detection_summary ?? null)}`,
    `pose_frames (${frames.length} samples): ${JSON.stringify(frames)}`,
  ].join('\n')
}

function isTransientPgError(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } }
  const code = e?.cause?.code ?? e?.code
  if (code && TRANSIENT_PG_CODES.has(String(code))) return true
  const msg = err instanceof Error ? err.message : String(err)
  return /getaddrinfo ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(msg)
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Neon///DNS blips ofttten surface as ENOTFOUND on pooler hostnames; retry before failing the whole analyze. */
async function withPgRetry<T>(label: string, fn: () => Promise<T>, maxAttempts = 4): Promise<T> {
  let last: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      last = err
      if (!isTransientPgError(err) || attempt === maxAttempts) throw err
      const delay = 400 * attempt * attempt
      console.warn(`[Technique] ${label}: transient DB error; retry ${attempt}/${maxAttempts} in ${delay}ms`, {
        message: err instanceof Error ? err.message : String(err),
      })
      await sleepMs(delay)
    }
  }
  throw last
}

/** Stage local upload on fal CsDN so Modal can GET real bytes (ngrok often 404s server-side). */
async function uploadLocalVideoToFalCdn(absPath: string): Promise<string> {
  const key = resolveFalKey()
  if (!key) throw new Error('FAL_KEY or FAL_API_KEY is not set')
  fal.config({ credentials: key })
  const buf = await fs.promises.readFile(absPath)
  const ext = path.extname(absPath).toLowerCase()
  const contentType =
    ext === '.mp4'
      ? 'video/mp4'
      : ext === '.mov'
        ? 'video/quicktime'
        : 'application/octet-stream'
  const blob = new Blob([buf], { type: contentType })
  return fal.storage.upload(blob, { lifecycle: { expiresIn: '1d' } })
}

const MAX_VIDEO_BYTES = 50 * 1024 * 1024
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_VIDEO_BYTES },
  fileFilter: (_req, file, cb) => {
    const allowed = ['video/mp4', 'video/quicktime']
    if (allowed.includes(file.mimetype)) return cb(null, true)
    cb(new Error('Only MP4 and MOV videos up to 50MB are allowed'))
  },
})

const UPLOAD_ROOT = path.join(process.cwd(), 'uploads', 'technique')
const ALLOW_GUEST_TECHNIQUE = process.env.ALLOW_GUEST_TECHNIQUE === 'true'
const GUEST_USER_ID = 'guest-technique-user'
const GUEST_USER_EMAIL = 'guest-technique@xevo.local'
const YOLO_DETECTION_ENABLED = process.env.YOLO_DETECTION_ENABLED === 'true'
const YOLO_DETECTION_WRITE_ENABLED =
  process.env.YOLO_DETECTION_WRITE_ENABLED === 'true'
const YOLO_DETECTION_LOGS = process.env.YOLO_DETECTION_LOGS === 'true'
const YOLO_DETECTION_CONFIDENCE = (() => {
  const n = Number(process.env.YOLO_DETECTION_CONFIDENCE ?? 0.25)
  if (!Number.isFinite(n)) return 0.25
  return Math.max(0, Math.min(1, n))
})()
const YOLO_RACKET_CONFIDENCE = (() => {
  const n = Number(process.env.YOLO_RACKET_CONFIDENCE ?? YOLO_DETECTION_CONFIDENCE)
  if (!Number.isFinite(n)) return YOLO_DETECTION_CONFIDENCE
  return Math.max(0, Math.min(1, n))
})()
const YOLO_BALL_CONFIDENCE = (() => {
  const n = Number(process.env.YOLO_BALL_CONFIDENCE ?? YOLO_DETECTION_CONFIDENCE)
  if (!Number.isFinite(n)) return YOLO_DETECTION_CONFIDENCE
  return Math.max(0, Math.min(1, n))
})()

const router = express.Router()
router.use(express.json({ limit: '50mb' }))
router.use(express.urlencoded({ extended: true }))

type YoloLabel = 'sports_ball' | 'racket'
type DetectionRow = {
  frame: number
  timeMs: number
  label: YoloLabel
  confidence: number
  boxX: number
  boxY: number
  boxW: number
  boxH: number
  trackId: string | null
}

type PoseFrameWithOptionalRacket = {
  frame: number
  landmarks: FrameLandmarks
  racket_bbox?: [number, number, number, number] | null
  racket_conf?: number | null
  racket_hand?: 'left' | 'right' | null
  ball_bbox?: [number, number, number, number] | null
  ball_conf?: number | null
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(1, n))
}

function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(100, Math.round(n)))
}

function techniqueRatingForScore(score: number): 'excellent' | 'good' | 'needs_improvement' | 'poor' {
  if (score >= 80) return 'excellent'
  if (score >= 60) return 'good'
  if (score >= 30) return 'needs_improvement'
  return 'poor'
}

function normalizeYoloLabel(raw: unknown): YoloLabel | null {
  const v = String(raw ?? '').trim().toLowerCase()
  if (v === 'sports_ball' || v === 'sports ball' || v === 'ball') {
    return 'sports_ball'
  }
  if (v === 'racket' || v === 'tennis_racket' || v === 'tennis racket') {
    return 'racket'
  }
  return null
}

function normalizeYoloDetections(
  rawRows: unknown,
  totalFrames: unknown,
  videoDurationMs: number | undefined,
  minConfidence: number,
  racketConfidence: number,
  ballConfidence: number
): DetectionRow[] {
  if (!Array.isArray(rawRows)) return []
  const tf =
    typeof totalFrames === 'number' && Number.isFinite(totalFrames) && totalFrames > 1
      ? totalFrames
      : null
  const safeDurationMs =
    typeof videoDurationMs === 'number' && Number.isFinite(videoDurationMs) && videoDurationMs > 0
      ? videoDurationMs
      : null
  const out: DetectionRow[] = []
  for (const row of rawRows) {
    const r = row as Record<string, unknown>
    const frameRaw = Number(r.frame)
    if (!Number.isFinite(frameRaw) || frameRaw < 0) continue
    const label = normalizeYoloLabel(r.label)
    if (!label) continue
    const confidence = clamp01(Number(r.confidence))
    const classFloor =
      label === 'racket'
        ? Math.min(minConfidence, racketConfidence)
        : Math.min(minConfidence, ballConfidence)
    if (confidence < classFloor) continue
    const bbox = (r.bbox ?? {}) as Record<string, unknown>
    const x = clamp01(Number(bbox.x))
    const y = clamp01(Number(bbox.y))
    const w = clamp01(Number(bbox.w))
    const h = clamp01(Number(bbox.h))
    if (w <= 0 || h <= 0) continue
    const frame = Math.max(0, Math.round(frameRaw))
    const timeMs =
      tf && safeDurationMs
        ? Math.max(0, Math.round((frame / Math.max(1, tf - 1)) * safeDurationMs))
        : 0
    out.push({
      frame,
      timeMs,
      label,
      confidence,
      boxX: Math.round(x * 10000),
      boxY: Math.round(y * 10000),
      boxW: Math.round(w * 10000),
      boxH: Math.round(h * 10000),
      trackId:
        typeof r.track_id === 'string' && r.track_id.trim().length > 0
          ? r.track_id.trim().slice(0, 64)
          : null,
    })
  }
  return out.slice(0, 5000)
}

function summarizeDetections(
  rows: DetectionRow[],
  sampledFrames: unknown,
  enabled: boolean,
  confidenceThreshold: number,
  racketConfidence: number,
  ballConfidence: number
): TechniqueDetectionSummary {
  const sampled =
    typeof sampledFrames === 'number' && Number.isFinite(sampledFrames) && sampledFrames >= 0
      ? Math.round(sampledFrames)
      : 0
  const frameSet = new Set<number>()
  let ballCount = 0
  let racketCount = 0
  let confSum = 0
  for (const row of rows) {
    frameSet.add(row.frame)
    confSum += row.confidence
    if (row.label === 'sports_ball') ballCount += 1
    if (row.label === 'racket') racketCount += 1
  }
  const contactFrames = new Set<number>()
  const byFrame = new Map<number, Set<YoloLabel>>()
  for (const row of rows) {
    const set = byFrame.get(row.frame) ?? new Set<YoloLabel>()
    set.add(row.label)
    byFrame.set(row.frame, set)
  }
  for (const [frame, labels] of byFrame) {
    if (labels.has('sports_ball') && labels.has('racket')) {
      contactFrames.add(frame)
    }
  }
  return {
    enabled,
    model: 'yolov8n',
    sampled_frames: sampled,
    detected_frames: frameSet.size,
    sports_ball_count: ballCount,
    racket_count: racketCount,
    avg_confidence: rows.length ? Number((confSum / rows.length).toFixed(6)) : 0,
    contact_window_frames: [...contactFrames].sort((a, b) => a - b).slice(0, 24),
    confidence_threshold: confidenceThreshold,
    confidence_threshold_racket: racketConfidence,
    confidence_threshold_ball: ballConfidence,
  }
}

async function persistTechniqueDetections(
  analysisId: string,
  rows: DetectionRow[]
): Promise<void> {
  if (!YOLO_DETECTION_WRITE_ENABLED) return
  await db.transaction(async (tx) => {
    await tx
      .delete(techniqueDetectionFrame)
      .where(eq(techniqueDetectionFrame.analysisId, analysisId))
    if (rows.length === 0) return
    await tx.insert(techniqueDetectionFrame).values(
      rows.map((row) => ({
        id: randomUUID(),
        analysisId,
        frame: row.frame,
        timeMs: row.timeMs,
        label: row.label,
        confidence: Math.round(row.confidence * 10000),
        boxX: row.boxX,
        boxY: row.boxY,
        boxW: row.boxW,
        boxH: row.boxH,
        trackId: row.trackId,
      }))
    )
  })
}

function buildCanonicalShotAnalyzeHint(metrics: Record<string, unknown>): string {
  const r = resolveCanonicalShotFromMetrics(metrics)
  if (r.source !== 'retrieval_hypothesis') return ''
  const cat = r.category ? ` — category ${r.category}` : ''
  return `\nCanonical shot from pro library (k-NN): "${r.shotName}"${cat}. Use this for en.shot_context and primary_train_category when consistent with pose.\n`
}

function alignAnalyzeShotContextWithRetrieval(
  aiAnalysis: Record<string, unknown>,
  metrics: Record<string, unknown>
): boolean {
  const resolved = resolveCanonicalShotFromMetrics(metrics)
  if (resolved.source !== 'retrieval_hypothesis') {
    return false
  }
  const en = (aiAnalysis.en ?? {}) as Record<string, unknown>
  const es = (aiAnalysis.es ?? {}) as Record<string, unknown>
  aiAnalysis.en = {
    ...en,
    shot_context: `Pro library match: ${resolved.shotName}.`,
  }
  aiAnalysis.es = {
    ...es,
    shot_context: `Coincidencia con biblioteca pro: ${resolved.shotName}.`,
  }
  if (resolved.category && !aiAnalysis.primary_train_category) {
    aiAnalysis.primary_train_category = resolved.category
  }
  return true
}

function buildDetectionPromptBlock(summary: TechniqueDetectionSummary | null): string {
  if (!summary || !summary.enabled || summary.detected_frames <= 0) {
    return 'YOLO object detections: unavailable or disabled. Infer ball/racket context from pose only when needed.'
  }
  const promptContacts = contactFramesForPrompt(summary)
  const contact =
    Array.isArray(promptContacts) && promptContacts.length > 0
      ? promptContacts.join(', ')
      : 'none'
  return `YOLO object detections (model ${summary.model}):
- sampled frames: ${summary.sampled_frames}
- detected frames: ${summary.detected_frames}
- sports_ball detections: ${summary.sports_ball_count}
- racket detections: ${summary.racket_count}
- average confidence: ${summary.avg_confidence}
- likely contact window frames (ball+racket same frame): ${contact}`
}

function buildCorrectionDetectionHint(summary: TechniqueDetectionSummary | null): string {
  if (!summary || !summary.enabled || summary.detected_frames <= 0) return ''
  const promptContacts = contactFramesForPrompt(summary)
  const contact =
    Array.isArray(promptContacts) && promptContacts.length > 0
      ? promptContacts.slice(0, 10).join(', ')
      : 'none'
  return `\nObject tracking context (YOLO): sports_ball=${summary.sports_ball_count}, racket=${summary.racket_count}, likely contact frames=${contact}. Preserve visible ball and padel racket relation for the same swing instant.`
}

function inferRacketHand(
  landmarks: FrameLandmarks | undefined,
  bbox: [number, number, number, number]
): 'left' | 'right' | null {
  if (!landmarks) return null
  const lw = landmarks.LEFT_WRIST
  const rw = landmarks.RIGHT_WRIST
  if (!lw || !rw) return null
  const cx = (bbox[0] + bbox[2]) / 2
  const cy = (bbox[1] + bbox[3]) / 2
  const dLeft = Math.hypot(Number(lw.x) - cx, Number(lw.y) - cy)
  const dRight = Math.hypot(Number(rw.x) - cx, Number(rw.y) - cy)
  if (!Number.isFinite(dLeft) || !Number.isFinite(dRight)) return null
  return dLeft <= dRight ? 'left' : 'right'
}

function enrichPoseDataWithRacket(
  poseDataRaw: unknown,
  detections: DetectionRow[]
): PoseFrameWithOptionalRacket[] | undefined {
  if (!Array.isArray(poseDataRaw)) return undefined
  const racketByFrame = new Map<number, DetectionRow>()
  const ballByFrame = new Map<number, DetectionRow>()
  for (const d of detections) {
    if (d.label === 'racket') {
      const prev = racketByFrame.get(d.frame)
      if (!prev || d.confidence > prev.confidence) racketByFrame.set(d.frame, d)
    } else if (d.label === 'sports_ball') {
      const prev = ballByFrame.get(d.frame)
      if (!prev || d.confidence > prev.confidence) ballByFrame.set(d.frame, d)
    }
  }
  const out: PoseFrameWithOptionalRacket[] = []
  for (const row of poseDataRaw) {
    const r = row as Record<string, unknown>
    const frame = typeof r.frame === 'number' ? Math.max(0, Math.round(r.frame)) : NaN
    const landmarks =
      r.landmarks && typeof r.landmarks === 'object'
        ? (r.landmarks as FrameLandmarks)
        : undefined
    if (!Number.isFinite(frame) || !landmarks) continue
    const topRacket = racketByFrame.get(frame)
    const topBall = ballByFrame.get(frame)
    let racket_bbox: [number, number, number, number] | null = null
    let ball_bbox: [number, number, number, number] | null = null
    if (topRacket) {
      const x1 = clamp01(topRacket.boxX / 10000)
      const y1 = clamp01(topRacket.boxY / 10000)
      const x2 = clamp01((topRacket.boxX + topRacket.boxW) / 10000)
      const y2 = clamp01((topRacket.boxY + topRacket.boxH) / 10000)
      racket_bbox = [x1, y1, x2, y2]
    }
    if (topBall) {
      const x1 = clamp01(topBall.boxX / 10000)
      const y1 = clamp01(topBall.boxY / 10000)
      const x2 = clamp01((topBall.boxX + topBall.boxW) / 10000)
      const y2 = clamp01((topBall.boxY + topBall.boxH) / 10000)
      ball_bbox = [x1, y1, x2, y2]
    }
    out.push({
      frame,
      landmarks,
      ...(racket_bbox
        ? {
            racket_bbox,
            racket_conf: Number((topRacket?.confidence ?? 0).toFixed(4)),
            racket_hand: inferRacketHand(landmarks, racket_bbox),
          }
        : {}),
      ...(ball_bbox
        ? {
            ball_bbox,
            ball_conf: Number((topBall?.confidence ?? 0).toFixed(4)),
          }
        : {}),
    })
  }
  return out
}

async function ensureGuestUser(): Promise<string | null> {
  const existing = await db.query.user.findFirst({
    where: (u, { eq: _eq }) => _eq(u.id, GUEST_USER_ID),
  })
  if (existing?.id) return existing.id

  try {
    await db.insert(user).values({
      id: GUEST_USER_ID,
      name: 'Technique Guest',
      email: GUEST_USER_EMAIL,
      emailVerified: false,
    })
    return GUEST_USER_ID
  } catch (err) {
    console.error('[Technique] Failed to create guest user', err)
    const retry = await db.query.user.findFirst({
      where: (u, { eq: _eq }) => _eq(u.id, GUEST_USER_ID),
    })
    return retry?.id ?? null
  }
}

async function resolveUserId(req: express.Request): Promise<string | null> {
  const authSession = await auth.api
    .getSession({
      headers: fromNodeHeaders(req.headers),
    })
    .catch((err) => {
      console.error('[Technique] getSession failed in technique route', err)
      return null
    })

  if (authSession?.user?.id) return authSession.user.id

  const authHeader = req.headers.authorization
  const bearerToken =
    typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')
      ? authHeader.slice(7).trim()
      : null

  if (!bearerToken) {
    if (!ALLOW_GUEST_TECHNIQUE) return null
    console.log('[Technique] Guest fallback: no bearer token, using guest user')
    return ensureGuestUser()
  }

  const sessionRow = await db.query.session.findFirst({
    where: (s, { eq: _eq }) => _eq(s.token, bearerToken),
  })

  if (sessionRow?.userId) return sessionRow.userId
  if (!ALLOW_GUEST_TECHNIQUE) return null

  console.log('[Technique] Guest fallback: bearer token not found in session table')
  return ensureGuestUser()
}

router.post('/upload', upload.single('video'), async (req, res) => {
  try {
    console.log('[Technique] Upload received, checking session...', {
      hasAuthHeader: !!req.headers.authorization,
      hasCookie: !!req.headers.cookie,
      authHeaderSample: req.headers.authorization?.slice(0, 30) || null,
    })

    const userId = await resolveUserId(req)
    if (!userId) {
      console.log('[Technique] Unauthorized: no session', {
        hasSession: false,
      })
      return res.status(401).json({ error: 'Unauthorized' })
    }

    if (!req.file?.buffer) {
      console.log('[Technique] Bad request: no video file')
      return res.status(400).json({ error: 'No video file' })
    }

    if (!fs.existsSync(UPLOAD_ROOT)) {
      fs.mkdirSync(UPLOAD_ROOT, { recursive: true })
    }

    const id = randomUUID()
    const ext = path.extname(req.file.originalname || '') || '.mp4'
    const filePath = path.join(UPLOAD_ROOT, `${id}${ext}`)
    const sendVideoToCoachRaw = String(req.body?.sendVideoToCoach ?? '').trim()
    const sendVideoToCoach =
      sendVideoToCoachRaw === '1' || /^true$/i.test(sendVideoToCoachRaw)

    console.log('[Technique] Writing video to disk...', { filePath })
    await fs.promises.writeFile(filePath, req.file.buffer)

    const publicPath = `/technique/video/${id}`

    await db.insert(techniqueVideo).values({
      id,
      userId,
      cloudinaryPublicId: filePath,
      cloudinaryUrl: publicPath,
      secureUrl: publicPath,
      bytes: req.file.size?.toString(),
      format: ext.replace('.', '') || undefined,
    })
    console.log('[Technique] DB insert done, id:', id)

    let coachReviewCreated = 0
    if (sendVideoToCoach) {
      const links = await db.query.coachStudent.findMany({
        where: (cs, { eq: _eq }) => _eq(cs.studentUserId, userId),
      })
      const coachIds = Array.from(
        new Set(
          links
            .map((l) => l.coachUserId)
            .filter((coachId): coachId is string => !!coachId && coachId !== userId)
        )
      )
      if (coachIds.length > 0) {
        const now = new Date()
        await db
          .insert(coachVideoReview)
          .values(
            coachIds.map((coachUserId) => ({
              id: randomUUID(),
              coachUserId,
              studentUserId: userId,
              techniqueVideoId: id,
              status: 'pending',
              createdAt: now,
              updatedAt: now,
            }))
          )
          .onConflictDoNothing()
        coachReviewCreated = coachIds.length
      }
    }

    const payload = {
      id,
      url: publicPath,
      publicId: filePath,
      coachReviewCreated,
    }
    console.log('[Technique] Sending success response')
    void onVideoUploaded(userId).catch((err) => {
      console.error('[Gamification] upload hook failed', err)
    })
    return res.json(payload)
  } catch (e: any) {
    console.error('[Technique] Upload error:', e)
    if (e.message?.includes('Only MP4 and MOV')) {
      return res.status(400).json({ error: e.message })
    }
    return res.status(500).json({ error: e.message || 'Upload failed' })
  }
})

router.get('/video/:id', async (req, res) => {
  try {
    const { id } = req.params
    if (!id) return res.status(400).json({ error: 'Missing id' })

    const video = await db.query.techniqueVideo.findFirst({
      where: (tv, { eq: _eq }) => _eq(tv.id, id),
    })

    if (!video?.cloudinaryPublicId) {
      return res.status(404).json({ error: 'Video not found' })
    }

    const filePath = video.cloudinaryPublicId
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Video file missing' })
    }

    const ext = path.extname(filePath).toLowerCase()
    let mime = 'application/octet-stream'
    if (ext === '.mp4') mime = 'video/mp4'
    else if (ext === '.mov' || ext === '.qt') mime = 'video/quicktime'

    const stat = await fs.promises.stat(filePath)
    const fileSize = stat.size
    const range = req.headers.range

    res.setHeader('Content-Type', mime)
    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')

    if (range) {
      const matches = /bytes=(\d*)-(\d*)/.exec(range)
      const start = matches?.[1] ? parseInt(matches[1], 10) : 0
      const end = matches?.[2] ? parseInt(matches[2], 10) : fileSize - 1

      const safeStart = Number.isFinite(start) ? Math.max(0, start) : 0
      const safeEnd = Number.isFinite(end) ? Math.min(end, fileSize - 1) : fileSize - 1

      if (safeStart > safeEnd || safeStart >= fileSize) {
        res.status(416).setHeader('Content-Range', `bytes */${fileSize}`)
        return res.end()
      }

      const chunkSize = safeEnd - safeStart + 1
      res.status(206)
      res.setHeader('Content-Range', `bytes ${safeStart}-${safeEnd}/${fileSize}`)
      res.setHeader('Content-Length', chunkSize.toString())
      const stream = fs.createReadStream(filePath, { start: safeStart, end: safeEnd })
      stream.pipe(res)
      return
    }

    res.setHeader('Content-Length', fileSize.toString())
    const stream = fs.createReadStream(filePath)
    stream.pipe(res)
  } catch (e: any) {
    console.error('[Technique] Video stream error:', e)
    return res.status(500).json({ error: 'Failed to stream video' })
  }
})

/** Recent technique videos for any user (leaderboard / public player profile gallery). */
router.get('/users/:userId/recent-videos', async (req, res) => {
  try {
    const requesterId = await resolveUserId(req)
    if (!requesterId) {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    const targetUserId = String(req.params.userId || '').trim()
    if (!targetUserId) {
      return res.status(400).json({ error: 'Missing user id' })
    }

    const rawLimit = parseInt(String(req.query.limit ?? '5'), 10)
    const limit = Math.min(10, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 5))

    const analyses = await db
      .select()
      .from(techniqueAnalysis)
      .where(eq(techniqueAnalysis.userId, targetUserId))
      .orderBy(desc(techniqueAnalysis.createdAt))
      .limit(limit)

    const items = analyses.map((a) => ({
      analysisId: a.id,
      techniqueVideoId: a.techniqueVideoId,
      createdAt: a.createdAt.toISOString(),
      videoPath: `/technique/video/${a.techniqueVideoId}`,
    }))

    return res.json({ items })
  } catch (e: any) {
    console.error('[Technique] Recent videos error:', e)
    return res.status(500).json({ error: e.message || 'Failed to load recent videos' })
  }
})

/** List technique analyses for the signed-in user (for Activities calendar). */
router.get('/activities', async (req, res) => {
  try {
    const userId = await resolveUserId(req)
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    const analyses = await db
      .select()
      .from(techniqueAnalysis)
      .where(eq(techniqueAnalysis.userId, userId))
      .orderBy(desc(techniqueAnalysis.createdAt))
      .limit(400)

    const videoIds = [...new Set(analyses.map((a) => a.techniqueVideoId))]
    const videoMap = new Map<string, (typeof techniqueVideo.$inferSelect)>()
    if (videoIds.length > 0) {
      const videos = await db
        .select()
        .from(techniqueVideo)
        .where(inArray(techniqueVideo.id, videoIds))
      for (const v of videos) {
        videoMap.set(v.id, v)
      }
    }

    const reviewRows =
      videoIds.length > 0
        ? await db.query.coachVideoReview.findMany({
            where: (r, { and: _and, eq: _eq, inArray: _inArray }) =>
              _and(
                _eq(r.studentUserId, userId),
                _inArray(r.techniqueVideoId, videoIds)
              ),
            orderBy: (r, { desc: _desc }) => [_desc(r.createdAt)],
          })
        : []
    const reviewIds = reviewRows.map((r) => r.id)
    const reviewAnnotationRows =
      reviewIds.length > 0
        ? await db.query.coachReviewAnnotation.findMany({
            where: (a, { inArray: _inArray }) =>
              _inArray(a.reviewId, reviewIds),
            orderBy: (a, { asc: _asc }) => [_asc(a.timeMs), _asc(a.createdAt)],
            limit: 2000,
          })
        : []
    const annByReviewId = new Map<
      string,
      Array<{
        imageUri: string
        cloudinaryUrl: string | null
        comment: string
        timeMs: number
        tone: string | null
      }>
    >()
    for (const ann of reviewAnnotationRows) {
      const arr = annByReviewId.get(ann.reviewId) ?? []
      arr.push({
        imageUri: ann.imageUri,
        cloudinaryUrl: ann.cloudinaryUrl ?? null,
        comment: ann.comment ?? '',
        timeMs: ann.timeMs,
        tone: ann.tone ?? null,
      })
      annByReviewId.set(ann.reviewId, arr)
    }
    const reviewByVideoId = new Map<
      string,
      {
        id: string
        status: string
        coachFeedbackText: string | null
        coachMarksJson: unknown | null
        submittedAt: Date | null
      }
    >()
    for (const row of reviewRows) {
      const existing = reviewByVideoId.get(row.techniqueVideoId)
      if (!existing) {
        reviewByVideoId.set(row.techniqueVideoId, {
          id: row.id,
          status: row.status,
          coachFeedbackText: row.coachFeedbackText ?? null,
          coachMarksJson: coachMarksForClient(
            row.coachMarksJson,
            annByReviewId.get(row.id) ?? []
          ),
          submittedAt: row.submittedAt ?? null,
        })
        continue
      }
      if (existing.status !== 'completed' && row.status === 'completed') {
        reviewByVideoId.set(row.techniqueVideoId, {
          id: row.id,
          status: row.status,
          coachFeedbackText: row.coachFeedbackText ?? null,
          coachMarksJson: coachMarksForClient(
            row.coachMarksJson,
            annByReviewId.get(row.id) ?? []
          ),
          submittedAt: row.submittedAt ?? null,
        })
      }
    }

    const items = analyses.map((a) => {
      const metrics = a.metrics as Record<string, unknown> | null | undefined
      const ai = metrics?.ai_analysis as Record<string, unknown> | undefined
      const en = ai?.en as Record<string, unknown> | undefined
      const scorePercent = storedAiScoreToPercent(ai)
      const breakdown = storedAiBreakdownToPercent(ai)
      const confidence = storedAiConfidenceToPercent(ai)
      const rating = typeof ai?.rating === 'string' ? String(ai.rating) : null
      const retrieval = metrics?.retrieval as Record<string, unknown> | undefined
      const detectionSummary = metrics?.detection_summary as
        | TechniqueDetectionSummary
        | undefined
      const shotLabel = deriveHumanShotLabelFromMetrics(
        metrics && typeof metrics === 'object' ? metrics : null
      )
      const review = reviewByVideoId.get(a.techniqueVideoId)
      return {
        analysisId: a.id,
        techniqueVideoId: a.techniqueVideoId,
        status: a.status,
        createdAt: a.createdAt.toISOString(),
        feedbackSnippet:
          a.feedbackText && a.feedbackText.length > 0
            ? a.feedbackText.length > 200
              ? `${a.feedbackText.slice(0, 200)}…`
              : a.feedbackText
            : null,
        videoPath: `/technique/video/${a.techniqueVideoId}`,
        score: scorePercent,
        lastScore: null,
        techniqueScore: breakdown.technique,
        outcomeScore: breakdown.outcome,
        tacticsScore: breakdown.tactics,
        confidenceScore: confidence.score,
        confidenceBand: confidence.band,
        uncertaintyPlusMinus: confidence.uncertaintyPlusMinus,
        shotLabel,
        rating,
        coachReviewId: review?.id ?? null,
        coachReviewStatus: review?.status ?? null,
        coachFeedbackText: review?.coachFeedbackText ?? null,
        coachMarksJson: review?.coachMarksJson ?? null,
        coachReviewedAt: review?.submittedAt?.toISOString() ?? null,
        detectionSummary: detectionSummary ?? null,
      }
    })

    return res.json({ items })
  } catch (e: any) {
    console.error('[Technique] Activities list error:', e)
    return res.status(500).json({ error: e.message || 'Failed to load activities' })
  }
})

router.post('/analyze', async (req, res) => {
  try {
    console.log('[Technique] Analyze request received, checking session...')
    const userId = await resolveUserId(req)
    if (!userId) {
      console.log('[Technique] Unauthorized: no session')
      return res.status(401).json({ error: 'Unauthorized' })
    }

    const { techniqueVideoId, clips, videoDurationMs } = req.body as {
      techniqueVideoId?: string
      clips?: Array<{ startMs: number; endMs: number }>
      videoDurationMs?: number
    }
    if (!techniqueVideoId) {
      return res.status(400).json({ error: 'Missing techniqueVideoId' })
    }

    const video = await db.query.techniqueVideo.findFirst({
      where: (tv, { eq: _eq }) => _eq(tv.id, techniqueVideoId),
    })

    if (!video || video.userId !== userId) {
      console.warn('[Technique] Analyze 404: video not found or user mismatch', {
        techniqueVideoId,
        userId,
        videoUserId: video?.userId ?? null,
        videoExists: !!video,
      })
      return res.status(404).json({ error: 'Video not found' })
    }

    const analysisId = randomUUID()
    const timer = createAnalyzeTimer(analysisId)

    await db.insert(techniqueAnalysis).values({
      id: analysisId,
      techniqueVideoId,
      userId,
      status: 'processing',
      metrics: null,
      feedbackText: null,
    })

    await db
      .update(coachVideoReview)
      .set({
        techniqueAnalysisId: analysisId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(coachVideoReview.techniqueVideoId, techniqueVideoId),
          eq(coachVideoReview.studentUserId, userId),
          isNull(coachVideoReview.techniqueAnalysisId)
        )
      )

    const publicVideoBase = (process.env.PUBLIC_VIDEO_BASE_URL || '').trim()
    const publicBase = (process.env.PUBLIC_BASE_URL || '').trim()
    const authBase = (process.env.BETTER_AUTH_URL || '').trim()
    const baseUrl =
      publicVideoBase ||
      publicBase ||
      authBase ||
      'http://localhost:3050'
    const publicHttpVideo =
      Boolean(video.secureUrl && video.secureUrl.startsWith('http'))
    let videoUrl = publicHttpVideo
      ? video.secureUrl!
      : `${baseUrl.replace(/\/$/, '')}${video.secureUrl}`

    const modalWebhook = (process.env.MODAL_WEBHOOK_URL || '').trim()
    const localVideoPath = !publicHttpVideo ? video.cloudinaryPublicId : null

    if (localVideoPath && !fs.existsSync(localVideoPath)) {
      console.error('[Technique] Video file not on disk', { localVideoPath })
      await db
        .update(techniqueAnalysis)
        .set({
          status: 'failed',
          feedbackText: 'Video file is no longer available on the server.',
        })
        .where(eq(techniqueAnalysis.id, analysisId))
      return res.status(500).json({ error: 'Video file missing on server' })
    }

    if (
      modalWebhook &&
      !modalWebhook.includes('localhost') &&
      !publicHttpVideo &&
      localVideoPath &&
      resolveFalKey()
    ) {
      try {
        console.log('[Technique] Staging video via fal.storage for Modal', {
          localVideoPath,
        })
        const falT0 = Date.now()
        videoUrl = await uploadLocalVideoToFalCdn(localVideoPath)
        timer.mark('fal_staging', { durationMs: Date.now() - falT0 })
      } catch (e) {
        console.error('[Technique] fal.storage upload failed', e)
        await db
          .update(techniqueAnalysis)
          .set({
            status: 'failed',
            feedbackText:
              'Could not stage video for analysis. Check FAL_KEY and server logs.',
          })
          .where(eq(techniqueAnalysis.id, analysisId))
        return res.status(500).json({
          error: 'Could not stage video for Modal analysis',
          detail: e instanceof Error ? e.message : String(e),
        })
      }
    }

    if (
      process.env.MODAL_WEBHOOK_URL &&
      !process.env.MODAL_WEBHOOK_URL.includes('localhost') &&
      /localhost|127\.0\.0\.1/i.test(videoUrl)
    ) {
      console.error('[Technique] Modal cannot reach local video URL', { videoUrl })
      await db
        .update(techniqueAnalysis)
        .set({
          status: 'failed',
          feedbackText:
            'Server misconfiguration: set PUBLIC_VIDEO_BASE_URL (or PUBLIC_BASE_URL) to a public URL (e.g. ngrok).',
        })
        .where(eq(techniqueAnalysis.id, analysisId))
      return res.status(500).json({
        error:
          'Video URL is not publicly reachable for Modal. Configure PUBLIC_VIDEO_BASE_URL to your ngrok/Railway URL.',
      })
    }

    console.log('[Technique] Calling Modal webhook...', {
      modalUrl: process.env.MODAL_WEBHOOK_URL,
      baseUrl,
      hasPublicVideoBase: !!publicVideoBase,
      videoUrl,
      analysisId,
    })

    const modalT0 = Date.now()
    const modalRes = await fetch(process.env.MODAL_WEBHOOK_URL as string, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        video_url: videoUrl,
        analysis_id: analysisId,
        model: 'mediapipe',
      }),
    }).then(r => r.json() as any)
    timer.mark('modal', { durationMs: Date.now() - modalT0 })

    if (modalRes?.status !== 'success' || !modalRes.metrics) {
      console.error('[Technique] Modal error', modalRes)
      await db
        .update(techniqueAnalysis)
        .set({
          status: 'failed',
          feedbackText:
            (modalRes && modalRes.message) ||
            'MediaPipe analysis failed at Modal backend.',
        })
        .where(eq(techniqueAnalysis.id, analysisId))

      return res.status(500).json({ error: 'MediaPipe analysis failed' })
    }

    let metrics: any = { ...modalRes.metrics }
    const poseDataEarly = metrics.pose_data as
      | Array<{ frame: number; landmarks: FrameLandmarks }>
      | undefined
    const vdur = resolveVideoDurationMsForImpact(
      videoDurationMs,
      metrics.total_frames ?? 0,
      poseDataEarly
    )
    const clipList = vdur ? sanitizeUserClips(clips, vdur) : undefined
    const clientSentDuration =
      typeof videoDurationMs === 'number' && videoDurationMs > 0
    if (clipList && vdur) {
      metrics = {
        ...metrics,
        video_duration_ms: vdur,
        user_clips: clipList,
        video_duration_ms_source: clientSentDuration ? 'client' : 'inferred',
      }
    }

    const normalizedDetections = YOLO_DETECTION_ENABLED
      ? normalizeYoloDetections(
          metrics?.yolo_detections,
          metrics?.total_frames,
          vdur ?? undefined,
          YOLO_DETECTION_CONFIDENCE,
          YOLO_RACKET_CONFIDENCE,
          YOLO_BALL_CONFIDENCE
        )
      : []
    const detectionSummary = summarizeDetections(
      normalizedDetections,
      metrics?.yolo_summary?.sampled_frames,
      YOLO_DETECTION_ENABLED,
      YOLO_DETECTION_CONFIDENCE,
      YOLO_RACKET_CONFIDENCE,
      YOLO_BALL_CONFIDENCE
    )
    const poseDataWithRacket = enrichPoseDataWithRacket(
      metrics?.pose_data,
      normalizedDetections
    )
    if (poseDataWithRacket) {
      metrics = { ...metrics, pose_data: poseDataWithRacket }
    }
    metrics = {
      ...metrics,
      detection_summary: detectionSummary,
    }

    if (clipList && vdur) {
      const impactApplied = applyUserClipImpactToMetrics(metrics, clipList, vdur)
      if (impactApplied) {
        metrics = {
          ...metrics,
          impact_pose_sequence: impactApplied.impact_pose_sequence ?? undefined,
          impact_frame_resolved: impactApplied.impact_frame_resolved,
          impact_frame_source: impactApplied.impact_frame_source,
        }
      }
    }

    const detectionForPrompt = attachClipLocalContactFrames(detectionSummary, {
      total_frames: metrics?.total_frames,
      video_duration_ms: metrics?.video_duration_ms,
      user_clips: metrics?.user_clips,
      impact_pose_sequence: metrics?.impact_pose_sequence,
    })
    metrics = {
      ...metrics,
      detection_summary: detectionForPrompt,
    }
    delete metrics.yolo_detections
    delete metrics.yolo_summary

    const yoloT0 = Date.now()
    await withPgRetry('analyze-persist-detections', () =>
      persistTechniqueDetections(analysisId, normalizedDetections)
    )
    timer.mark('yolo_persist', {
      durationMs: Date.now() - yoloT0,
      rowCount: normalizedDetections.length,
    })
    if (YOLO_DETECTION_LOGS) {
      console.log('[Technique] YOLO detection ingest', {
        analysisId,
        enabled: YOLO_DETECTION_ENABLED,
        writeEnabled: YOLO_DETECTION_WRITE_ENABLED,
        rowCount: normalizedDetections.length,
        summary: detectionSummary,
      })
    }

    console.log('[Technique] Modal metrics received', {
      analysisId,
      summary: {
        total_frames: metrics?.total_frames,
        analyzed_frames: metrics?.analyzed_frames,
        pose_samples: Array.isArray(metrics?.pose_data) ? metrics.pose_data.length : 0,
        impact_sequence_phases: metrics?.impact_pose_sequence?.length ?? 0,
        detection_frames: metrics?.detection_summary?.detected_frames ?? 0,
      },
    })

    const retrievalT0 = Date.now()
    const retrievalRaw = await retrieveForTechniqueMetrics(metrics)
    const lobSignal = computeLobSignal(
      ballPointsFromDetections(normalizedDetections),
      {
        impactFrame:
          typeof metrics?.impact_frame_resolved === 'number'
            ? metrics.impact_frame_resolved
            : null,
        totalFrames: metrics?.total_frames ?? null,
      }
    )
    const lobTie = applyLobTieBreak(retrievalRaw, lobSignal)
    const retrieval = lobTie.retrieval
    metrics = {
      ...metrics,
      ball_trajectory: lobSignal,
      lob_tiebreak: { applied: lobTie.applied, note: lobTie.note },
      retrieval,
    }
    if (lobTie.applied) {
      console.log('[Technique] lob tie-break applied', {
        analysisId,
        note: lobTie.note,
        lob_score: lobSignal.lob_score,
        is_lob: lobSignal.is_lob,
        shot: retrieval.shot_hypothesis?.stroke_label,
      })
    }
    timer.mark('retrieval', { durationMs: Date.now() - retrievalT0 })

    let aiAnalysis: any = null
    let feedbackText: string | null = null

    try {
      const poseFrameCap = maxPoseFramesForAnalyzePrompt()
      const poseDataForPrompt = downsamplePoseFramesForPrompt(
        metrics.pose_data,
        poseFrameCap
      )
      const poseSummary = metrics.impact_pose_sequence?.length
        ? JSON.stringify({
            note: 'Ball impact frame resolved from YOLO contacts and user clip (not always clip end). Phases: preparation → impact → follow-through. Prefer this sequence for shot type and movement.',
            impact_pose_sequence: metrics.impact_pose_sequence,
            all_pose_samples: poseDataForPrompt,
          })
        : JSON.stringify(poseDataForPrompt)
      const prompt = `
Analyze the video strictly from a padel coaching perspective, not general biomechanics.

${formatRetrievalForPrompt(metrics.retrieval)}
${buildCanonicalShotAnalyzeHint(metrics as Record<string, unknown>)}

${buildDetectionPromptBlock(metrics?.detection_summary ?? null)}

Here is the pose data from several frames of the video (x,y coordinates are normalized 0-1, where 0,0 is top-left):

${poseSummary}

First, identify the type of shot (forehand, backhand, volley, bandeja, vibora, smash, etc.) based on context, contact point, and player positioning on court.

Track the player's movement from preparation -> execution -> follow-through -> recovery, ensuring the entire body is analyzed, including:
- Both arms (racket arm and support arm)
- Racket (pala) path and angle
- Shoulder and hip rotation
- Footwork and stance
- Weight transfer
- Knee flexion and center of gravity

Evaluate technique specifically for padel efficiency, focusing on:
- Preparation timing (early/late)
- Compact vs excessive swing (important in padel)
- Contact point relative to body and ball height
- Use of the support arm for balance and rotation
- Racket face control (open/closed)

Analyze footwork using padel-specific movement patterns, such as:
- Split step timing
- Adjustment steps before contact
- Stability vs crossing steps
- Proper weight transfer (back foot -> front foot when applicable)

Evaluate balance and recovery, including:
- Ability to return to ready position
- Court positioning after the shot
- Efficiency of movement for next ball

Provide feedback in 3 sections:
1) What is done well (padel-specific strengths)
2) Technical errors (clearly explained in padel context)
3) Actionable corrections (simple coaching cues)

Avoid generic fitness or biomechanics language.
Use padel coaching terminology only and keep feedback clear, practical, and applicable in real match play.

Respond ONLY with a single JSON object matching this exact schema:
{
  "is_padel": true,
  "sport_detected": "padel",
  "sport_confidence": 0.85,
  "invalid_reason": "",
  "score": <integer 0-100>,
  "technique_score": <integer 0-100>,
  "outcome_score": <integer 0-100>,
  "tactics_score": <integer 0-100>,
  "confidence_score": <integer 0-100>,
  "confidence": {
    "score": <integer 0-100>,
    "pose_confidence": <integer 0-100>,
    "tracking_stability": <integer 0-100>,
    "visibility_quality": <integer 0-100>
  },
  "physical_metrics": {
    "stability": <integer 0-100>,
    "power": <integer 0-100>,
    "agility": <integer 0-100>,
    "reactions": <integer 0-100>,
    "acceleration": <integer 0-100>
  },
  "rating": "<excellent|good|needs_improvement|poor>",
  "primary_train_category": "<save_return|ground_strokes|net_play|defence_glass|overhead|tactical_specials>",
  "en": {
    "diagnosis": "2-4 sentence summary in English, directly addressing the user as 'you'...",
    "shot_context": "One sentence about shot type and context.",
    "strengths": [
      "You did this padel-specific strength well",
      "Padel-specific strength 2",
      "Padel-specific strength 3"
    ],
    "technical_errors": [
      "You made this technical error in padel context",
      "Technical error 2",
      "Technical error 3"
    ],
    "actionable_corrections": [
      "Next time, you should apply this simple coaching cue",
      "Simple coaching cue 2",
      "Simple coaching cue 3"
    ],
    "observations": [
      "You did this movement detail well",
      "Legacy fallback observation 2",
      "Legacy fallback observation 3"
    ],
    "recommendations": [
      "You can improve this point in your next attempt",
      "Legacy fallback recommendation 2",
      "Legacy fallback recommendation 3"
    ]
  },
  "es": {
    "diagnosis": "Resumen de 2-4 frases en español, dirigiéndote al usuario en segunda persona...",
    "shot_context": "Una frase sobre tipo de golpe y contexto.",
    "strengths": [
      "Fortaleza 1",
      "Fortaleza 2",
      "Fortaleza 3"
    ],
    "technical_errors": [
      "Error técnico 1",
      "Error técnico 2",
      "Error técnico 3"
    ],
    "actionable_corrections": [
      "Corrección accionable 1",
      "Corrección accionable 2",
      "Corrección accionable 3"
    ],
    "observations": [
      "Fallback 1",
      "Fallback 2",
      "Fallback 3"
    ],
    "recommendations": [
      "Fallback 1",
      "Fallback 2",
      "Fallback 3"
    ]
  }
}

Rules:
- physical_metrics (required): score movement quality 0–100 using these padel-specific definitions consistently:
  - stability: base, balance, recovery after contact
  - power: kinetic chain, weight transfer, racket speed through contact
  - agility: footwork adjustment, split-step, court repositioning
  - reactions: readiness, timing to ball, first-step response
  - acceleration: burst into position, explosive approach to ball
- Assume the player is an intermediate-level padel player and tailor feedback to realistic improvements.
- Write all feedback in a personal coaching voice, directly to the user (second person): use "you/your" in English and second person in Spanish.
- Do not use third-person phrasing such as "the player", "they", or equivalent third-person constructions.
- Do not mention handedness or which side the user plays: never say or imply left-handed, right-handed, left hand, right hand, left arm, right arm, dominant hand, or non-dominant hand in any user-facing text (all "en" and "es" fields including diagnosis, shot_context, strengths, technical_errors, actionable_corrections, observations, recommendations). Use neutral coaching terms only, such as racket arm, support arm, forehand or backhand, your swing, or contact side.
- Never use em dashes in any output text.
- First decide whether this is genuinely a Padel action context based on movement patterns.
- Shot labeling discipline:
  - Do not call a shot "smash" or "overhead" unless evidence is clear across multiple frames.
  - Clear overhead evidence means contact phase with hitting arm and racket above shoulder/head level plus overhead extension pattern.
  - If evidence is mixed or weak, choose the closest non-overhead shot or "unknown", and lower confidence.
- In "shot_context", include a confidence tag in text: low, medium, or high.
- If NOT padel (e.g., soccer, gym, generic running, unrelated movement), set:
  - "is_padel": false
  - "sport_detected": "<best guess>"
  - "invalid_reason": "<short reason>"
  - section arrays to empty arrays
  - diagnosis fields to a short explanation that this is not valid padel footage
  - score to 0 and rating to "poor" (0-100 scale)
- score: integer 0-100 reflecting overall technique quality (100=perfect, 0=very poor)
- technique_score: integer 0-100 (execution quality: biomechanics + kinematics)
- outcome_score: integer 0-100 (result quality: success + ball quality)
- tactics_score: integer 0-100 (decision quality + context fit)
- confidence_score: integer 0-100 computed from tracking reliability
- confidence object must include score, pose_confidence, tracking_stability, visibility_quality on 0-100 scale
- rating: one of "excellent" (80-100), "good" (60-79), "needs_improvement" (30-59), "poor" (0-29)
- primary_train_category: exactly one of save_return | ground_strokes | net_play | defence_glass | overhead | tactical_specials — pick the single train pillar this clip best represents (use save_return for serves/returns, ground_strokes for drives from the back, net_play for volleys and net work, defence_glass for defence off the glass, overhead for smashes/víboras/bandejas overhead, tactical_specials only for clearly tactical specialty shots). Must match the clip content, not a guess when uncertain use the closest pillar.
- Do NOT default to 70. Use the full 0-100 scale when evidence supports it (avoid clustering everyone around the same tens digit).
- Scoring anchors (guides, not quotas): multiple major faults across pillars → often ~45–58; solid intermediate club execution with fixable issues → ~62–78; strong form with minor issues → ~78–88; excellent pro-like execution → ~88–96.
- technique_score, outcome_score, and tactics_score must differ when evidence differs; do not copy the same integer into all three pillars unless the clip truly looks equally strong or weak on each.
- Set score close to the average of technique_score, outcome_score, and tactics_score (equal weights) — the app displays overall as that average (server may apply a small display boost after analyze).
- Pro-library reference metadata in this prompt (if any) describes a retrieval neighbor only; do NOT raise scores because that neighbor is tagged advanced — judge only this user's clip.
- Be fair and coaching-oriented: reserve <=50 for clips with multiple major mechanical faults; recreational intermediates doing recognizable padel mechanics with clear fixes often land in the low 60s–high 70s.
- Only respond with valid JSON, no markdown, no other text.
- Your reply must begin with the character { as the first non-whitespace character. Do not write planning, reasoning, or "The user wants" prose.`

      // Technique analyze always uses local Unsloth (never OpenAI fallback).
      const analyzeLlmMessages: Array<{ role: 'system' | 'user'; content: string }> = [
        {
          role: 'system',
          content:
            'You are a padel coaching API. Output exactly one JSON object and nothing else. ' +
            'No planning, no reasoning, no markdown fences, no text before { or after }. ' +
            'The first character of your reply must be {.',
        },
        { role: 'user', content: prompt },
      ]

      timer.mark('llm_prompt', {
        promptChars: prompt.length,
        poseFramesInPrompt: poseDataForPrompt.length,
        maxPoseFramesCap: poseFrameCap,
        provider: 'xevo',
        note: 'Unsloth UI feels faster because it streams tokens; analyze waits for full JSON (stream:false).',
      })

      const llmT0 = Date.now()
      const llmLabel = `technique-analyze:${analysisId}`
      const llmReqBase = {
        model: 'gpt-5-mini-2025-08-07',
        response_format: { type: 'json_object' as const },
        messages: analyzeLlmMessages,
        max_tokens: 8192,
        temperature: 0.2,
      }

      let openaiRes = await runChat(llmReqBase, {
        provider: 'xevo',
        logLabel: llmLabel,
      })
      let content = chatContent(openaiRes)

      if (typeof content === 'string' && !llmContentHasJsonObject(content)) {
        console.warn('[Technique] Local LLM returned no JSON; compact retry (no 18k assistant turn)', {
          analysisId,
          contentChars: content.length,
          preview: content.slice(0, 200),
        })
        openaiRes = await runChat(
          {
            ...llmReqBase,
            messages: [
              analyzeLlmMessages[0]!,
              {
                role: 'user',
                content: buildCompactAnalyzeRetryPrompt(
                  metrics as Record<string, unknown>,
                  poseDataForPrompt as Array<Record<string, unknown>>
                ),
              },
            ],
          },
          { provider: 'xevo', logLabel: `${llmLabel}:json-retry` }
        )
        content = chatContent(openaiRes)
      }

      timer.mark('llm_call', { durationMs: Date.now() - llmT0, ok: true })

      console.log('[Technique] LLM raw response', {
        analysisId,
        provider: 'xevo',
        usage: openaiRes?.usage,
        error: openaiRes?.error,
        contentChars: typeof content === 'string' ? content.length : 0,
        hasJsonObject: typeof content === 'string' ? llmContentHasJsonObject(content) : false,
      })

      if (typeof content === 'string') {
        aiAnalysis = parseJsonFromLlmContent(content, {
          label: llmLabel,
        })
      }

      if (aiAnalysis) {
        const aligned = alignAnalyzeShotContextWithRetrieval(
          aiAnalysis as Record<string, unknown>,
          metrics as Record<string, unknown>
        )
        if (aligned) {
          console.log('[Technique] Aligned analyze shot_context with retrieval', {
            analysisId,
            shot: resolveCanonicalShotFromMetrics(metrics as Record<string, unknown>).shotName,
          })
        }
      }

      if (typeof aiAnalysis?.score === 'number') {
        const modelRawScore = clampPercent(Number(aiAnalysis.score))
        const legacyCalibrated = calibrateTechniqueScore({
          ...aiAnalysis,
          score: modelRawScore,
        })
        const v61 = calibrateTechniqueScoreV61({
          ...aiAnalysis,
          score: modelRawScore,
        })
        const displayed = finalizeDisplayedScores(aiAnalysis, v61)
        const topProSkill =
          metrics?.retrieval?.neighbors?.[0]?.skill_level ??
          metrics?.retrieval?.shot_hypothesis?.skill_level
        const s = applyProLibraryTierScoreConstraint(displayed.overall, topProSkill)
        aiAnalysis.score_model_raw = Math.round(modelRawScore)
        aiAnalysis.score_calibrated_before_pro_tier = legacyCalibrated
        aiAnalysis.score = s
        aiAnalysis.score_scale = 'percent'
        aiAnalysis.scoring_version = 'v6.1.3'
        aiAnalysis.technique_score = clampPercent(displayed.breakdown.technique)
        aiAnalysis.outcome_score = clampPercent(displayed.breakdown.outcome)
        aiAnalysis.tactics_score = clampPercent(displayed.breakdown.tactics)
        aiAnalysis.confidence_score = clampPercent(displayed.confidence.score)
        aiAnalysis.breakdown = {
          technique: clampPercent(displayed.breakdown.technique),
          outcome: clampPercent(displayed.breakdown.outcome),
          tactics: clampPercent(displayed.breakdown.tactics),
        }
        aiAnalysis.confidence = {
          score: clampPercent(displayed.confidence.score),
          pose_confidence: clampPercent(displayed.confidence.pose_confidence),
          tracking_stability: clampPercent(displayed.confidence.tracking_stability),
          visibility_quality: clampPercent(displayed.confidence.visibility_quality),
          band: displayed.confidence.band,
          uncertainty_plus_minus: displayed.confidence.uncertainty_plus_minus,
        }
        aiAnalysis.calibration_trace = {
          pillar_blend: displayed.pillarBlendPreBoost,
          score_display_boost: displayed.scoreDisplayBoost,
          score_display_boost_merit: displayed.scoreDisplayBoostMerit,
          score_display_boost_factors: displayed.scoreDisplayBoostFactors,
          overall_displayed: s,
          weighted_formula:
            'overall = avg(pillars each + round(boost * (0.88 + 0.12 * pillar/100))); boost 1–12 from merit (pillars, confidence, errors, strengths)',
          legacy_penalty_adjusted_audit: penaltyAdjustedOverallLegacy(
            aiAnalysis,
            displayed.pillarBlendPreBoost
          ),
          model_score_raw: Math.round(modelRawScore),
          pro_library_neighbor_skill: topProSkill ?? null,
          pro_tier_score_constraint: 'disabled_v6.1.2 (no advanced-neighbor floor)',
        }
        aiAnalysis.rating = techniqueRatingForScore(s)
      }

      if (aiAnalysis) {
        normalizePhysicalMetricsOnAnalysis(aiAnalysis as Record<string, unknown>)
      }

      const isPadelSignal =
        aiAnalysis?.is_padel === false ||
        (typeof aiAnalysis?.sport_detected === 'string' &&
          !/padel/i.test(aiAnalysis.sport_detected))

      if (isPadelSignal) {
        const reason =
          aiAnalysis?.invalid_reason ||
          aiAnalysis?.en?.diagnosis ||
          aiAnalysis?.diagnosis ||
          'This video does not appear to be a padel action clip.'
        console.log('[Technique] Non-padel footage detected; suppressing score output', {
          analysisId,
          sport_detected: aiAnalysis?.sport_detected,
          reason,
        })
        aiAnalysis = null
        feedbackText =
          'No analysis result was generated because this video does not appear to be padel footage. Please upload a clear padel rally or shot clip to continue.'
      } else {
        feedbackText =
          aiAnalysis?.en?.diagnosis ||
          aiAnalysis?.diagnosis ||
          'Technique analysis completed.'
      }
    } catch (err) {
      timer.mark('llm_call', {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      })
      const cause = err instanceof Error && err.cause instanceof Error ? err.cause : null
      const dnsCode =
        cause && 'code' in cause ? String((cause as NodeJS.ErrnoException).code) : ''
      if (dnsCode === 'ENOTFOUND') {
        console.error(
          '[Technique] GPT analysis skipped: DNS could not resolve api.openai.com (offline, VPN, firewall, or flaky DNS). Pose/retrieval data still saved.',
          cause?.message ?? err
        )
      } else {
        console.error('[Technique] GPT analysis error:', err)
      }
      aiAnalysis = null
      feedbackText = 'AI analysis failed; only pose metrics are available.'
    }

    const combinedMetricsRaw =
      aiAnalysis != null ? { ...metrics, ai_analysis: aiAnalysis } : metrics
    const combinedMetrics = attachEvalToMetrics(
      combinedMetricsRaw as Record<string, unknown>,
      aiAnalysis as Record<string, unknown> | null
    )
    const metricsForDb =
      aiAnalysis != null
        ? combinedMetrics
        : slimMetricsForFailedPersist(combinedMetrics)

    const cm = combinedMetrics as Record<string, unknown>
    const aiSnap = cm.ai_analysis as Record<string, unknown> | undefined
    const retSnap = cm.retrieval as Record<string, unknown> | undefined
    const hypSnap = retSnap?.shot_hypothesis as Record<string, unknown> | undefined
    console.log('[Technique] Combined metrics before DB update', {
      analysisId,
      hasAiAnalysis: !!aiAnalysis,
      metricsPreview: {
        total_frames: cm.total_frames,
        analyzed_frames: cm.analyzed_frames,
        pose_samples: Array.isArray(cm.pose_data) ? cm.pose_data.length : 0,
        ai_score: aiSnap?.score,
        ai_rating: aiSnap?.rating,
        retrieval_confidence: hypSnap?.confidence,
        retrieval_shot: hypSnap?.stroke_label,
      },
    })

    const dbT0 = Date.now()
    await withPgRetry('analyze-complete', () =>
      db
        .update(techniqueAnalysis)
        .set({
          status: aiAnalysis ? 'completed' : 'failed',
          metrics: metricsForDb as any,
          feedbackText,
        })
        .where(eq(techniqueAnalysis.id, analysisId))
    )
    timer.mark('db_update', {
      durationMs: Date.now() - dbT0,
      status: aiAnalysis ? 'completed' : 'failed',
      metricsPayloadSlim: !aiAnalysis,
    })

    console.log('[Technique] Analysis row updated, id:', analysisId)
    if (aiAnalysis) {
      void onAnalysisCompleted(userId).catch((err) => {
        console.error('[Gamification] analysis hook failed', err)
      })
    }
    timer.summary()
    return res.json({ analysisId })
  } catch (e: any) {
    console.error('[Technique] Analyze error:', e)
    return res.status(500).json({ error: 'Analyze failed' })
  }
})

router.get('/analysis/:id', async (req, res) => {
  try {
    console.log('[Technique] Analysis fetch received, checking session...')
    const userId = await resolveUserId(req)
    if (!userId) {
      console.log('[Technique] Unauthorized: no session')
      return res.status(401).json({ error: 'Unauthorized' })
    }

    const { id } = req.params
    if (!id) {
      return res.status(400).json({ error: 'Missing analysis id' })
    }

    const analysis = await db.query.techniqueAnalysis.findFirst({
      where: (ta, { and, eq: _eq }) =>
        and(_eq(ta.id, id), _eq(ta.userId, userId)),
    })

    if (!analysis) {
      return res.status(404).json({ error: 'Analysis not found' })
    }

    const reviewRows = await db.query.coachVideoReview.findMany({
      where: (r, { and: _and, eq: _eq }) =>
        _and(
          _eq(r.studentUserId, userId),
          _eq(r.techniqueVideoId, analysis.techniqueVideoId)
        ),
      orderBy: (r, { desc: _desc }) => [_desc(r.createdAt)],
      limit: 5,
    })
    const coachReview =
      reviewRows.find((r) => r.status === 'completed') ?? reviewRows[0] ?? null
    const coachReviewAnnotations = coachReview
      ? await db.query.coachReviewAnnotation.findMany({
          where: (a, { eq: _eq }) => _eq(a.reviewId, coachReview.id),
          orderBy: (a, { asc: _asc }) => [_asc(a.timeMs), _asc(a.createdAt)],
          limit: 200,
        })
      : []

    const metricsObj = analysis.metrics as Record<string, unknown> | null
    const detectionSummary =
      (metricsObj?.detection_summary as TechniqueDetectionSummary | undefined) ?? null
    const ai = (metricsObj?.ai_analysis as Record<string, unknown> | undefined) ?? undefined
    const aiSummary = ai
      ? {
          score: storedAiScoreToPercent(ai),
          rating: typeof ai.rating === 'string' ? ai.rating : null,
          ...storedAiBreakdownToPercent(ai),
          confidence: storedAiConfidenceToPercent(ai),
          physicalMetrics: parsePhysicalMetrics(ai.physical_metrics) ?? undefined,
        }
      : null
    const clientMetrics = metricsForClientFetch(
      metricsObj as Record<string, unknown> | null
    )
    return res.json({
      id: analysis.id,
      techniqueVideoId: analysis.techniqueVideoId,
      status: analysis.status,
      metrics: clientMetrics,
      detectionSummary,
      aiSummary,
      feedbackText: analysis.feedbackText,
      createdAt: analysis.createdAt,
      coachReview: coachReview
        ? {
            id: coachReview.id,
            status: coachReview.status,
            coachFeedbackText: coachReview.coachFeedbackText ?? null,
            coachMarksJson: coachMarksForClient(
              coachReview.coachMarksJson,
              coachReviewAnnotations.map((a) => ({
                imageUri: a.imageUri,
                cloudinaryUrl: a.cloudinaryUrl ?? null,
                comment: a.comment ?? '',
                timeMs: a.timeMs,
                tone: a.tone ?? null,
              }))
            ),
            submittedAt: coachReview.submittedAt ?? null,
          }
        : null,
    })
  } catch (e: any) {
    console.error('[Technique] Analysis fetch error:', e)
    return res.status(500).json({ error: 'Failed to fetch analysis' })
  }
})

/** Pose + YOLO overlay data for video player (kept separate from slim analysis GET). */
router.get('/analysis/:id/pose-overlay', async (req, res) => {
  try {
    const userId = await resolveUserId(req)
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
    const { id } = req.params
    if (!id) {
      return res.status(400).json({ error: 'Missing analysis id' })
    }
    const analysis = await db.query.techniqueAnalysis.findFirst({
      where: (ta, { and, eq: _eq }) =>
        and(_eq(ta.id, id), _eq(ta.userId, userId)),
    })
    if (!analysis) {
      return res.status(404).json({ error: 'Analysis not found' })
    }
    const metricsObj = (analysis.metrics ?? {}) as Record<string, unknown>
    const pose_data = poseDataForOverlayFetch(metricsObj.pose_data)
    return res.json({
      analysisId: id,
      pose_data,
      total_frames: metricsObj.total_frames ?? null,
      analyzed_frames: metricsObj.analyzed_frames ?? null,
      video_duration_ms: metricsObj.video_duration_ms ?? null,
      detection_summary: metricsObj.detection_summary ?? null,
      pose_data_total_samples: Array.isArray(metricsObj.pose_data)
        ? metricsObj.pose_data.length
        : 0,
    })
  } catch (e: any) {
    console.error('[Technique] Pose-overlay fetch error:', e)
    return res.status(500).json({ error: 'Failed to fetch pose overlay' })
  }
})

/** Correction image pairs (URLs, not base64) — fetch separately to avoid OOM on mobile. */
router.get('/analysis/:id/correction-images', async (req, res) => {
  try {
    const userId = await resolveUserId(req)
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
    const { id } = req.params
    if (!id) {
      return res.status(400).json({ error: 'Missing analysis id' })
    }
    const analysis = await db.query.techniqueAnalysis.findFirst({
      where: (ta, { and, eq: _eq }) =>
        and(_eq(ta.id, id), _eq(ta.userId, userId)),
    })
    if (!analysis) {
      return res.status(404).json({ error: 'Analysis not found' })
    }
    const metrics = (analysis.metrics ?? {}) as Record<string, unknown>
    const toClient = (raw: unknown): CorrectionResult[] => {
      if (!Array.isArray(raw) || raw.length === 0) return []
      return normalizeCorrectionsForClient(id, raw as CorrectionResult[])
    }
    return res.json({
      analysisId: id,
      correction_images: toClient(metrics.correction_images),
      correction_images_fal: toClient(metrics.correction_images_fal),
      correction_images_comfy: toClient(metrics.correction_images_comfy),
      correction_context: metrics.correction_context ?? null,
      correction_context_fal: metrics.correction_context_fal ?? null,
      correction_context_comfy: metrics.correction_context_comfy ?? null,
    })
  } catch (e: any) {
    console.error('[Technique] Correction-images fetch error:', e)
    return res.status(500).json({ error: 'Failed to fetch correction images' })
  }
})

/** Gemini image generation is heavy; parallel calls often fail with "fetch failed" / 429 — run sequentially. */
const MAX_CONCURRENT_FRAMES = 1
type PoseFrameRow = { frame: number; landmarks: FrameLandmarks }

function frameIndexToMs(frame: number, fps: number): number {
  return (frame / fps) * 1000
}

/** Restrict pose samples to times inside user-marked clip ranges (Step 2). */
function poseDataWithinUserClips(
  poseData: PoseFrameRow[],
  clips: ClipMsRange[],
  videoDurationMs: number,
  totalFrames: number
): PoseFrameRow[] {
  if (!clips.length || videoDurationMs <= 0) return poseData
  const fps = estimateFps(totalFrames, videoDurationMs)
  const filtered = poseData.filter((p) => {
    const ms = frameIndexToMs(p.frame, fps)
    return clips.some((c) => ms >= c.startMs && ms <= c.endMs)
  })
  return filtered.length > 0 ? filtered : poseData
}

/** Evenly sample pose frames across the clip (spread of the motion). */
function selectPoseFramesForCorrections(
  poseData: PoseFrameRow[],
  maxFrames: number,
  opts?: {
    userClips?: ClipMsRange[]
    videoDurationMs?: number
    totalFrames?: number
  }
): PoseFrameRow[] {
  let pool = poseData
  if (
    opts?.userClips?.length &&
    typeof opts.videoDurationMs === 'number' &&
    opts.videoDurationMs > 0
  ) {
    pool = poseDataWithinUserClips(
      poseData,
      opts.userClips,
      opts.videoDurationMs,
      opts.totalFrames ?? 0
    )
  }
  const sorted = [...pool].sort((a, b) => a.frame - b.frame)
  const n = sorted.length
  if (n <= maxFrames) return sorted
  if (maxFrames <= 1) return [sorted[Math.min(n - 1, Math.floor(n / 2))]]
  const picked: PoseFrameRow[] = []
  const seen = new Set<number>()
  for (let k = 0; k < maxFrames; k++) {
    const i = Math.round((k / (maxFrames - 1)) * (n - 1))
    const p = sorted[i]
    if (!seen.has(p.frame)) {
      seen.add(p.frame)
      picked.push(p)
    }
  }
  let idx = 0
  while (picked.length < maxFrames && idx < n) {
    const p = sorted[idx++]
    if (!seen.has(p.frame)) {
      seen.add(p.frame)
      picked.push(p)
    }
  }
  return picked.sort((a, b) => a.frame - b.frame)
}

/** If metrics already hold more (legacy), return at most maxFrames spread across time. */
function limitCorrectionsToMaxFrames<T extends { frame: number }>(
  corrections: T[],
  maxFrames: number
): T[] {
  if (corrections.length <= maxFrames) return corrections
  const sorted = [...corrections].sort((a, b) => a.frame - b.frame)
  const n = sorted.length
  if (maxFrames <= 1) return [sorted[Math.min(n - 1, Math.floor(n / 2))]]
  const picked: T[] = []
  const seen = new Set<number>()
  for (let k = 0; k < maxFrames; k++) {
    const i = Math.round((k / (maxFrames - 1)) * (n - 1))
    const c = sorted[i]
    if (!seen.has(c.frame)) {
      seen.add(c.frame)
      picked.push(c)
    }
  }
  let idx = 0
  while (picked.length < maxFrames && idx < n) {
    const c = sorted[idx++]
    if (!seen.has(c.frame)) {
      seen.add(c.frame)
      picked.push(c)
    }
  }
  return picked.sort((a, b) => a.frame - b.frame)
}

function looksLikeBadCachedCorrections(
  corrections: Array<{ frame: number; originalImage: string; correctedImage: string }>
): boolean {
  if (!Array.isArray(corrections) || corrections.length <= 1) return false

  const uniqueFrames = new Set(corrections.map((c) => c.frame)).size
  const uniqueOriginals = new Set(corrections.map((c) => c.originalImage)).size

  if (uniqueOriginals <= 1) return true
  if (uniqueFrames < corrections.length) return true

  return false
}

function orderCorrectionsByFrames(
  correctionsByFrame: Map<number, CorrectionResult>,
  frameOrder: number[]
): CorrectionResult[] {
  return frameOrder
    .map((frame) => correctionsByFrame.get(frame))
    .filter((c): c is CorrectionResult => !!c)
}

function isGeminiCorrectionConfigured(): boolean {
  return Boolean(String(process.env.GEMINI_API_KEY ?? '').trim())
}

/** Default when the client omits imageProvider (production: gemini). */
function resolveDefaultCorrectionImageProvider(): 'gemini' | 'comfy' {
  const requested = String(process.env.XEVO_DEFAULT_CORRECTION_IMAGE_PROVIDER ?? 'gemini')
    .trim()
    .toLowerCase()
  const geminiOk = isGeminiCorrectionConfigured()
  const comfyOk = isComfyCorrectionConfigured()

  if (requested === 'comfy' && comfyOk) return 'comfy'
  if (requested === 'gemini' && geminiOk) return 'gemini'
  if (geminiOk) return 'gemini'
  if (comfyOk) return 'comfy'
  return 'gemini'
}

router.post('/correction-images', async (req, res) => {
  try {
    const rawProvider = String(
      (req.body as { imageProvider?: string })?.imageProvider ?? ''
    ).toLowerCase()
    // `XEVO_DISABLE_IMAGE_FALLBACK=true` opts into strict "no fallback" mode for
    // production-stack testing: legacy providers (gemini/fal) cannot be invoked
    // explicitly or implicitly, and a missing/unconfigured Comfy returns 503
    // instead of silently routing to Gemini. Default behaviour is unchanged.
    const disableImageFallback =
      String(process.env.XEVO_DISABLE_IMAGE_FALLBACK ?? '').trim().toLowerCase() === 'true'

    if (disableImageFallback && (rawProvider === 'gemini' || rawProvider === 'fal')) {
      console.warn('[Technique] Legacy image provider blocked by XEVO_DISABLE_IMAGE_FALLBACK', {
        rawProvider,
      })
      return res.status(503).json({
        error:
          `Image provider '${rawProvider}' is disabled by XEVO_DISABLE_IMAGE_FALLBACK=true. ` +
          `Send imageProvider="comfy" or unset the flag.`,
      })
    }

    // Default: Gemini when GEMINI_API_KEY is set (XEVO_DEFAULT_CORRECTION_IMAGE_PROVIDER).
    // Explicit `imageProvider` from the app is honored unless blocked by disable-fallback.
    let imageProvider: 'gemini' | 'fal' | 'comfy'
    if (rawProvider === 'fal') imageProvider = 'fal'
    else if (rawProvider === 'comfy') imageProvider = 'comfy'
    else if (rawProvider === 'gemini') imageProvider = 'gemini'
    else if (disableImageFallback) {
      if (isComfyCorrectionConfigured()) imageProvider = 'comfy'
      else {
        console.warn(
          '[Technique] Comfy not configured and XEVO_DISABLE_IMAGE_FALLBACK=true — refusing Gemini default'
        )
        return res.status(503).json({
          error:
            'ComfyUI is not configured and image fallback is disabled ' +
            '(XEVO_DISABLE_IMAGE_FALLBACK=true). Configure COMFYUI_* env vars or unset the flag.',
        })
      }
    } else {
      imageProvider = resolveDefaultCorrectionImageProvider()
    }
    const correctionImagesKey =
      imageProvider === 'fal'
        ? 'correction_images_fal'
        : imageProvider === 'comfy'
          ? 'correction_images_comfy'
          : 'correction_images'
    const correctionContextKey =
      imageProvider === 'fal'
        ? 'correction_context_fal'
        : imageProvider === 'comfy'
          ? 'correction_context_comfy'
          : 'correction_context'

    console.log('[Technique] Correction-images request received', {
      imageProvider,
    })
    const userId = await resolveUserId(req)
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    const { analysisId, frameIndices, forceRegenerate, regenerationFeedback } =
      req.body as {
        analysisId?: string
        frameIndices?: number[]
        forceRegenerate?: boolean
        regenerationFeedback?: { message?: string }
      }
    const skipCache = forceRegenerate === true
    const requestedFrameIndices = Array.isArray(frameIndices)
      ? Array.from(
          new Set(frameIndices.filter((f) => Number.isFinite(f)))
        ).slice(0, maxCorrectionImageFrames())
      : null

    if (!analysisId) {
      return res.status(400).json({ error: 'Missing analysisId' })
    }

    const analysis = await db.query.techniqueAnalysis.findFirst({
      where: (ta, { and, eq: _eq }) =>
        and(_eq(ta.id, analysisId), _eq(ta.userId, userId)),
    })

    if (!analysis) {
      return res.status(404).json({ error: 'Analysis not found' })
    }

    if (analysis.status !== 'completed') {
      return res.status(400).json({ error: 'Analysis is not completed yet' })
    }

    if (skipCache) {
      const feedbackMessage =
        typeof regenerationFeedback?.message === 'string'
          ? regenerationFeedback.message.trim()
          : ''
      if (!feedbackMessage) {
        return res.status(400).json({
          error: 'Regeneration feedback message is required',
        })
      }
      const metricsForSnapshot = analysis.metrics as {
        ai_analysis?: {
          en?: {
            diagnosis?: string
            shot_context?: string
            recommendations?: string[]
            actionable_corrections?: string[]
            technical_errors?: string[]
            strengths?: string[]
          }
        }
        correction_context?: { frame_indices?: number[] }
      } | null
      const enSnap = metricsForSnapshot?.ai_analysis?.en
      const snapshotFrameIndices =
        requestedFrameIndices && requestedFrameIndices.length > 0
          ? requestedFrameIndices
          : Array.isArray(metricsForSnapshot?.correction_context?.frame_indices)
            ? metricsForSnapshot!.correction_context!.frame_indices
            : undefined
      await db.insert(techniqueCorrectionRegenerationFeedback).values({
        id: randomUUID(),
        userId,
        techniqueAnalysisId: analysisId,
        message: feedbackMessage,
        coachingSnapshot: {
          diagnosis: enSnap?.diagnosis ?? null,
          shot_context: enSnap?.shot_context ?? null,
          recommendations: enSnap?.recommendations,
          actionable_corrections: enSnap?.actionable_corrections,
          technical_errors: enSnap?.technical_errors,
          strengths: enSnap?.strengths,
          frame_indices: snapshotFrameIndices,
        },
      })
      console.log('[Technique] Saved correction regeneration feedback', {
        analysisId,
        userId,
      })
    }

    const existingCorrections = (analysis.metrics as any)?.[correctionImagesKey]
    let cachedCorrections: CorrectionResult[] = []
    if (
      !skipCache &&
      Array.isArray(existingCorrections) &&
      existingCorrections.length > 0
    ) {
      const badCache = looksLikeBadCachedCorrections(existingCorrections)
      if (!badCache) {
        cachedCorrections = existingCorrections
        const cachedByFrame = new Map(
          cachedCorrections.map((c: CorrectionResult) => [c.frame, c] as const)
        )

        if (!requestedFrameIndices || requestedFrameIndices.length === 0) {
          const limited = limitCorrectionsToMaxFrames(
            cachedCorrections,
            maxCorrectionImageFrames()
          )
          console.log('[Technique] Returning cached correction images', {
            analysisId,
            count: limited.length,
          })
          return res.json({
            provider: imageProvider,
            corrections: normalizeCorrectionsForClient(analysisId, limited),
          })
        }

        const cachedRequested = orderCorrectionsByFrames(
          cachedByFrame,
          requestedFrameIndices
        )
        if (cachedRequested.length === requestedFrameIndices.length) {
          console.log('[Technique] Returning cached correction image subset', {
            analysisId,
            requested: requestedFrameIndices,
            count: cachedRequested.length,
          })
          return res.json({
            provider: imageProvider,
            corrections: normalizeCorrectionsForClient(analysisId, cachedRequested),
          })
        }
      }

      console.warn('[Technique] Ignoring suspicious cached correction images; regenerating', {
        analysisId,
        count: existingCorrections.length,
      })
    } else if (skipCache) {
      console.log('[Technique] forceRegenerate=true — skipping cached correction images', {
        analysisId,
      })
    }

    const metrics = analysis.metrics as any
    const poseData: Array<{ frame: number; landmarks: FrameLandmarks }> =
      metrics?.pose_data ?? []
    const aiAnalysis = metrics?.ai_analysis
    const enAnalysis = aiAnalysis?.en
    const detectionHint = buildCorrectionDetectionHint(
      (metrics?.detection_summary ?? null) as TechniqueDetectionSummary | null
    )

    if (!enAnalysis || poseData.length === 0) {
      return res
        .status(400)
        .json({ error: 'No pose data or AI analysis available' })
    }

    let poseSequence = metrics?.impact_pose_sequence as
      | LabeledPoseFrame[]
      | undefined
    const durationForRebuild = resolveVideoDurationMsForImpact(
      typeof metrics?.video_duration_ms === 'number'
        ? metrics.video_duration_ms
        : undefined,
      metrics?.total_frames ?? 0,
      poseData
    )
    if (metrics?.user_clips?.length && durationForRebuild) {
      const impactApplied = applyUserClipImpactToMetrics(
        {
          ...metrics,
          pose_data: poseData,
        },
        metrics.user_clips as ClipMsRange[],
        durationForRebuild
      )
      if (impactApplied?.impact_pose_sequence?.length) {
        poseSequence = impactApplied.impact_pose_sequence
      }
    }

    const video = await db.query.techniqueVideo.findFirst({
      where: (tv, { eq: _eq }) => _eq(tv.id, analysis.techniqueVideoId),
    })

    if (!video?.cloudinaryPublicId) {
      return res.status(404).json({ error: 'Video file not found' })
    }

    const videoPath = resolveVideoPath(video.cloudinaryPublicId)
    if (!fs.existsSync(videoPath)) {
      return res.status(404).json({ error: 'Video file missing from disk' })
    }

    const requestedFrames: PoseFrameRow[] =
      requestedFrameIndices && requestedFrameIndices.length > 0
        ? requestedFrameIndices
            .map((fi) => poseData.find((p) => p.frame === fi))
            .filter((p): p is PoseFrameRow => !!p)
        : selectPoseFramesForCorrections(poseData, maxCorrectionImageFrames(), {
            userClips: Array.isArray(metrics?.user_clips)
              ? (metrics.user_clips as ClipMsRange[])
              : undefined,
            videoDurationMs:
              typeof metrics?.video_duration_ms === 'number'
                ? metrics.video_duration_ms
                : undefined,
            totalFrames:
              typeof metrics?.total_frames === 'number' ? metrics.total_frames : 0,
          })

    if (requestedFrames.length === 0) {
      return res.status(400).json({ error: 'No matching frames found' })
    }

    const cachedByFrame = new Map(
      cachedCorrections.map((c: CorrectionResult) => [c.frame, c] as const)
    )
    const framesToGenerate = requestedFrames.filter(
      (f) => !cachedByFrame.has(f.frame)
    )

    const impactFrameNum = poseSequence?.find((p) => p.phase === 'impact')?.frame
    if (impactFrameNum != null && framesToGenerate.length > 1) {
      framesToGenerate.sort(
        (a, b) =>
          Math.abs(a.frame - impactFrameNum) -
          Math.abs(b.frame - impactFrameNum)
      )
    }

    if (framesToGenerate.length === 0) {
      const raw =
        requestedFrameIndices && requestedFrameIndices.length > 0
          ? orderCorrectionsByFrames(cachedByFrame, requestedFrameIndices)
          : cachedCorrections
      return res.json({
        provider: imageProvider,
        corrections: limitCorrectionsToMaxFrames(raw, maxCorrectionImageFrames()),
      })
    }

    if (imageProvider === 'fal') {
      const fk = String(process.env.FAL_API_KEY || process.env.FAL_KEY || '').trim()
      if (!fk) {
        return res.status(503).json({
          error:
            'FAL_KEY or FAL_API_KEY is required for fal.ai pose corrections. Add it to server environment.',
        })
      }
    }

    if (imageProvider === 'comfy' && !isComfyCorrectionConfigured()) {
      return res.status(503).json({
        error:
          'ComfyUI is not configured. Set COMFYUI_BASE_URL and COMFYUI_WORKFLOW_PATH (and node id env vars) on the server.',
      })
    }

    if (imageProvider === 'gemini' && !isGeminiCorrectionConfigured()) {
      return res.status(503).json({
        error:
          'GEMINI_API_KEY is required for correction images. Add it to server environment.',
      })
    }

    console.log('[Technique] Generating correction images', {
      analysisId,
      imageProvider,
      frameCount: framesToGenerate.length,
      frames: framesToGenerate.map((f) => f.frame),
    })

    const landmarksForGpt =
      poseSequence?.find((p) => p.phase === 'impact')?.landmarks ??
      framesToGenerate[0].landmarks

    // Impact-frame deltas are used as a fallback when a per-frame delta call fails.
    const impactDeltas = await translateRecommendationsToDeltas(
      enAnalysis.recommendations ?? [],
      `${enAnalysis.diagnosis ?? ''}${detectionHint}`,
      landmarksForGpt,
      poseSequence ?? null
    )

    console.log('[Technique] Impact-frame landmark deltas (fallback)', {
      deltaCount: impactDeltas.length,
      deltas: impactDeltas.map((d) => `${d.landmark} ${d.axis} ${d.direction}`),
      usedImpactSequence: !!poseSequence?.length,
    })

    // Per-frame delta cache so concurrent batches do not duplicate calls for the same frame.
    const frameDeltasCache = new Map<number, LandmarkDelta[]>()

    const resolvedShot = resolveCanonicalShotFromMetrics(
      metrics && typeof metrics === 'object' ? metrics : null
    )
    const shotFromRetrieval = shotClassificationFromResolved(resolvedShot)
    let handednessClass = null
    try {
      handednessClass = await classifyHandednessOnly(
        enAnalysis.recommendations ?? [],
        `${enAnalysis.diagnosis ?? ''}${detectionHint}`,
        landmarksForGpt,
        poseSequence ?? null
      )
      console.log('[Technique] Handedness classification (shot from retrieval)', {
        shot: shotFromRetrieval.shot_name,
        shotSource: resolvedShot.source,
        shotConfidence: resolvedShot.confidence,
        dominantHand: handednessClass.dominant_hand,
        handConfidence: handednessClass.confidence,
      })
    } catch (classificationErr) {
      console.error('[Technique] Handedness classification failed', classificationErr)
      handednessClass = null
    }

    const shotAndHandedness: ShotAndHandedness | null = {
      shot: shotFromRetrieval,
      handedness: handednessClass ?? {
        dominant_hand: 'unknown',
        confidence: 0,
        evidence: [],
      },
    }

    const profileRow = await db.query.userProfile.findFirst({
      where: (up, { eq: _eq }) => _eq(up.userId, userId),
      columns: { dominantHand: true },
    })
    const profileDominantHand = profileTextToDominantHand(profileRow?.dominantHand ?? null)
    const geometryConsensus = computeRacketHandConsensusForFrames(
      metrics?.pose_data ?? [],
      framesToGenerate.map((f) => f.frame)
    )
    const shotAndHandednessForImages = mergeCorrectionShotAndHandedness(shotAndHandedness, {
      profileDominantHand,
      geometryConsensus,
    })
    console.log('[Technique] Correction image handedness (effective)', {
      classified: shotAndHandedness?.handedness?.dominant_hand,
      profile: profileDominantHand,
      geometry: geometryConsensus,
      effective: shotAndHandednessForImages.handedness.dominant_hand,
      evidence: shotAndHandednessForImages.handedness.evidence,
    })

    const retrievalBlock = metrics?.retrieval as
      | {
          neighbors?: Array<{
            train_sample_id: string;
            stroke_name: string;
            stroke_label?: string;
            stroke_preset: string;
            skill_level: string;
            distance: number;
          }>;
        }
      | undefined
    const topNeighbor = retrievalBlock?.neighbors?.[0]
    let proPoseSequence: Awaited<ReturnType<typeof getTrainSamplePoseSequence>> =
      null
    let proTrainVideoPath: string | null = null
    let proTrainTotalFrames: number | null = null
    if (topNeighbor?.train_sample_id) {
      proPoseSequence = await getTrainSamplePoseSequence(
        topNeighbor.train_sample_id
      )
      if (proPoseSequence?.length) {
        console.log('[Technique] Pro reference poseSequence for corrections', {
          trainSampleId: topNeighbor.train_sample_id,
          frames: proPoseSequence.length,
        })
      }
      const proSampleRow = await db.query.trainSample.findFirst({
        where: (ts, { eq: _eq }) => _eq(ts.id, topNeighbor.train_sample_id),
        columns: { trainVideoId: true, totalFrames: true },
      })
      if (
        typeof proSampleRow?.totalFrames === 'number' &&
        proSampleRow.totalFrames > 0
      ) {
        proTrainTotalFrames = proSampleRow.totalFrames
      }
      if (proSampleRow?.trainVideoId) {
        const proVideoRow = await db.query.trainVideo.findFirst({
          where: (tv, { eq: _eq }) => _eq(tv.id, proSampleRow.trainVideoId),
          columns: { cloudinaryPublicId: true },
        })
        if (proVideoRow?.cloudinaryPublicId) {
          proTrainVideoPath = resolveVideoPath(proVideoRow.cloudinaryPublicId)
        }
      }
    }

    const maxPoseFrame = poseData.length
      ? Math.max(...poseData.map((p) => p.frame))
      : 0
    const videoTotalFrames =
      typeof metrics.total_frames === 'number' && metrics.total_frames > 0
        ? metrics.total_frames
        : maxPoseFrame + 1

    const corrections: CorrectionResult[] = []
    const frameInsightsByFrame = new Map<number, TechniqueCorrectionFrameInsight>()
    const impactPoseSequenceForInsights = metrics?.impact_pose_sequence as
      | LabeledPoseFrame[]
      | undefined
    const correctionShotName =
      shotAndHandednessForImages.shot.shot_name?.trim() || 'your shot'
    const correctionDominantHand = shotAndHandednessForImages.handedness.dominant_hand

    for (let i = 0; i < framesToGenerate.length; i += MAX_CONCURRENT_FRAMES) {
      const batch = framesToGenerate.slice(i, i + MAX_CONCURRENT_FRAMES)
      const results = await Promise.all(
        batch.map(async (frameData) => {
          try {
            console.log(
              `[Technique] Extracting frame ${frameData.frame} from video`
            )
            const frameBuffer = await extractFrame(videoPath, frameData.frame)
            const frameBase64 = frameBuffer.toString('base64')
            const frameHash = createHash('sha1')
              .update(frameBuffer)
              .digest('hex')
              .slice(0, 10)
            console.log('[Technique] Extracted frame hash', {
              frame: frameData.frame,
              hash: frameHash,
              bytes: frameBuffer.length,
            })

            console.log(
              `[Technique] Generating corrected image for frame ${frameData.frame} (${imageProvider})`
            )

            let proReferenceText: string | undefined
            let proReferenceImageBase64: string | undefined
            let proLandmarksForFrame: FrameLandmarks | undefined
            if (proPoseSequence?.length && topNeighbor) {
              const proFrame = pickAlignedProPoseFrame(
                frameData.frame,
                videoTotalFrames,
                proPoseSequence
              )
              if (proFrame?.landmarks && typeof proFrame.landmarks === 'object') {
                proLandmarksForFrame = proFrame.landmarks as FrameLandmarks
                if (proTrainVideoPath) {
                  const proVideoExists = fs.existsSync(proTrainVideoPath)
                  const proVideoStat = proVideoExists
                    ? fs.statSync(proTrainVideoPath)
                    : null
                  try {
                    if (!proVideoExists) {
                      throw new Error(
                        `pro train video missing on disk: ${proTrainVideoPath}`
                      )
                    }
                    const proVideoFrames =
                      proTrainTotalFrames ??
                      (await probeVideoFrameCount(proTrainVideoPath))
                    const candidates = proReferenceFrameCandidates(
                      frameData.frame,
                      videoTotalFrames,
                      proPoseSequence
                    )
                    const timelineRatio = proTimelineRatioForUserFrame(
                      frameData.frame,
                      videoTotalFrames
                    )
                    const proExtract = await extractProReferenceFrame(
                      proTrainVideoPath,
                      {
                        frameCandidates:
                          candidates.length > 0
                            ? candidates
                            : [proFrame.frame_idx],
                        maxFrame: proVideoFrames,
                        timelineRatio,
                      }
                    )
                    proReferenceImageBase64 = proExtract.buffer.toString('base64')
                    console.log('[Technique] Pro-library ref frame for Comfy image2', {
                      frame: frameData.frame,
                      proFrameIdx: proFrame.frame_idx,
                      candidates,
                      proVideoFrames,
                      proTrainTotalFrames,
                      timelineRatio,
                      method: proExtract.method,
                      detail: proExtract.detail,
                      bytes: proExtract.buffer.length,
                      proTrainVideoPath,
                    })
                  } catch (proImgErr) {
                    console.error(
                      '[Technique] Pro ref frame extract failed — Comfy image2 falls back to player frame (no pro CN/image2)',
                      {
                        trainSampleId: topNeighbor.train_sample_id,
                        proTrainVideoPath,
                        proVideoExists,
                        proVideoBytes: proVideoStat?.size ?? null,
                        frame: frameData.frame,
                        err:
                          proImgErr instanceof Error
                            ? proImgErr.message
                            : proImgErr,
                      }
                    )
                  }
                }
                proReferenceText = buildProNeighborCorrectionContext({
                  strokeName: topNeighbor.stroke_name,
                  strokeLabel: topNeighbor.stroke_label?.trim() || undefined,
                  strokePreset: topNeighbor.stroke_preset,
                  skillLevel: topNeighbor.skill_level,
                  distance: topNeighbor.distance,
                  userLandmarks: frameData.landmarks,
                  proLandmarks: proLandmarksForFrame,
                })
                console.log('[Technique] Pro-library pose target for frame', {
                  frame: frameData.frame,
                  trainSampleId: topNeighbor.train_sample_id,
                  proFrameIdx: proFrame.frame_idx,
                  stroke: topNeighbor.stroke_name,
                  distance: topNeighbor.distance,
                })
              }
            }

            // Per-frame deltas: this frame's landmarks may reflect a different swing
            // phase than the impact frame, so generate frame-specific adjustments.
            // Cache by frame to avoid duplicate LLM calls across retries / batches,
            // and fall back to impact-frame deltas if the per-frame call fails.
            let frameDeltas: LandmarkDelta[] = impactDeltas
            const cached = frameDeltasCache.get(frameData.frame)
            if (cached) {
              frameDeltas = cached
            } else {
              try {
                const perFrame = await translateRecommendationsToDeltas(
                  enAnalysis.recommendations ?? [],
                  `${enAnalysis.diagnosis ?? ''}${detectionHint}`,
                  frameData.landmarks,
                  poseSequence ?? null
                )
                if (perFrame.length > 0) {
                  frameDeltas = perFrame
                  frameDeltasCache.set(frameData.frame, perFrame)
                  console.log('[Technique] Per-frame deltas', {
                    frame: frameData.frame,
                    deltaCount: perFrame.length,
                  })
                } else {
                  console.warn(
                    `[Technique] Per-frame deltas empty for frame ${frameData.frame}; using impact fallback`
                  )
                }
              } catch (perFrameErr) {
                console.warn(
                  `[Technique] Per-frame deltas failed for frame ${frameData.frame}; using impact fallback`,
                  perFrameErr
                )
              }
            }

            if (proLandmarksForFrame) {
              const proDeltas = proGapToLandmarkDeltas(
                frameData.landmarks,
                proLandmarksForFrame
              )
              if (proDeltas.length > 0) {
                frameDeltas = mergeLandmarkDeltas(proDeltas, frameDeltas)
                console.log('[Technique] Merged pro-library landmark deltas into Comfy prompt', {
                  frame: frameData.frame,
                  proDeltaCount: proDeltas.length,
                  mergedCount: frameDeltas.length,
                  joints: proDeltas.map((d) => d.landmark),
                })
              } else {
                console.warn(
                  '[Technique] Pro landmarks aligned but no pro-gap deltas (user≈pro at joints) — Comfy uses coach deltas + pro image only',
                  { frame: frameData.frame }
                )
              }
            } else if (topNeighbor && !proLandmarksForFrame) {
              console.warn(
                '[Technique] Pro neighbor matched but poseSequence/frame missing — no numeric pro targets for Comfy',
                {
                  frame: frameData.frame,
                  trainSampleId: topNeighbor.train_sample_id,
                  distance: topNeighbor.distance,
                }
              )
            }

            if (frameDeltas.length === 0) {
              console.warn(
                '[Technique] Empty landmark deltas for correction frame — check Unsloth delta translation',
                { frame: frameData.frame }
              )
            }

            const correctedImage =
              imageProvider === 'fal'
                ? await generateCorrectedImageFal(
                    frameBase64,
                    'image/png',
                    frameData.frame,
                    frameData.landmarks,
                    frameDeltas,
                    `${enAnalysis.diagnosis ?? ''}${detectionHint}`,
                    enAnalysis.recommendations ?? [],
                    shotAndHandednessForImages,
                    proReferenceText
                  )
                : imageProvider === 'comfy'
                  ? await generateCorrectedImageComfy(
                      frameBase64,
                      'image/png',
                      frameData.frame,
                      frameData.landmarks,
                      frameDeltas,
                      `${enAnalysis.diagnosis ?? ''}${detectionHint}`,
                      enAnalysis.recommendations ?? [],
                      shotAndHandednessForImages,
                      proReferenceText,
                      proReferenceImageBase64 ?? null,
                      'image/png',
                      proLandmarksForFrame ?? null
                    )
                  : await generateCorrectedImage(
                      frameBase64,
                      'image/png',
                      frameData.frame,
                      frameData.landmarks,
                      frameDeltas,
                      `${enAnalysis.diagnosis ?? ''}${detectionHint}`,
                      enAnalysis.recommendations ?? [],
                      shotAndHandednessForImages,
                      proReferenceText
                    )

            const originalDataUri = `data:image/png;base64,${frameBase64}`

            if (!correctedImage) {
              console.warn(
                `[Technique] No corrected image for frame ${frameData.frame} (${imageProvider}); omitting from results`
              )
              return null
            }

            frameInsightsByFrame.set(
              frameData.frame,
              buildCorrectionFrameInsight({
                frame: frameData.frame,
                imageIndex: frameInsightsByFrame.size + 1,
                userLandmarks: frameData.landmarks,
                proLandmarks: proLandmarksForFrame ?? null,
                frameDeltas,
                shotName: correctionShotName,
                dominantHand: correctionDominantHand,
                impactPoseSequence: impactPoseSequenceForInsights,
              })
            )

            return {
              frame: frameData.frame,
              originalImage: originalDataUri,
              correctedImage,
            } satisfies CorrectionResult
          } catch (err: any) {
            console.error(
              `[Technique] Failed to process frame ${frameData.frame}:`,
              err.message
            )
            return null
          }
        })
      )

      for (const r of results) {
        if (r) corrections.push(r)
      }
    }

    console.log('[Technique] Correction images generated', {
      analysisId,
      successCount: corrections.length,
      totalFrames: framesToGenerate.length,
    })

    const mergedByFrame = new Map<number, CorrectionResult>()
    for (const c of cachedCorrections) mergedByFrame.set(c.frame, c)
    for (const c of corrections) mergedByFrame.set(c.frame, c)
    const mergedCorrections = limitCorrectionsToMaxFrames(
      Array.from(mergedByFrame.values()).sort((a, b) => a.frame - b.frame),
      maxCorrectionImageFrames()
    )
    const mergedCorrectionsOnDisk = normalizeCorrectionsForClient(
      analysisId,
      mergedCorrections
    )
    const responseCorrections =
      requestedFrameIndices && requestedFrameIndices.length > 0
        ? orderCorrectionsByFrames(
            new Map(mergedCorrectionsOnDisk.map((c) => [c.frame, c] as const)),
            requestedFrameIndices
          )
        : mergedCorrectionsOnDisk

    try {
      const frameIndicesForContext = mergedCorrectionsOnDisk.map((c) => c.frame)
      const orderedFrameInsights = orderFrameInsights(
        Array.from(frameInsightsByFrame.values()),
        frameIndicesForContext
      )
      const enForContext = (metrics as { ai_analysis?: { en?: Record<string, unknown> } })
        ?.ai_analysis?.en
      const correctionContext = {
        version:
          imageProvider === 'fal'
            ? 'fal-flux-general-img2img-v1'
            : imageProvider === 'comfy'
              ? 'comfyui-workflow-v1'
              : 'shot-handedness-v1',
        image_provider: imageProvider,
        generated_at: new Date().toISOString(),
        frame_count: mergedCorrectionsOnDisk.length,
        frame_indices: frameIndicesForContext,
        frames: orderedFrameInsights.length > 0 ? orderedFrameInsights : undefined,
        shot_and_handedness: shotAndHandednessForImages,
        shot_and_handedness_classified: shotAndHandedness,
        coaching_summary: {
          diagnosis:
            typeof enForContext?.diagnosis === 'string' ? enForContext.diagnosis : null,
          shot_context:
            typeof enForContext?.shot_context === 'string' ? enForContext.shot_context : null,
          actionable_corrections: Array.isArray(enForContext?.actionable_corrections)
            ? enForContext.actionable_corrections.filter(
                (x): x is string => typeof x === 'string' && x.trim().length > 0
              )
            : [],
          recommendations: Array.isArray(enForContext?.recommendations)
            ? enForContext.recommendations.filter(
                (x): x is string => typeof x === 'string' && x.trim().length > 0
              )
            : [],
        },
      }
      const updatedMetrics = {
        ...metrics,
        [correctionImagesKey]: mergedCorrectionsOnDisk,
        [correctionContextKey]: correctionContext,
      }
      await db
        .update(techniqueAnalysis)
        .set({ metrics: updatedMetrics as any })
        .where(eq(techniqueAnalysis.id, analysisId))

      if (corrections.length > 0 && responseCorrections.length > 0) {
        const frameN = responseCorrections.length
        const notiBody =
          frameN === 1
            ? 'Your corrected pose image is ready in Activities.'
            : `Your ${frameN} corrected pose images are ready in Activities.`
        try {
          await db.insert(userNotification).values({
            id: randomUUID(),
            userId,
            kind: 'correction_images_ready',
            title: 'Corrected images ready',
            body: notiBody,
            refType: 'technique_analysis',
            refId: analysisId,
            createdAt: new Date(),
          })
        } catch (notiErr) {
          console.error('[Technique] Failed to insert correction_images_ready notification', notiErr)
        }
      }
    } catch (cacheErr) {
      console.error('[Technique] Failed to cache correction images', cacheErr)
    }

    const metricsAfter = await db.query.techniqueAnalysis.findFirst({
      where: (ta, { eq: _eq }) => _eq(ta.id, analysisId),
      columns: { metrics: true },
    })
    const ctxAfter = (metricsAfter?.metrics as Record<string, unknown> | null)?.[
      correctionContextKey
    ]

    return res.json({
      provider: imageProvider,
      corrections: responseCorrections,
      correction_context: ctxAfter ?? null,
    })
  } catch (e: any) {
    console.error('[Technique] Correction-images error:', e)
    return res.status(500).json({ error: 'Failed to generate correction images' })
  }
})

/**
 * Extract the same up-to-5 pose frames as correction-images (no Gemini/fal).
 * For client-side test layouts: compare video frames to bundled reference PNGs.
 */
router.post('/correction-test-frames', async (req, res) => {
  try {
    const userId = await resolveUserId(req)
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    const { analysisId } = req.body as { analysisId?: string }
    if (!analysisId) {
      return res.status(400).json({ error: 'Missing analysisId' })
    }

    const analysis = await db.query.techniqueAnalysis.findFirst({
      where: (ta, { and, eq: _eq }) =>
        and(_eq(ta.id, analysisId), _eq(ta.userId, userId)),
    })

    if (!analysis) {
      return res.status(404).json({ error: 'Analysis not found' })
    }

    if (analysis.status !== 'completed') {
      return res.status(400).json({ error: 'Analysis is not completed yet' })
    }

    const metrics = analysis.metrics as any
    const poseData: Array<{ frame: number; landmarks: FrameLandmarks }> =
      metrics?.pose_data ?? []

    if (poseData.length === 0) {
      return res.status(400).json({ error: 'No pose data available' })
    }

    const video = await db.query.techniqueVideo.findFirst({
      where: (tv, { eq: _eq }) => _eq(tv.id, analysis.techniqueVideoId),
    })

    if (!video?.cloudinaryPublicId) {
      return res.status(404).json({ error: 'Video file not found' })
    }

    const videoPath = resolveVideoPath(video.cloudinaryPublicId)
    if (!fs.existsSync(videoPath)) {
      return res.status(404).json({ error: 'Video file missing from disk' })
    }

    const requestedFrames = selectPoseFramesForCorrections(
      poseData,
      maxCorrectionImageFrames(),
      {
        userClips: Array.isArray(metrics?.user_clips)
          ? (metrics.user_clips as ClipMsRange[])
          : undefined,
        videoDurationMs:
          typeof metrics?.video_duration_ms === 'number'
            ? metrics.video_duration_ms
            : undefined,
        totalFrames:
          typeof metrics?.total_frames === 'number' ? metrics.total_frames : 0,
      }
    )

    if (requestedFrames.length === 0) {
      return res.status(400).json({ error: 'No matching frames found' })
    }

    let poseSequence = metrics?.impact_pose_sequence as
      | LabeledPoseFrame[]
      | undefined
    const durationForRebuild = resolveVideoDurationMsForImpact(
      typeof metrics?.video_duration_ms === 'number'
        ? metrics.video_duration_ms
        : undefined,
      metrics?.total_frames ?? 0,
      poseData
    )
    if (metrics?.user_clips?.length && durationForRebuild) {
      const impactApplied = applyUserClipImpactToMetrics(
        {
          ...metrics,
          pose_data: poseData,
        },
        metrics.user_clips as ClipMsRange[],
        durationForRebuild
      )
      if (impactApplied?.impact_pose_sequence?.length) {
        poseSequence = impactApplied.impact_pose_sequence
      }
    }

    const framesToExtract = [...requestedFrames]
    const impactFrameNum = poseSequence?.find((p) => p.phase === 'impact')?.frame
    if (impactFrameNum != null && framesToExtract.length > 1) {
      framesToExtract.sort(
        (a, b) =>
          Math.abs(a.frame - impactFrameNum) - Math.abs(b.frame - impactFrameNum)
      )
    }

    const frames: Array<{ frame: number; originalImage: string }> = []

    for (let i = 0; i < framesToExtract.length; i += MAX_CONCURRENT_FRAMES) {
      const batch = framesToExtract.slice(i, i + MAX_CONCURRENT_FRAMES)
      const results = await Promise.all(
        batch.map(async (frameData) => {
          try {
            const frameBuffer = await extractFrame(videoPath, frameData.frame)
            const originalImage = `data:image/png;base64,${frameBuffer.toString('base64')}`
            return { frame: frameData.frame, originalImage }
          } catch (err: any) {
            console.error(
              `[Technique] correction-test-frames: failed frame ${frameData.frame}:`,
              err?.message
            )
            return null
          }
        })
      )
      for (const r of results) {
        if (r) frames.push(r)
      }
    }

    frames.sort((a, b) => a.frame - b.frame)

    console.log('[Technique] correction-test-frames done', {
      analysisId,
      count: frames.length,
    })

    return res.json({ frames })
  } catch (e: any) {
    console.error('[Technique] correction-test-frames error:', e)
    return res.status(500).json({ error: 'Failed to extract test frames' })
  }
})

export default router
