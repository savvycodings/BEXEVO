import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFile } from 'child_process'
import { randomUUID } from 'crypto'
import sharp from 'sharp'
import ffmpegStatic from 'ffmpeg-static'
import { extractFrame, extractFrameByTimestamp } from './frameExtractor'
import { withNgrokHeaders } from '../lib/ngrokFetch'
import { isCloudinaryConfigured, uploadBufferToCloudinary } from '../lib/cloudinaryUpload'
import { comfyQueuePrompt, comfyUploadImage, comfyViewToBuffer, comfyWaitForOutputImage } from './comfyClient'

/**
 * Electric-blue wireframe look (commit 7b4d153). The contact frame alone goes in — a style image
 * made Qwen / GPT copy the wrong pose. Comfy pins pose with SDPose + Fun ControlNet; OpenRouter
 * Nano Banana edits the still with the same prompt, then SDPose (optional Comfy) reads joints for
 * Smart 3D elbow selection.
 */
interface HologramPalette {
  /** Dominant colour, named with its hex so the model holds the exact shade. */
  main: string
  /** Short colour word for the racket, rings and reflection. */
  glow: string
  /** The only accent allowed next to the dominant colour. */
  accent: string
  /** Shades that wash the colour out or drift it off-palette. */
  avoid: string
}

function hologramPrompt(c: HologramPalette): string {
  return (
    'Turn the padel player in the photo into a full-body, anatomically realistic 3D holographic human figure at ' +
    'the moment of hitting the ball. Keep the exact pose, body proportions, camera angle and framing of the photo; ' +
    'only the look changes, and the entire figure stays visible from head to feet. The whole body is a futuristic ' +
    'holographic wireframe made of thousands of extremely fine, crisp horizontal digital scan lines, with subtle ' +
    'mesh details and tiny luminous particles. ' +
    `STRICT COLOUR PALETTE: intense ${c.main} is the dominant colour across the entire holographic body, outlines, ` +
    `scan lines and light effects. Use only closely related deep ${c.glow} tones and subtle ${c.accent} highlights. ` +
    `Avoid ${c.avoid}, white-dominant lighting or oversaturated highlights; keep the deep, saturated ${c.main} ` +
    'appearance. Consistent holographic material and colour throughout the body. ' +
    'Highly realistic human anatomy, accurate muscular structure, natural body proportions, anatomically correct ' +
    'hands and bare feet. No clothing, no shirt, no shorts, no waistband or hem line, no socks, no shoes and no ' +
    'accessories except the padel racket. The head is a smooth, bald, featureless mannequin head: no face, no ' +
    `hair, no cap. The racket is made of the same ${c.glow} holographic linework with a solid perforated face, no ` +
    'strings. Clearly defined silhouette and sharp digital linework, controlled subtle glow, minimal bloom, high ' +
    'contrast and crisp details. ' +
    'Remove the whole court, walls, fence, net, people and lights: pure black background, glossy black reflective ' +
    `floor, subtle concentric ${c.glow} holographic rings beneath the feet and a realistic ${c.glow} floor ` +
    'reflection. There is no text anywhere in the image. Cinematic studio lighting, ultra-detailed 3D render, sharp ' +
    'focus, futuristic scientific visualization, premium technology aesthetic. ' +
    'This is the moment of contact: exactly one small glowing ball touching the face of the racket. ' +
    'No other ball anywhere.'
  )
}

export const HOLOGRAM_PROMPT = hologramPrompt({
  main: 'electric royal blue #0048FF',
  glow: 'blue',
  accent: 'cyan',
  avoid: 'pale blue, light blue, turquoise',
})

/** Same hologram, drawn in red so it can sit on top of the player's blue one. */
export const HOLOGRAM_PROMPT_RED = hologramPrompt({
  main: 'crimson red #E0102A',
  glow: 'red',
  accent: 'warm scarlet',
  avoid: 'pink, salmon, orange',
})

/** Qwen invents extra balls, glowing orbs and a floorless void without this. */
export const HOLOGRAM_NEGATIVE_PROMPT =
  'two balls, second ball, extra ball, multiple balls, duplicate ball, ball on the floor, floating orbs, ' +
  'glowing spheres near the head, figure floating with no floor, padel court, glass walls, fence, net, court ' +
  'lines, ceiling lights, spectators, text, letters, logos, banners, advertising, ' +
  'pale blue, light blue, turquoise, excessive cyan, white glowing body, excessive bloom, blurry scan lines, ' +
  'soft focus, low detail, clothing, shorts, waistband, shoes, socks, cap, hat, hair, face, eyes, cropped feet, ' +
  'cropped head, distorted anatomy, extra fingers, deformed hands, cartoon, solid opaque skin, gray background'

const DEFAULT_COMFY_WORKFLOW = 'workflows/qwen_image_edit_2511_hologram.api.json'
const DETECT_WORKFLOW = path.join(process.cwd(), 'workflows', 'sdpose_player_box.api.json')
const KEYPOINTS_WORKFLOW = path.join(process.cwd(), 'workflows', 'sdpose_keypoints.api.json')
/** Node ids in the hologram workflow: frame LoadImage, positive and negative prompt, sampler. */
const COMFY_NODES = { frame: '10', prompt: '20', negative: '21', sampler: '50', keypoints: '90' }
/** Nano Banana 2 on OpenRouter (gemini-2.5-flash-image = original Nano Banana). */
const DEFAULT_OPENROUTER_HOLOGRAM_MODEL = 'google/gemini-3.1-flash-image'
const HOLOGRAM_UPLOAD_ROOT = path.join(process.cwd(), 'uploads', 'technique-holograms')

/** Fallback crop centre when the player is not detected; the player sits a little below centre in portrait clips. */
const CROP_CX = 0.5
const CROP_CY = 0.62
const SIZE = 1024

/** A render takes a minute or two; anything still "running" well past that died with the process. */
export const HOLOGRAM_JOB_STALE_MS = 10 * 60_000

/** Joint position on the hologram image, 0..1 from the top-left; `score` is SDPose confidence. */
export type HologramKeypoint = { x: number; y: number; score: number }
export type HologramKeypoints = Record<string, HologramKeypoint>

/** One MediaPipe frame of the orbit clip, in that frame's own 0..1 image space. */
export type HologramOrbitFrame = { frame: number; keypoints: HologramKeypoints }

export type HologramResult = {
  image: string
  frameImage: string
  contactMs: number | null
  frame: number | null
  /** Contact skeleton from the render's SDPose pass; same framing as `image`. */
  keypoints: HologramKeypoints | null
  /** Seedance orbit of the still. Scrubbing it is the 3D view. */
  orbitVideo?: string | null
  orbitDurationMs?: number | null
  orbitFrameCount?: number | null
  orbitWidth?: number | null
  orbitHeight?: number | null
  orbitFrames?: HologramOrbitFrame[] | null
}

/** OpenPose COCO-18 body order, then the six foot points, as SDPose writes them. Sides are the player's own. */
const BODY_KEYPOINTS = [
  'nose', 'neck', 'right_shoulder', 'right_elbow', 'right_wrist', 'left_shoulder', 'left_elbow', 'left_wrist',
  'right_hip', 'right_knee', 'right_ankle', 'left_hip', 'left_knee', 'left_ankle', 'right_eye', 'left_eye',
  'right_ear', 'left_ear',
]
const FOOT_KEYPOINTS = ['left_big_toe', 'left_small_toe', 'left_heel', 'right_big_toe', 'right_small_toe', 'right_heel']
const KEYPOINT_MIN_SCORE = 0.3

/** SDPose POSE_KEYPOINT as PreviewAny prints it (OpenPose JSON) -> named, normalised joints of the first person. */
export function parseSdposeKeypoints(text: string): HologramKeypoints | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  const frame = (Array.isArray(parsed) ? parsed[0] : parsed) as
    | { canvas_width?: number; canvas_height?: number; people?: Array<Record<string, unknown>> }
    | undefined
  const person = frame?.people?.[0]
  const w = frame?.canvas_width
  const h = frame?.canvas_height
  if (!person || !w || !h) return null
  const out: HologramKeypoints = {}
  const read = (flat: unknown, names: string[]) => {
    if (!Array.isArray(flat)) return
    names.forEach((name, i) => {
      const [x, y, score] = [flat[i * 3], flat[i * 3 + 1], flat[i * 3 + 2]].map(Number)
      if (![x, y, score].every(Number.isFinite) || score < KEYPOINT_MIN_SCORE || (x === 0 && y === 0)) return
      out[name] = { x: +(x / w).toFixed(4), y: +(y / h).toFixed(4), score: +score.toFixed(3) }
    })
  }
  read(person.pose_keypoints_2d, BODY_KEYPOINTS)
  read(person.foot_keypoints_2d, FOOT_KEYPOINTS)
  return Object.keys(out).length ? out : null
}

function parseStoredKeypoints(raw: unknown): HologramKeypoints | null {
  if (!raw || typeof raw !== 'object') return null
  const out: HologramKeypoints = {}
  for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
    const p = v as Partial<HologramKeypoint> | null
    if (p && [p.x, p.y, p.score].every((n) => typeof n === 'number' && Number.isFinite(n))) {
      out[name] = { x: p.x!, y: p.y!, score: p.score! }
    }
  }
  return Object.keys(out).length ? out : null
}

export type HologramJob = {
  status: 'running' | 'done' | 'failed'
  startedAt: string
  finishedAt?: string
  error?: string
}

export class HologramError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

type HologramProvider = 'comfy' | 'openai' | 'openrouter'

/** Default openrouter (Nano Banana). Set HOLOGRAM_PROVIDER=comfy|openai to force a backend. */
function hologramProvider(): HologramProvider {
  const raw = process.env.HOLOGRAM_PROVIDER?.trim().toLowerCase()
  if (raw === 'openai' || raw === 'comfy' || raw === 'openrouter') return raw
  if (process.env.OPENROUTER_API_KEY?.trim()) return 'openrouter'
  if (process.env.COMFYUI_BASE_URL?.trim()) return 'comfy'
  if (process.env.OPENAI_API_KEY?.trim()) return 'openai'
  return 'openrouter'
}

function comfyWorkflowPath(): string {
  const raw = process.env.HOLOGRAM_COMFY_WORKFLOW_PATH?.trim() || DEFAULT_COMFY_WORKFLOW
  return path.isAbsolute(raw) ? raw : path.join(process.cwd(), raw)
}

export function isHologramConfigured(): boolean {
  const p = hologramProvider()
  if (p === 'openrouter') return Boolean(process.env.OPENROUTER_API_KEY?.trim())
  if (p === 'openai') return Boolean(process.env.OPENAI_API_KEY?.trim())
  return Boolean(process.env.COMFYUI_BASE_URL?.trim()) && fs.existsSync(comfyWorkflowPath())
}

export function readHologramJob(metrics: Record<string, unknown>): HologramJob | null {
  const raw = metrics.hologram_job
  if (!raw || typeof raw !== 'object') return null
  const job = raw as Partial<HologramJob>
  if (job.status !== 'running' && job.status !== 'done' && job.status !== 'failed') return null
  const startedAt = typeof job.startedAt === 'string' ? job.startedAt : ''
  const startedMs = Date.parse(startedAt)
  if (job.status === 'running' && (!Number.isFinite(startedMs) || Date.now() - startedMs > HOLOGRAM_JOB_STALE_MS)) {
    return { status: 'failed', startedAt, error: 'Hologram did not finish. Please try again.' }
  }
  return {
    status: job.status,
    startedAt,
    ...(typeof job.finishedAt === 'string' ? { finishedAt: job.finishedAt } : {}),
    ...(typeof job.error === 'string' ? { error: job.error } : {}),
  }
}

export function parseCachedHologram(raw: unknown): HologramResult | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const image = typeof o.image === 'string' ? o.image.trim() : ''
  const frameImage = typeof o.frameImage === 'string' ? o.frameImage.trim() : ''
  if (!image || !frameImage) return null
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)
  const orbitFrames = parseStoredOrbitFrames(o.orbitFrames)
  return {
    image,
    frameImage,
    contactMs: num(o.contactMs),
    frame: num(o.frame),
    keypoints: parseStoredKeypoints(o.keypoints),
    ...(typeof o.orbitVideo === 'string' && o.orbitVideo.trim() ? { orbitVideo: o.orbitVideo.trim() } : {}),
    ...(num(o.orbitDurationMs) != null ? { orbitDurationMs: num(o.orbitDurationMs) } : {}),
    ...(num(o.orbitFrameCount) != null ? { orbitFrameCount: num(o.orbitFrameCount) } : {}),
    ...(num(o.orbitWidth) != null ? { orbitWidth: num(o.orbitWidth) } : {}),
    ...(num(o.orbitHeight) != null ? { orbitHeight: num(o.orbitHeight) } : {}),
    ...(orbitFrames?.length ? { orbitFrames } : {}),
  }
}

function parseStoredOrbitFrames(raw: unknown): HologramOrbitFrame[] | null {
  if (!Array.isArray(raw)) return null
  const out: HologramOrbitFrame[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const row = item as { frame?: unknown; keypoints?: unknown }
    const frame = typeof row.frame === 'number' && Number.isFinite(row.frame) ? Math.round(row.frame) : null
    const keypoints = parseStoredKeypoints(row.keypoints)
    if (frame == null || !keypoints) continue
    out.push({ frame, keypoints })
  }
  return out.length ? out : null
}

/**
 * Where to grab the impact frame: the contact the user marked (request, then stored on the
 * analysis), else the impact frame the analysis resolved. Null when neither is known yet.
 */
export function resolveHologramMoment(
  metrics: Record<string, unknown>,
  requestContactMs: unknown,
  requestContactFrame?: unknown
): { contactMs: number } | { frame: number } | null {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null)
  // The tapped frame index is exact. A timestamp seek can land on a different picture.
  const frame = n(requestContactFrame) ?? n(metrics.user_contact_frame)
  if (frame != null) return { frame }
  const contactMs = n(requestContactMs) ?? n(metrics.user_contact_ms)
  if (contactMs != null) return { contactMs }
  const impact = n(metrics.impact_frame_resolved)
  return impact != null ? { frame: impact } : null
}

/** Player box as fractions of the frame: left/top/right/bottom in 0..1. */
type PlayerBox = { x0: number; y0: number; x1: number; y1: number }

/** Room around the skeleton for the ball and the feet. */
const PLAYER_MARGIN = 0.2
/** The skeleton stops at the wrist; the racket and ball reach about this much of its height above it. */
const RACKET_HEADROOM = 0.3

/**
 * Finds the player with SDPose on the full frame. The drawn skeleton is the only non-black content
 * of its image, so its pixel bounds are the player's box. Null when nothing is detected.
 */
async function detectPlayerBox(baseUrl: string, png: Buffer, id: string): Promise<PlayerBox | null> {
  const workflow = JSON.parse(fs.readFileSync(DETECT_WORKFLOW, 'utf8')) as Record<string, { inputs: Record<string, unknown> }>
  const up = await comfyUploadImage(baseUrl, png, `xevo_hologram_detect_${id}.png`)
  workflow['1'].inputs.image = up.subfolder ? `${up.subfolder}/${up.name}` : up.name
  const { prompt_id } = await comfyQueuePrompt(baseUrl, workflow)
  const out = await comfyWaitForOutputImage(baseUrl, prompt_id, { timeoutMs: 180_000, pollMs: 1000 })
  const { buffer } = await comfyViewToBuffer(baseUrl, out.filename, out.subfolder, out.type)

  const { data, info } = await sharp(buffer).greyscale().raw().toBuffer({ resolveWithObject: true })
  let x0 = info.width
  let y0 = info.height
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[y * info.width + x] > 24) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  if (x1 < 0) return null
  return { x0: x0 / info.width, y0: y0 / info.height, x1: (x1 + 1) / info.width, y1: (y1 + 1) / info.height }
}

/** Pixel crop of the full frame before the 1024 resize — used to map MediaPipe into hologram space. */
export type HologramCropRect = { left: number; top: number; side: number; srcW: number; srcH: number }

/**
 * Square around the player (box plus margin), clamped inside the frame; without a box, the largest
 * square around (CROP_CX, CROP_CY) like the script's ffmpeg crop. Scaled to 1024.
 */
async function squareCrop(
  png: Buffer,
  box: PlayerBox | null
): Promise<{ buffer: Buffer; crop: HologramCropRect }> {
  const meta = await sharp(png).metadata()
  const w = meta.width ?? 0
  const h = meta.height ?? 0
  if (!w || !h) throw new Error('Impact frame has no dimensions')
  const maxSide = Math.min(w, h)
  let side = maxSide
  let left = (w - side) * CROP_CX
  let top = (h - side) * CROP_CY
  if (box) {
    box = { ...box, y0: Math.max(0, box.y0 - (box.y1 - box.y0) * RACKET_HEADROOM) }
    const bw = (box.x1 - box.x0) * w
    const bh = (box.y1 - box.y0) * h
    side = Math.min(maxSide, Math.max(bw, bh) * (1 + PLAYER_MARGIN))
    const cx = ((box.x0 + box.x1) / 2) * w
    const cy = ((box.y0 + box.y1) / 2) * h
    left = Math.min(Math.max(0, cx - side / 2), w - side)
    top = Math.min(Math.max(0, cy - side / 2), h - side)
  }
  const leftR = Math.round(left)
  const topR = Math.round(top)
  const sideR = Math.round(side)
  const buffer = await sharp(png)
    .extract({ left: leftR, top: topR, width: sideR, height: sideR })
    .resize(SIZE, SIZE)
    .png()
    .toBuffer()
  return { buffer, crop: { left: leftR, top: topR, side: sideR, srcW: w, srcH: h } }
}

/** MediaPipe PoseLandmark names -> Smart 3D / SDPose joint ids. */
const MP_TO_HOLO: Array<[string, string]> = [
  ['NOSE', 'nose'],
  ['LEFT_EYE', 'left_eye'],
  ['RIGHT_EYE', 'right_eye'],
  ['LEFT_EAR', 'left_ear'],
  ['RIGHT_EAR', 'right_ear'],
  ['LEFT_SHOULDER', 'left_shoulder'],
  ['RIGHT_SHOULDER', 'right_shoulder'],
  ['LEFT_ELBOW', 'left_elbow'],
  ['RIGHT_ELBOW', 'right_elbow'],
  ['LEFT_WRIST', 'left_wrist'],
  ['RIGHT_WRIST', 'right_wrist'],
  ['LEFT_HIP', 'left_hip'],
  ['RIGHT_HIP', 'right_hip'],
  ['LEFT_KNEE', 'left_knee'],
  ['RIGHT_KNEE', 'right_knee'],
  ['LEFT_ANKLE', 'left_ankle'],
  ['RIGHT_ANKLE', 'right_ankle'],
  ['LEFT_HEEL', 'left_heel'],
  ['RIGHT_HEEL', 'right_heel'],
  ['LEFT_FOOT_INDEX', 'left_big_toe'],
  ['RIGHT_FOOT_INDEX', 'right_big_toe'],
]

type MpLandmark = { x?: number; y?: number; visibility?: number; score?: number }

function putHologramJoint(
  out: HologramKeypoints,
  name: string,
  x: number,
  y: number,
  score: number
) {
  if (![x, y, score].every(Number.isFinite) || score < KEYPOINT_MIN_SCORE) return
  if (x < -0.05 || x > 1.05 || y < -0.05 || y > 1.05) return
  out[name] = {
    x: +Math.min(1, Math.max(0, x)).toFixed(4),
    y: +Math.min(1, Math.max(0, y)).toFixed(4),
    score: +score.toFixed(3),
  }
}

/**
 * MediaPipe landmarks already in the hologram still's own 0..1 space (pose run on the PNG/mp4).
 * Prefer this over crop-projected analysis pose — Nano Banana reframes the figure.
 */
export function landmarksInImageToHologramKeypoints(
  landmarks: Record<string, MpLandmark | undefined>
): HologramKeypoints | null {
  const out: HologramKeypoints = {}
  for (const [mp, holo] of MP_TO_HOLO) {
    const p = landmarks[mp] || landmarks[mp.toLowerCase()]
    if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') continue
    const score =
      typeof p.visibility === 'number' ? p.visibility : typeof p.score === 'number' ? p.score : 0.9
    putHologramJoint(out, holo, p.x, p.y, score)
  }
  const ls = out.left_shoulder
  const rs = out.right_shoulder
  if (ls && rs) {
    putHologramJoint(out, 'neck', (ls.x + rs.x) / 2, (ls.y + rs.y) / 2, Math.min(ls.score, rs.score))
  }
  return Object.keys(out).length ? out : null
}

/**
 * Project analysis MediaPipe landmarks (full-frame 0..1) into the square hologram crop (0..1).
 * Last-resort only: Nano Banana often shifts the figure, so crop-projected joints look wrong.
 */
export function mapMediaPipeToHologramKeypoints(
  landmarks: Record<string, MpLandmark | undefined>,
  crop: HologramCropRect
): HologramKeypoints | null {
  if (!crop.side || !crop.srcW || !crop.srcH) return null
  const out: HologramKeypoints = {}
  for (const [mp, holo] of MP_TO_HOLO) {
    const p = landmarks[mp] || landmarks[mp.toLowerCase()]
    if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') continue
    const score =
      typeof p.visibility === 'number' ? p.visibility : typeof p.score === 'number' ? p.score : 0.9
    const px = p.x * crop.srcW
    const py = p.y * crop.srcH
    putHologramJoint(out, holo, (px - crop.left) / crop.side, (py - crop.top) / crop.side, score)
  }
  const ls = out.left_shoulder
  const rs = out.right_shoulder
  if (ls && rs) {
    putHologramJoint(out, 'neck', (ls.x + rs.x) / 2, (ls.y + rs.y) / 2, Math.min(ls.score, rs.score))
  }
  return Object.keys(out).length ? out : null
}

function resolveFfmpeg(): string {
  return process.env.FFMPEG_PATH?.trim() || ffmpegStatic || 'ffmpeg'
}

/** One-second mp4 of the still so Modal's video MediaPipe endpoint can pose it. */
async function encodeStillMp4(png: Buffer): Promise<Buffer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xevo-holo-pose-'))
  const pngPath = path.join(dir, 'still.png')
  const mp4Path = path.join(dir, 'still.mp4')
  fs.writeFileSync(pngPath, png)
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        resolveFfmpeg(),
        [
          '-y',
          '-loop',
          '1',
          '-i',
          pngPath,
          '-t',
          '1',
          '-vf',
          `scale=${SIZE}:${SIZE}`,
          '-pix_fmt',
          'yuv420p',
          '-r',
          '8',
          mp4Path,
        ],
        (err) => (err ? reject(err) : resolve())
      )
    })
    return fs.readFileSync(mp4Path)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Run MediaPipe on the generated hologram still (via a 1s clip + Modal) so markers sit on
 * the Nano Banana figure, not the pre-edit crop.
 */
export async function poseHologramStill(
  png: Buffer,
  analysisId: string
): Promise<HologramKeypoints | null> {
  const modal = process.env.MODAL_WEBHOOK_URL?.trim()
  if (!modal) {
    console.warn('[Technique][hologram] still pose skipped — MODAL_WEBHOOK_URL unset')
    return null
  }
  if (!isCloudinaryConfigured()) {
    console.warn('[Technique][hologram] still pose skipped — Cloudinary unset')
    return null
  }
  const t0 = Date.now()
  try {
    const mp4 = await encodeStillMp4(png)
    const videoUrl = await uploadBufferToCloudinary(mp4, {
      filenameHint: 'hologram-still.mp4',
      resourceType: 'video',
      publicId: `xevo/hologram-pose/${analysisId}-${Date.now()}`,
    })
    const res = await fetch(modal, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        video_url: videoUrl,
        analysis_id: `${analysisId}-holo-still`,
        model: 'mediapipe',
      }),
    })
    const body = (await res.json().catch(() => null)) as {
      status?: string
      metrics?: { pose_data?: Array<{ frame?: number; landmarks?: Record<string, MpLandmark> }> }
    } | null
    if (!res.ok || body?.status !== 'success') {
      console.warn('[Technique][hologram] still pose modal failed', {
        analysisId,
        status: body?.status ?? res.status,
        elapsedMs: Date.now() - t0,
      })
      return null
    }
    const rows = Array.isArray(body.metrics?.pose_data) ? body.metrics!.pose_data! : []
    let best: HologramKeypoints | null = null
    let bestN = 0
    for (const row of rows) {
      if (!row?.landmarks) continue
      const k = landmarksInImageToHologramKeypoints(row.landmarks)
      const n = k ? Object.keys(k).length : 0
      if (n > bestN) {
        best = k
        bestN = n
      }
    }
    console.log('[Technique][hologram] still pose ok', {
      analysisId,
      joints: bestN,
      frames: rows.length,
      elapsedMs: Date.now() - t0,
    })
    return best
  } catch (e: any) {
    console.warn('[Technique][hologram] still pose error', { analysisId, message: e?.message })
    return null
  }
}

/** Nearest pose_data row to the contact frame / ms for hologram joint fallback. */
export function pickPoseLandmarksForHologram(
  poseData: unknown,
  moment: { contactMs: number } | { frame: number },
  fpsHint?: number
): Record<string, { x: number; y: number; visibility?: number }> | null {
  if (!Array.isArray(poseData) || !poseData.length) return null
  const rows = poseData
    .map((r) => {
      if (!r || typeof r !== 'object') return null
      const row = r as { frame?: unknown; frame_idx?: unknown; landmarks?: unknown }
      const frame =
        typeof row.frame === 'number'
          ? row.frame
          : typeof row.frame_idx === 'number'
            ? row.frame_idx
            : null
      const landmarks = row.landmarks
      if (frame == null || !landmarks || typeof landmarks !== 'object') return null
      return { frame, landmarks: landmarks as Record<string, { x: number; y: number; visibility?: number }> }
    })
    .filter(Boolean) as Array<{
    frame: number
    landmarks: Record<string, { x: number; y: number; visibility?: number }>
  }>
  if (!rows.length) return null
  let targetFrame: number
  if ('frame' in moment) {
    targetFrame = moment.frame
  } else {
    const fps = fpsHint && fpsHint > 1 ? fpsHint : 30
    targetFrame = Math.round((moment.contactMs / 1000) * fps)
  }
  let best = rows[0]
  let dist = Math.abs(best.frame - targetFrame)
  for (const row of rows) {
    const d = Math.abs(row.frame - targetFrame)
    if (d < dist) {
      best = row
      dist = d
    }
  }
  return best.landmarks
}

async function comfyImageEdit(
  prompt: string,
  frame: Buffer
): Promise<{ image: Buffer; keypoints: HologramKeypoints | null }> {
  const baseUrl = String(process.env.COMFYUI_BASE_URL ?? '').trim()
  if (!baseUrl) throw new HologramError(503, 'COMFYUI_BASE_URL is not set')
  const workflow = JSON.parse(fs.readFileSync(comfyWorkflowPath(), 'utf8')) as Record<
    string,
    { inputs: Record<string, unknown> }
  >
  const id = randomUUID()
  const frameUp = await comfyUploadImage(baseUrl, frame, `xevo_hologram_frame_${id}.png`)
  const imageRef = (u: { name: string; subfolder: string }) => (u.subfolder ? `${u.subfolder}/${u.name}` : u.name)
  workflow[COMFY_NODES.frame].inputs.image = imageRef(frameUp)
  workflow[COMFY_NODES.prompt].inputs.prompt = prompt
  workflow[COMFY_NODES.negative].inputs.prompt = HOLOGRAM_NEGATIVE_PROMPT
  workflow[COMFY_NODES.sampler].inputs.seed = Math.floor(Math.random() * 2 ** 48)

  const t0 = Date.now()
  const { prompt_id } = await comfyQueuePrompt(baseUrl, workflow)
  const out = await comfyWaitForOutputImage(baseUrl, prompt_id, {
    timeoutMs: Number(process.env.COMFYUI_TIMEOUT_MS ?? 420_000) || 420_000,
    pollMs: 1500,
  })
  const { buffer } = await comfyViewToBuffer(baseUrl, out.filename, out.subfolder, out.type)
  const keypoints = await readComfyKeypoints(baseUrl, prompt_id)
  console.log('[Technique][hologram] comfy done', {
    promptId: prompt_id,
    keypoints: keypoints ? Object.keys(keypoints).length : 0,
    elapsedMs: Date.now() - t0,
  })
  return { image: buffer, keypoints }
}

/** The keypoints node's text lands in the run's history next to the image; missing is not fatal. */
async function readComfyKeypoints(baseUrl: string, promptId: string): Promise<HologramKeypoints | null> {
  try {
    const url = `${baseUrl.replace(/\/+$/, '')}/history/${encodeURIComponent(promptId)}`
    const history: any = await (await fetch(url, { headers: withNgrokHeaders(url) })).json()
    const text = history?.[promptId]?.outputs?.[COMFY_NODES.keypoints]?.text?.[0]
    return typeof text === 'string' ? parseSdposeKeypoints(text) : null
  } catch (e: any) {
    console.warn('[Technique][hologram] could not read keypoints', e?.message)
    return null
  }
}

async function gptImageEdit(prompt: string, images: { name: string; data: Buffer }[]): Promise<Buffer> {
  const key = process.env.OPENAI_API_KEY?.trim()
  if (!key) throw new HologramError(503, 'OPENAI_API_KEY is not set')
  const form = new FormData()
  form.append('model', process.env.HOLOGRAM_IMAGE_MODEL?.trim() || 'gpt-image-2')
  form.append('prompt', prompt)
  form.append('size', `${SIZE}x${SIZE}`)
  form.append('quality', process.env.HOLOGRAM_IMAGE_QUALITY?.trim() || 'high')
  for (const img of images) {
    form.append('image[]', new Blob([new Uint8Array(img.data)], { type: 'image/png' }), img.name)
  }
  const res = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  })
  const body: any = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(`OpenAI images/edits ${res.status}: ${body?.error?.message ?? JSON.stringify(body)}`)
  }
  const b64 = body?.data?.[0]?.b64_json
  if (typeof b64 !== 'string') throw new Error('OpenAI images/edits returned no image')
  console.log('[Technique][hologram] image done', {
    requestId: res.headers.get('x-request-id'),
    usage: body.usage ?? null,
  })
  return Buffer.from(b64, 'base64')
}

/**
 * OpenRouter Nano Banana image edit: contact crop in, electric-blue hologram out.
 * Tries /images first, then chat/completions with modalities as a fallback.
 */
async function openRouterImageEdit(prompt: string, frame: Buffer): Promise<Buffer> {
  const key = process.env.OPENROUTER_API_KEY?.trim()
  if (!key) throw new HologramError(503, 'OPENROUTER_API_KEY is not set')
  const base = (process.env.OPENROUTER_BASE_URL?.trim() || 'https://openrouter.ai/api/v1').replace(/\/+$/, '')
  const model =
    process.env.HOLOGRAM_IMAGE_MODEL?.trim() ||
    process.env.OPENROUTER_HOLOGRAM_MODEL?.trim() ||
    DEFAULT_OPENROUTER_HOLOGRAM_MODEL
  const dataUrl = `data:image/png;base64,${frame.toString('base64')}`
  const headers = {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    'X-Title': 'Xevo contact hologram',
  }
  const t0 = Date.now()

  const imagesRes = await fetch(`${base}/images`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      prompt: `${prompt}\n\nAvoid: ${HOLOGRAM_NEGATIVE_PROMPT}`,
      input_references: [{ type: 'image_url', image_url: { url: dataUrl } }],
    }),
  })
  if (imagesRes.ok) {
    const body: any = await imagesRes.json().catch(() => ({}))
    const b64 = body?.data?.[0]?.b64_json
    if (typeof b64 === 'string') {
      console.log('[Technique][hologram] openrouter /images done', {
        model,
        elapsedMs: Date.now() - t0,
      })
      return Buffer.from(b64, 'base64')
    }
  } else {
    const detail = (await imagesRes.text()).slice(0, 400)
    console.warn('[Technique][hologram] openrouter /images failed, trying chat', {
      status: imagesRes.status,
      detail,
    })
  }

  const chatRes = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: `${prompt}\n\nAvoid: ${HOLOGRAM_NEGATIVE_PROMPT}` },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
      modalities: ['image', 'text'],
    }),
  })
  const chatBody: any = await chatRes.json().catch(() => ({}))
  if (!chatRes.ok) {
    throw new Error(
      `OpenRouter hologram ${chatRes.status}: ${chatBody?.error?.message ?? JSON.stringify(chatBody).slice(0, 400)}`
    )
  }
  const message = chatBody?.choices?.[0]?.message
  const images: unknown[] = Array.isArray(message?.images) ? message.images : []
  for (const img of images) {
    const url =
      typeof img === 'string'
        ? img
        : typeof (img as { image_url?: { url?: string } })?.image_url?.url === 'string'
          ? (img as { image_url: { url: string } }).image_url.url
          : typeof (img as { image_url?: string })?.image_url === 'string'
            ? (img as { image_url: string }).image_url
            : null
    const m = url?.match(/^data:image\/[a-zA-Z0-9+.-]+;base64,(.+)$/)
    if (m?.[1]) {
      console.log('[Technique][hologram] openrouter chat image done', {
        model,
        elapsedMs: Date.now() - t0,
      })
      return Buffer.from(m[1], 'base64')
    }
  }
  const parts = Array.isArray(message?.content) ? message.content : []
  for (const part of parts) {
    const inline = part?.inline_data?.data || part?.inlineData?.data
    if (typeof inline === 'string') {
      console.log('[Technique][hologram] openrouter chat inline done', {
        model,
        elapsedMs: Date.now() - t0,
      })
      return Buffer.from(inline, 'base64')
    }
  }
  throw new Error('OpenRouter hologram returned no image bytes')
}

/** SDPose-only pass so Smart 3D can keep elbow/joint hit targets after a non-Comfy image edit. */
async function comfyExtractKeypoints(png: Buffer): Promise<HologramKeypoints | null> {
  const baseUrl = String(process.env.COMFYUI_BASE_URL ?? '').trim()
  if (!baseUrl || !fs.existsSync(KEYPOINTS_WORKFLOW)) return null
  try {
    const workflow = JSON.parse(fs.readFileSync(KEYPOINTS_WORKFLOW, 'utf8')) as Record<
      string,
      { inputs: Record<string, unknown> }
    >
    const id = randomUUID()
    const up = await comfyUploadImage(baseUrl, png, `xevo_hologram_pose_${id}.png`)
    workflow['1'].inputs.image = up.subfolder ? `${up.subfolder}/${up.name}` : up.name
    const { prompt_id } = await comfyQueuePrompt(baseUrl, workflow)
    await comfyWaitForOutputImage(baseUrl, prompt_id, { timeoutMs: 180_000, pollMs: 1000 })
    const keypoints = await readComfyKeypoints(baseUrl, prompt_id)
    console.log('[Technique][hologram] sdpose keypoints', {
      promptId: prompt_id,
      joints: keypoints ? Object.keys(keypoints).length : 0,
    })
    return keypoints
  } catch (e: any) {
    console.warn('[Technique][hologram] sdpose keypoints failed', e?.message)
    return null
  }
}

/** Impact frame -> square crop -> hologram still; both PNGs land under /uploads/technique-holograms. */
export async function generateHologram(opts: {
  analysisId: string
  videoPath: string
  moment: { contactMs: number } | { frame: number }
  /** Defaults to the player's blue hologram. The pro reference uses the red prompt. */
  prompt?: string
  /** Filename stem so a second render does not replace the player's files. */
  fileStem?: string
  /** Analysis pose_data — MediaPipe fallback for joints when SDPose is unavailable. */
  poseData?: unknown
  /** FPS hint when mapping contactMs -> pose frame. */
  fpsHint?: number
}): Promise<HologramResult> {
  if (!fs.existsSync(opts.videoPath)) throw new HologramError(404, 'Video file missing on server')
  const raw =
    'contactMs' in opts.moment
      ? await extractFrameByTimestamp(opts.videoPath, opts.moment.contactMs / 1000)
      : await extractFrame(opts.videoPath, opts.moment.frame)
  if (!raw.length) throw new Error('Could not extract the impact frame')
  // Centre on the player when ComfyUI can find them; the fixed crop is the fallback.
  let box: PlayerBox | null = null
  const comfyBase = String(process.env.COMFYUI_BASE_URL ?? '').trim()
  const provider = hologramProvider()
  if (comfyBase) {
    box = await detectPlayerBox(comfyBase, raw, randomUUID()).catch((e) => {
      console.warn('[Technique][hologram] player detection failed, using the fixed crop', e?.message)
      return null
    })
  }
  const { buffer: frame, crop } = await squareCrop(raw, box)
  const prompt = opts.prompt ?? HOLOGRAM_PROMPT

  let hologram: Buffer
  let keypoints: HologramKeypoints | null = null
  if (provider === 'openrouter') {
    hologram = await openRouterImageEdit(prompt, frame)
    // Pose the *edited* still — crop-projected analysis pose will not match Nano Banana framing.
    keypoints = await comfyExtractKeypoints(hologram)
    if (!keypoints) keypoints = await poseHologramStill(hologram, opts.analysisId)
  } else if (provider === 'openai') {
    hologram = await gptImageEdit(prompt, [{ name: 'frame.png', data: frame }])
    keypoints = await comfyExtractKeypoints(hologram)
    if (!keypoints) keypoints = await poseHologramStill(hologram, opts.analysisId)
  } else {
    ;({ image: hologram, keypoints } = await comfyImageEdit(prompt, frame))
  }

  if (!keypoints && opts.poseData) {
    const lm = pickPoseLandmarksForHologram(opts.poseData, opts.moment, opts.fpsHint)
    if (lm) {
      keypoints = mapMediaPipeToHologramKeypoints(lm, crop)
      console.log('[Technique][hologram] mediapipe crop fallback', {
        joints: keypoints ? Object.keys(keypoints).length : 0,
      })
    }
  }

  // Keypoints come from posing the edited still (same 0..1 space as the PNG). Do not remap —
  // overview joints already prove MediaPipe coords paint correctly when the pose is on that image.

  const dir = path.join(HOLOGRAM_UPLOAD_ROOT, opts.analysisId)
  fs.mkdirSync(dir, { recursive: true })
  // Timestamped names so a regenerated hologram is never served from a stale image cache.
  const stamp = Date.now()
  const stem = opts.fileStem ?? 'hologram'
  const frameName = stem === 'hologram' ? `impact-${stamp}.png` : `${stem}-impact-${stamp}.png`
  const imageName = `${stem}-${stamp}.png`
  fs.writeFileSync(path.join(dir, frameName), frame)
  fs.writeFileSync(path.join(dir, imageName), hologram)
  return {
    image: `/uploads/technique-holograms/${opts.analysisId}/${imageName}`,
    frameImage: `/uploads/technique-holograms/${opts.analysisId}/${frameName}`,
    contactMs: 'contactMs' in opts.moment ? opts.moment.contactMs : null,
    frame: 'frame' in opts.moment ? opts.moment.frame : null,
    keypoints,
  }
}

