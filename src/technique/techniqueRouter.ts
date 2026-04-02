import express from 'express'
import multer from 'multer'
import fs from 'fs'
import path from 'path'
import { fromNodeHeaders } from 'better-auth/node'
import { auth } from '../auth'
import { db, techniqueVideo, techniqueAnalysis, user } from '../db'
import { randomUUID, createHash } from 'crypto'
import { eq } from 'drizzle-orm'
import { extractFrame, resolveVideoPath } from './frameExtractor'
import {
  translateRecommendationsToDeltas,
  classifyShotAndHandedness,
  mergeCorrectionShotAndHandedness,
  generateCorrectedImage,
  type FrameLandmarks,
  type CorrectionResult,
  type ShotAndHandedness,
} from './correctionPrompt'
import { calibrateTechniqueScore } from './scoreCalibration'
import {
  buildImpactPoseSequenceForMetrics,
  resolveVideoDurationMsForImpact,
  type LabeledPoseFrame,
} from './impactPoseContext'

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

const router = express.Router()
router.use(express.json({ limit: '50mb' }))
router.use(express.urlencoded({ extended: true }))

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

function getY(landmarks: Record<string, { x: number; y: number }>, key: string): number | null {
  const value = landmarks?.[key]?.y
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function summarizeOverheadEvidence(
  poseData: Array<{ frame?: number; landmarks?: Record<string, { x: number; y: number }> }>
) {
  let validFrames = 0
  let overheadFrames = 0

  for (const frame of poseData) {
    const landmarks = frame?.landmarks
    if (!landmarks || typeof landmarks !== 'object') continue

    const leftShoulderY = getY(landmarks, 'LEFT_SHOULDER')
    const rightShoulderY = getY(landmarks, 'RIGHT_SHOULDER')
    const leftWristY = getY(landmarks, 'LEFT_WRIST')
    const rightWristY = getY(landmarks, 'RIGHT_WRIST')
    const leftElbowY = getY(landmarks, 'LEFT_ELBOW')
    const rightElbowY = getY(landmarks, 'RIGHT_ELBOW')
    const noseY = getY(landmarks, 'NOSE')

    const shoulderCandidates = [leftShoulderY, rightShoulderY].filter(
      (v): v is number => typeof v === 'number'
    )
    const wristCandidates = [leftWristY, rightWristY].filter(
      (v): v is number => typeof v === 'number'
    )

    if (shoulderCandidates.length === 0 || wristCandidates.length === 0) continue

    validFrames += 1

    const shoulderY = shoulderCandidates.reduce((a, b) => a + b, 0) / shoulderCandidates.length
    const highestWristY = Math.min(...wristCandidates)

    const aboveShoulder = highestWristY < shoulderY - 0.06
    const nearOrAboveHead = typeof noseY === 'number' ? highestWristY < noseY + 0.08 : true
    const extendedArm =
      (typeof leftWristY === 'number' &&
        typeof leftElbowY === 'number' &&
        leftWristY < leftElbowY - 0.02) ||
      (typeof rightWristY === 'number' &&
        typeof rightElbowY === 'number' &&
        rightWristY < rightElbowY - 0.02)

    if (aboveShoulder && nearOrAboveHead && extendedArm) {
      overheadFrames += 1
    }
  }

  const confidence = validFrames > 0 ? overheadFrames / validFrames : 0
  const supportsOverhead = overheadFrames >= 2 && confidence >= 0.35
  return { supportsOverhead, confidence, validFrames, overheadFrames }
}

function correctLikelyFalseOverheadShotContext(
  aiAnalysis: any,
  poseData: Array<{ frame?: number; landmarks?: Record<string, { x: number; y: number }> }>
) {
  const shotContext = String(aiAnalysis?.en?.shot_context ?? '')
  const mentionsOverhead = /\b(smash|overhead|remate|x3|x4)\b/i.test(shotContext)
  if (!mentionsOverhead) return { changed: false as const }

  const evidence = summarizeOverheadEvidence(poseData)
  if (evidence.supportsOverhead) return { changed: false as const, ...evidence }

  if (!aiAnalysis.en || typeof aiAnalysis.en !== 'object') aiAnalysis.en = {}
  if (!aiAnalysis.es || typeof aiAnalysis.es !== 'object') aiAnalysis.es = {}

  aiAnalysis.en.shot_context =
    'Likely not an overhead smash. Your movement in this clip looks closer to a groundstroke or volley pattern.'
  aiAnalysis.es.shot_context =
    'Probablemente no es un smash por arriba. Tu movimiento en este clip se parece mas a un golpe de fondo o una volea.'

  return { changed: true as const, ...evidence }
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

    const payload = { id, url: publicPath, publicId: filePath }
    console.log('[Technique] Sending success response')
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
      return res.status(404).json({ error: 'Video not found' })
    }

    const analysisId = randomUUID()

    await db.insert(techniqueAnalysis).values({
      id: analysisId,
      techniqueVideoId,
      userId,
      status: 'processing',
      metrics: null,
      feedbackText: null,
    })

    const publicVideoBase = (process.env.PUBLIC_VIDEO_BASE_URL || '').trim()
    const publicBase = (process.env.PUBLIC_BASE_URL || '').trim()
    const authBase = (process.env.BETTER_AUTH_URL || '').trim()
    const baseUrl =
      publicVideoBase ||
      publicBase ||
      authBase ||
      'http://localhost:3050'
    const videoUrl =
      video.secureUrl && video.secureUrl.startsWith('http')
        ? video.secureUrl
        : `${baseUrl.replace(/\/$/, '')}${video.secureUrl}`

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

    const modalRes = await fetch(process.env.MODAL_WEBHOOK_URL as string, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        video_url: videoUrl,
        analysis_id: analysisId,
        model: 'mediapipe',
      }),
    }).then(r => r.json() as any)

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
    const clipList =
      Array.isArray(clips) && clips.length > 0 ? clips : undefined
    const vdur = resolveVideoDurationMsForImpact(
      videoDurationMs,
      metrics.total_frames ?? 0,
      poseDataEarly
    )
    if (clipList && vdur) {
      const seq = buildImpactPoseSequenceForMetrics(
        metrics.pose_data,
        metrics.total_frames ?? 0,
        vdur,
        clipList
      )
      const clientSentDuration =
        typeof videoDurationMs === 'number' && videoDurationMs > 0
      metrics = {
        ...metrics,
        video_duration_ms: vdur,
        user_clips: clipList,
        video_duration_ms_source: clientSentDuration ? 'client' : 'inferred',
        ...(seq?.length ? { impact_pose_sequence: seq } : {}),
      }
    }

    console.log('[Technique] Modal metrics received', {
      analysisId,
      summary: {
        total_frames: metrics?.total_frames,
        analyzed_frames: metrics?.analyzed_frames,
        pose_samples: Array.isArray(metrics?.pose_data) ? metrics.pose_data.length : 0,
        impact_sequence_phases: metrics?.impact_pose_sequence?.length ?? 0,
      },
    })
    let aiAnalysis: any = null
    let feedbackText: string | null = null

    try {
      const poseSummary = metrics.impact_pose_sequence?.length
        ? JSON.stringify({
            note: 'User marked ball impact (clip end). Phases: preparation → impact (nearest frame to impact) → follow-through. Prefer this sequence for shot type and movement.',
            impact_pose_sequence: metrics.impact_pose_sequence,
            all_pose_samples: metrics.pose_data ?? [],
          })
        : JSON.stringify(metrics.pose_data ?? [])
      const prompt = `
Analyze the video strictly from a padel coaching perspective, not general biomechanics.

Here is the pose data from several frames of the video (x,y coordinates are normalized 0-1, where 0,0 is top-left):

${poseSummary}

First, identify the type of shot (forehand, backhand, volley, bandeja, vibora, smash, etc.) based on context, contact point, and player positioning on court.

Track the player's movement from preparation -> execution -> follow-through -> recovery, ensuring the entire body is analyzed, including:
- Both arms (dominant and non-dominant)
- Racket (pala) path and angle
- Shoulder and hip rotation
- Footwork and stance
- Weight transfer
- Knee flexion and center of gravity

Evaluate technique specifically for padel efficiency, focusing on:
- Preparation timing (early/late)
- Compact vs excessive swing (important in padel)
- Contact point relative to body and ball height
- Use of non-dominant arm for balance and rotation
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
  "score": <integer 0-10>,
  "rating": "<excellent|good|needs_improvement|poor>",
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
- Assume the player is an intermediate-level padel player and tailor feedback to realistic improvements.
- Write all feedback in a personal coaching voice, directly to the user (second person): use "you/your" in English and second person in Spanish.
- Do not use third-person phrasing such as "the player", "they", or equivalent third-person constructions.
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
  - score to 0 and rating to "poor"
- score: integer 0-10 reflecting overall technique quality (10=perfect, 0=very poor)
- rating: one of "excellent" (8-10), "good" (6-7), "needs_improvement" (3-5), "poor" (0-2)
- Do NOT default to 7. Use the full 0-10 scale when evidence supports it.
- Be strict and discriminative: major mechanical faults should score <=5; strong, consistent form should score >=8.
- Only respond with valid JSON, no markdown, no other text.`

      const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'gpt-5-mini-2025-08-07',
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'user',
              content: prompt,
            },
          ],
        }),
      }).then(r => r.json() as any)

      console.log('[Technique] OpenAI raw response', {
        analysisId,
        usage: openaiRes?.usage,
        error: openaiRes?.error,
      })

      const content = openaiRes?.choices?.[0]?.message?.content
      if (typeof content === 'string') {
        aiAnalysis = JSON.parse(content)
      } else if (content?.[0]?.type === 'text' && content[0].text?.value) {
        aiAnalysis = JSON.parse(content[0].text.value)
      }

      if (aiAnalysis && Array.isArray(metrics?.pose_data)) {
        const shotFix = correctLikelyFalseOverheadShotContext(aiAnalysis, metrics.pose_data)
        if (shotFix.changed) {
          console.log('[Technique] Corrected likely false overhead shot label', {
            analysisId,
            overheadConfidence: shotFix.confidence,
            overheadFrames: shotFix.overheadFrames,
            validFrames: shotFix.validFrames,
          })
        }
      }

      if (typeof aiAnalysis?.score === 'number') {
        const modelRawScore = Math.max(0, Math.min(10, Number(aiAnalysis.score)))
        const s = calibrateTechniqueScore({
          ...aiAnalysis,
          score: modelRawScore,
        })
        aiAnalysis.score_model_raw = Math.round(modelRawScore)
        aiAnalysis.score = s
        aiAnalysis.rating =
          s >= 8 ? 'excellent' : s >= 6 ? 'good' : s >= 3 ? 'needs_improvement' : 'poor'
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
      console.error('[Technique] GPT analysis error:', err)
      aiAnalysis = null
      feedbackText = 'AI analysis failed; only pose metrics are available.'
    }

    const combinedMetrics =
      aiAnalysis != null ? { ...metrics, ai_analysis: aiAnalysis } : metrics

    console.log('[Technique] Combined metrics before DB update', {
      analysisId,
      hasAiAnalysis: !!aiAnalysis,
      metricsPreview: {
        total_frames: combinedMetrics?.total_frames,
        analyzed_frames: combinedMetrics?.analyzed_frames,
        pose_samples: Array.isArray(combinedMetrics?.pose_data)
          ? combinedMetrics.pose_data.length
          : 0,
        ai_score: combinedMetrics?.ai_analysis?.score,
        ai_rating: combinedMetrics?.ai_analysis?.rating,
      },
    })

    await db
      .update(techniqueAnalysis)
      .set({
        status: aiAnalysis ? 'completed' : 'failed',
        metrics: combinedMetrics as any,
        feedbackText,
      })
      .where(eq(techniqueAnalysis.id, analysisId))

    console.log('[Technique] Analysis row updated, id:', analysisId)
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

    return res.json({
      id: analysis.id,
      status: analysis.status,
      metrics: analysis.metrics,
      feedbackText: analysis.feedbackText,
      createdAt: analysis.createdAt,
    })
  } catch (e: any) {
    console.error('[Technique] Analysis fetch error:', e)
    return res.status(500).json({ error: 'Failed to fetch analysis' })
  }
})

const MAX_CONCURRENT_FRAMES = 3

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

router.post('/correction-images', async (req, res) => {
  try {
    console.log('[Technique] Correction-images request received')
    const userId = await resolveUserId(req)
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    const { analysisId, frameIndices } = req.body as {
      analysisId?: string
      frameIndices?: number[]
    }
    const requestedFrameIndices = Array.isArray(frameIndices)
      ? Array.from(new Set(frameIndices.filter((f) => Number.isFinite(f))))
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

    const existingCorrections = (analysis.metrics as any)?.correction_images
    let cachedCorrections: CorrectionResult[] = []
    if (Array.isArray(existingCorrections) && existingCorrections.length > 0) {
      const badCache = looksLikeBadCachedCorrections(existingCorrections)
      if (!badCache) {
        cachedCorrections = existingCorrections
        const cachedByFrame = new Map(
          cachedCorrections.map((c: CorrectionResult) => [c.frame, c] as const)
        )

        if (!requestedFrameIndices || requestedFrameIndices.length === 0) {
          console.log('[Technique] Returning cached correction images', {
            analysisId,
            count: cachedCorrections.length,
          })
          return res.json({ corrections: cachedCorrections })
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
          return res.json({ corrections: cachedRequested })
        }
      }

      console.warn('[Technique] Ignoring suspicious cached correction images; regenerating', {
        analysisId,
        count: existingCorrections.length,
      })
    }

    const metrics = analysis.metrics as any
    const poseData: Array<{ frame: number; landmarks: FrameLandmarks }> =
      metrics?.pose_data ?? []
    const aiAnalysis = metrics?.ai_analysis
    const enAnalysis = aiAnalysis?.en

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
    if (
      (!poseSequence || poseSequence.length === 0) &&
      metrics?.user_clips?.length &&
      durationForRebuild
    ) {
      poseSequence =
        buildImpactPoseSequenceForMetrics(
          poseData,
          metrics?.total_frames ?? 0,
          durationForRebuild,
          metrics.user_clips
        ) ?? undefined
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

    const requestedFrames = requestedFrameIndices
      ? poseData.filter((p) => requestedFrameIndices.includes(p.frame))
      : poseData

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
      const responseCorrections = requestedFrameIndices
        ? orderCorrectionsByFrames(cachedByFrame, requestedFrameIndices)
        : cachedCorrections
      return res.json({ corrections: responseCorrections })
    }

    console.log('[Technique] Generating correction images', {
      analysisId,
      frameCount: framesToGenerate.length,
      frames: framesToGenerate.map((f) => f.frame),
    })

    const landmarksForGpt =
      poseSequence?.find((p) => p.phase === 'impact')?.landmarks ??
      framesToGenerate[0].landmarks

    const deltas = await translateRecommendationsToDeltas(
      enAnalysis.recommendations ?? [],
      enAnalysis.diagnosis ?? '',
      landmarksForGpt,
      poseSequence ?? null
    )

    console.log('[Technique] GPT landmark deltas', {
      deltaCount: deltas.length,
      deltas: deltas.map((d) => `${d.landmark} ${d.axis} ${d.direction}`),
      usedImpactSequence: !!poseSequence?.length,
    })

    let shotAndHandedness: ShotAndHandedness | null = null
    try {
      shotAndHandedness = await classifyShotAndHandedness(
        enAnalysis.recommendations ?? [],
        enAnalysis.diagnosis ?? '',
        landmarksForGpt,
        poseSequence ?? null
      )
      console.log('[Technique] Shot + handedness classification', {
        shot: shotAndHandedness.shot.shot_name,
        family: shotAndHandedness.shot.shot_family,
        shotConfidence: shotAndHandedness.shot.confidence,
        dominantHand: shotAndHandedness.handedness.dominant_hand,
        handConfidence: shotAndHandedness.handedness.confidence,
      })
    } catch (classificationErr) {
      console.error('[Technique] Shot/handedness classification failed', classificationErr)
      shotAndHandedness = null
    }

    const shotAndHandednessForImages =
      mergeCorrectionShotAndHandedness(shotAndHandedness)
    console.log('[Technique] Correction image handedness (effective)', {
      classified: shotAndHandedness?.handedness?.dominant_hand,
      effective: shotAndHandednessForImages.handedness.dominant_hand,
    })

    const corrections: CorrectionResult[] = []

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
              `[Technique] Generating corrected image for frame ${frameData.frame}`
            )
            const correctedImage = await generateCorrectedImage(
              frameBase64,
              'image/png',
              frameData.frame,
              frameData.landmarks,
              deltas,
              enAnalysis.diagnosis ?? '',
              enAnalysis.recommendations ?? [],
              shotAndHandednessForImages
            )

            const originalDataUri = `data:image/png;base64,${frameBase64}`

            return {
              frame: frameData.frame,
              originalImage: originalDataUri,
              correctedImage: correctedImage ?? originalDataUri,
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
    const mergedCorrections = Array.from(mergedByFrame.values()).sort(
      (a, b) => a.frame - b.frame
    )
    const responseCorrections =
      requestedFrameIndices && requestedFrameIndices.length > 0
        ? orderCorrectionsByFrames(mergedByFrame, requestedFrameIndices)
        : mergedCorrections

    try {
      const frameIndicesForContext = requestedFrames.map((f) => f.frame)
      const correctionContext = {
        version: 'shot-handedness-v1',
        generated_at: new Date().toISOString(),
        frame_count: mergedCorrections.length,
        frame_indices: frameIndicesForContext,
        shot_and_handedness: shotAndHandednessForImages,
        shot_and_handedness_classified: shotAndHandedness,
      }
      const updatedMetrics = {
        ...metrics,
        correction_images: mergedCorrections,
        correction_context: correctionContext,
      }
      await db
        .update(techniqueAnalysis)
        .set({ metrics: updatedMetrics as any })
        .where(eq(techniqueAnalysis.id, analysisId))
    } catch (cacheErr) {
      console.error('[Technique] Failed to cache correction images', cacheErr)
    }

    return res.json({ corrections: responseCorrections })
  } catch (e: any) {
    console.error('[Technique] Correction-images error:', e)
    return res.status(500).json({ error: 'Failed to generate correction images' })
  }
})

export default router
