import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import sharp from 'sharp'
import { extractFrame, extractFrameByTimestamp } from './frameExtractor'
import { comfyQueuePrompt, comfyUploadImage, comfyViewToBuffer, comfyWaitForOutputImage } from './comfyClient'

/**
 * The run.json hologram prompt with the look described in words. A style image in the prompt made
 * both Qwen and GPT Image copy that image's pose instead of the player's, so only the frame goes in;
 * on ComfyUI the contact pose is also pinned by SDPose + the Qwen Fun ControlNet in the workflow.
 */
export const HOLOGRAM_PROMPT =
  'Turn the padel player into a 3D hologram: translucent electric-blue body made of a fine wireframe mesh with ' +
  'glowing joint nodes, cyan edge light, a glowing racket and a glowing yellow-green ball. Keep the exact pose, ' +
  'body proportions, camera angle and framing of the photo. The hologram has no face: a smooth, featureless head. ' +
  'No reflections. Remove the court fence, the glass walls and the net; keep only the blue court floor with its ' +
  'white lines, against a dark navy background. Nothing in front of the player.'

const DEFAULT_COMFY_WORKFLOW = 'workflows/qwen_image_edit_2511_hologram.api.json'
/** Node ids in the hologram workflow: frame LoadImage, positive prompt, sampler. */
const COMFY_NODES = { frame: '10', prompt: '20', sampler: '50' }
const HOLOGRAM_UPLOAD_ROOT = path.join(process.cwd(), 'uploads', 'technique-holograms')

/** Square crop centre used for the approved run; the player sits a little below centre in portrait clips. */
const CROP_CX = 0.5
const CROP_CY = 0.62
const SIZE = 1024

/** A render takes a minute or two; anything still "running" well past that died with the process. */
export const HOLOGRAM_JOB_STALE_MS = 10 * 60_000

export type HologramResult = {
  image: string
  frameImage: string
  contactMs: number | null
  frame: number | null
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
  return { image, frameImage, contactMs: num(o.contactMs), frame: num(o.frame) }
}

/**
 * Where to grab the impact frame: the contact the user marked (request, then stored on the
 * analysis), else the impact frame the analysis resolved. Null when neither is known yet.
 */
export function resolveHologramMoment(
  metrics: Record<string, unknown>,
  requestContactMs: unknown
): { contactMs: number } | { frame: number } | null {
  const ms = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null)
  const contactMs = ms(requestContactMs) ?? ms(metrics.user_contact_ms)
  if (contactMs != null) return { contactMs }
  const frame = ms(metrics.impact_frame_resolved)
  return frame != null ? { frame } : null
}

/** Largest square around (CROP_CX, CROP_CY), scaled to 1024 like the script's ffmpeg crop. */
async function squareCrop(png: Buffer): Promise<Buffer> {
  const meta = await sharp(png).metadata()
  const w = meta.width ?? 0
  const h = meta.height ?? 0
  if (!w || !h) throw new Error('Impact frame has no dimensions')
  const side = Math.min(w, h)
  return sharp(png)
    .extract({
      left: Math.round((w - side) * CROP_CX),
      top: Math.round((h - side) * CROP_CY),
      width: side,
      height: side,
    })
    .resize(SIZE, SIZE)
    .png()
    .toBuffer()
}

async function comfyImageEdit(prompt: string, frame: Buffer): Promise<Buffer> {
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
  workflow[COMFY_NODES.sampler].inputs.seed = Math.floor(Math.random() * 2 ** 48)

  const t0 = Date.now()
  const { prompt_id } = await comfyQueuePrompt(baseUrl, workflow)
  const out = await comfyWaitForOutputImage(baseUrl, prompt_id, {
    timeoutMs: Number(process.env.COMFYUI_TIMEOUT_MS ?? 420_000) || 420_000,
    pollMs: 1500,
  })
  const { buffer } = await comfyViewToBuffer(baseUrl, out.filename, out.subfolder, out.type)
  console.log('[Technique][hologram] comfy done', { promptId: prompt_id, elapsedMs: Date.now() - t0 })
  return buffer
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
}): Promise<HologramResult> {
  if (!fs.existsSync(opts.videoPath)) throw new HologramError(404, 'Video file missing on server')
  const raw =
    'contactMs' in opts.moment
      ? await extractFrameByTimestamp(opts.videoPath, opts.moment.contactMs / 1000)
      : await extractFrame(opts.videoPath, opts.moment.frame)
  if (!raw.length) throw new Error('Could not extract the impact frame')
  const frame = await squareCrop(raw)
  const hologram =
    hologramProvider() === 'openai'
      ? await gptImageEdit(HOLOGRAM_PROMPT, [{ name: 'frame.png', data: frame }])
      : await comfyImageEdit(HOLOGRAM_PROMPT, frame)

  const dir = path.join(HOLOGRAM_UPLOAD_ROOT, opts.analysisId)
  fs.mkdirSync(dir, { recursive: true })
  // Timestamped names so a regenerated hologram is never served from a stale image cache.
  const stamp = Date.now()
  const frameName = `impact-${stamp}.png`
  const imageName = `hologram-${stamp}.png`
  fs.writeFileSync(path.join(dir, frameName), frame)
  fs.writeFileSync(path.join(dir, imageName), hologram)
  return {
    image: `/uploads/technique-holograms/${opts.analysisId}/${imageName}`,
    frameImage: `/uploads/technique-holograms/${opts.analysisId}/${frameName}`,
    contactMs: 'contactMs' in opts.moment ? opts.moment.contactMs : null,
    frame: 'frame' in opts.moment ? opts.moment.frame : null,
  }
}
