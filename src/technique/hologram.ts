import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import sharp from 'sharp'
import { extractFrame, extractFrameByTimestamp } from './frameExtractor'
import { withNgrokHeaders } from '../lib/ngrokFetch'
import { comfyQueuePrompt, comfyUploadImage, comfyViewToBuffer, comfyWaitForOutputImage } from './comfyClient'

/**
 * The run.json hologram prompt with the look described in words. A style image in the prompt made
 * both Qwen and GPT Image copy that image's pose instead of the player's, so only the frame goes in;
 * on ComfyUI the contact pose is also pinned by SDPose + the Qwen Fun ControlNet in the workflow.
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
/** Node ids in the hologram workflow: frame LoadImage, positive and negative prompt, sampler. */
const COMFY_NODES = { frame: '10', prompt: '20', negative: '21', sampler: '50', keypoints: '90' }
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

/** ComfyUI (Kyle's machine, COMFYUI_BASE_URL) by default; HOLOGRAM_PROVIDER=openai uses GPT Image instead. */
function hologramProvider(): 'comfy' | 'openai' {
  return process.env.HOLOGRAM_PROVIDER?.trim().toLowerCase() === 'openai' ? 'openai' : 'comfy'
}

function comfyWorkflowPath(): string {
  const raw = process.env.HOLOGRAM_COMFY_WORKFLOW_PATH?.trim() || DEFAULT_COMFY_WORKFLOW
  return path.isAbsolute(raw) ? raw : path.join(process.cwd(), raw)
}

export function isHologramConfigured(): boolean {
  if (hologramProvider() === 'openai') return Boolean(process.env.OPENAI_API_KEY?.trim())
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

/**
 * Square around the player (box plus margin), clamped inside the frame; without a box, the largest
 * square around (CROP_CX, CROP_CY) like the script's ffmpeg crop. Scaled to 1024.
 */
async function squareCrop(png: Buffer, box: PlayerBox | null): Promise<Buffer> {
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
  return sharp(png)
    .extract({ left: Math.round(left), top: Math.round(top), width: Math.round(side), height: Math.round(side) })
    .resize(SIZE, SIZE)
    .png()
    .toBuffer()
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

/** Impact frame -> square crop -> GPT Image hologram; both PNGs land under /uploads/technique-holograms. */
export async function generateHologram(opts: {
  analysisId: string
  videoPath: string
  moment: { contactMs: number } | { frame: number }
  /** Defaults to the player's blue hologram. The pro reference uses the red prompt. */
  prompt?: string
  /** Filename stem so a second render does not replace the player's files. */
  fileStem?: string
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
  if (hologramProvider() === 'comfy' && comfyBase) {
    box = await detectPlayerBox(comfyBase, raw, randomUUID()).catch((e) => {
      console.warn('[Technique][hologram] player detection failed, using the fixed crop', e?.message)
      return null
    })
  }
  const frame = await squareCrop(raw, box)
  const prompt = opts.prompt ?? HOLOGRAM_PROMPT
  const { image: hologram, keypoints } =
    hologramProvider() === 'openai'
      ? { image: await gptImageEdit(prompt, [{ name: 'frame.png', data: frame }]), keypoints: null }
      : await comfyImageEdit(prompt, frame)

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
