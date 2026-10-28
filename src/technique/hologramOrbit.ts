import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import sharp from 'sharp'
import ffmpegStatic from 'ffmpeg-static'
import { probeVideoStreamMeta } from './frameExtractor'
import type { HologramKeypoints, HologramOrbitFrame } from './hologram'

const ORBIT_PROMPT =
  'One continuous camera orbit, clockwise only, constant speed, exactly one full 360-degree revolution in this 4 second clip. ' +
  'The camera keeps going the same direction the whole time. It does not reverse, rewind, or turn back. ' +
  'It starts on this exact view, passes the player\'s side, continues until the back of the head and the back of the body are clearly visible, ' +
  'continues to the other side, and only then arrives back at this starting view by finishing the circle. ' +
  'The holographic player is a frozen statue. Zero body motion. The hands, arms, racket, head, and feet never move. ' +
  'Do not push, raise, or lower the hand. Do not bring the other hand onto the racket. The pose in every frame is this exact pose, only the camera angle changes. ' +
  'Electric royal blue fine horizontal scan-line hologram, bald featureless mannequin head, no face, no clothes, one racket, one ball touching the racket face. ' +
  'Pure black background, glossy black floor, blue concentric rings under the feet.'

/** MediaPipe joint name -> the hologram overlay name. Neck is filled from the shoulders. */
const JOINTS: Record<string, string> = {
  NOSE: 'nose',
  LEFT_SHOULDER: 'left_shoulder',
  RIGHT_SHOULDER: 'right_shoulder',
  LEFT_ELBOW: 'left_elbow',
  RIGHT_ELBOW: 'right_elbow',
  LEFT_WRIST: 'left_wrist',
  RIGHT_WRIST: 'right_wrist',
  LEFT_HIP: 'left_hip',
  RIGHT_HIP: 'right_hip',
  LEFT_KNEE: 'left_knee',
  RIGHT_KNEE: 'right_knee',
  LEFT_ANKLE: 'left_ankle',
  RIGHT_ANKLE: 'right_ankle',
}

type MpPoint = { x?: number; y?: number; visibility?: number; score?: number }

/**
 * MediaPipe pose rows from the orbit clip, in video-frame order, as hologram keypoints.
 * Coordinates stay in that frame's 0..1 space so the markers sit on the picture.
 */
export function mediapipeFramesToOrbit(
  poseData: Array<{ frame?: number; landmarks?: Record<string, MpPoint> | null }> | null | undefined
): HologramOrbitFrame[] {
  if (!Array.isArray(poseData)) return []
  const out: HologramOrbitFrame[] = []
  poseData.forEach((row, index) => {
    const landmarks = row?.landmarks
    if (!landmarks) return
    const keypoints: HologramKeypoints = {}
    for (const [from, to] of Object.entries(JOINTS)) {
      const p = point(landmarks[from])
      if (p) keypoints[to] = p
    }
    const ls = keypoints.left_shoulder
    const rs = keypoints.right_shoulder
    if (ls && rs) {
      keypoints.neck = {
        x: +((ls.x + rs.x) / 2).toFixed(4),
        y: +((ls.y + rs.y) / 2).toFixed(4),
        score: +Math.min(ls.score, rs.score).toFixed(3),
      }
    }
    if (!Object.keys(keypoints).length) return
    const frame = typeof row.frame === 'number' && Number.isFinite(row.frame) ? Math.round(row.frame) : index
    out.push({ frame, keypoints })
  })
  return out
}

function point(p: MpPoint | undefined): HologramKeypoints[string] | null {
  if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') return null
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null
  const score = typeof p.visibility === 'number' ? p.visibility : typeof p.score === 'number' ? p.score : 1
  if (!Number.isFinite(score) || score < 0.3) return null
  return { x: +p.x.toFixed(4), y: +p.y.toFixed(4), score: +score.toFixed(3) }
}

export type HologramOrbit = {
  orbitVideo: string
  orbitDurationMs: number
  orbitFrameCount: number
  orbitWidth: number
  orbitHeight: number
  orbitFrames: HologramOrbitFrame[]
}

/** Square hologram still -> 9:16 black pad, matching the Seedance framing that completed the turn. */
async function padPortrait(png: Buffer): Promise<Buffer> {
  const meta = await sharp(png).metadata()
  const w = meta.width ?? 0
  const h = meta.height ?? 0
  if (!w || !h) throw new Error('Hologram still has no dimensions')
  const targetH = Math.round((w * 16) / 9)
  if (targetH <= h) return png
  const pad = targetH - h
  const top = Math.floor(pad / 2)
  return sharp(png)
    .extend({ top, bottom: pad - top, left: 0, right: 0, background: { r: 0, g: 0, b: 0, alpha: 1 } })
    .png()
    .toBuffer()
}

function openRouterConfig(): { base: string; key: string; model: string } | null {
  const key = process.env.OPENROUTER_API_KEY?.trim()
  if (!key) return null
  const base = (process.env.OPENROUTER_BASE_URL?.trim() || 'https://openrouter.ai/api/v1').replace(/\/+$/, '')
  const model = process.env.OPENROUTER_VIDEO_MODEL?.trim() || 'bytedance/seedance-2.0'
  return { base, key, model }
}

function publicFileUrl(uploadPath: string): string | null {
  const base = (
    process.env.PUBLIC_VIDEO_BASE_URL ||
    process.env.PUBLIC_BASE_URL ||
    process.env.BETTER_AUTH_URL ||
    ''
  ).trim()
  if (!base || /localhost|127\.0\.0\.1/i.test(base)) return null
  return `${base.replace(/\/+$/, '')}${uploadPath.startsWith('/') ? uploadPath : `/${uploadPath}`}`
}

async function openRouterVideo(png: Buffer): Promise<Buffer> {
  const cfg = openRouterConfig()
  if (!cfg) throw new Error('OPENROUTER_API_KEY is not set')
  const dataUrl = `data:image/png;base64,${png.toString('base64')}`
  const headers = {
    Authorization: `Bearer ${cfg.key}`,
    'Content-Type': 'application/json',
    'X-Title': 'Xevo hologram orbit',
  }
  const submit = await fetch(`${cfg.base}/videos`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: cfg.model,
      prompt: ORBIT_PROMPT,
      duration: 4,
      resolution: '480p',
      aspect_ratio: '9:16',
      generate_audio: false,
      seed: Math.floor(Math.random() * 2 ** 31),
      frame_images: [{ type: 'image_url', image_url: { url: dataUrl }, frame_type: 'first_frame' }],
    }),
  })
  if (!submit.ok) throw new Error(`OpenRouter submit failed: ${submit.status} ${await submit.text()}`)
  let status = (await submit.json()) as { id?: string; polling_url?: string; status?: string; error?: string; unsigned_urls?: string[] }
  const jobId = status.id
  if (!jobId) throw new Error('OpenRouter returned no video job')
  const pollUrl = status.polling_url || `${cfg.base}/videos/${jobId}`
  const deadline = Date.now() + 8 * 60_000
  while (status.status === 'pending' || status.status === 'in_progress' || !status.status) {
    if (Date.now() > deadline) throw new Error(`Orbit video timed out (${jobId})`)
    await new Promise((r) => setTimeout(r, 5000))
    const poll = await fetch(pollUrl, { headers })
    if (!poll.ok) throw new Error(`OpenRouter poll failed: ${poll.status}`)
    status = (await poll.json()) as typeof status
  }
  if (status.status !== 'completed') throw new Error(status.error || `Orbit video ${status.status}`)
  const content = status.unsigned_urls?.[0] || `${cfg.base}/videos/${jobId}/content?index=0`
  const video = await fetch(content, { headers })
  if (!video.ok) throw new Error(`OpenRouter download failed: ${video.status}`)
  return Buffer.from(await video.arrayBuffer())
}

async function probeSize(videoPath: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    execFile(
      process.env.FFPROBE_PATH?.trim() || 'ffprobe',
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', videoPath],
      { maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(null)
        try {
          const stream = (JSON.parse(String(stdout)) as { streams?: Array<{ width?: number; height?: number }> }).streams?.[0]
          if (stream?.width && stream?.height) return resolve({ width: stream.width, height: stream.height })
        } catch {
          /* ignore */
        }
        resolve(null)
      }
    )
  })
}

/** Run the orbit clip through the same MediaPipe Modal path as a user video. */
async function poseOrbit(videoUrl: string, analysisId: string): Promise<HologramOrbitFrame[]> {
  const modal = process.env.MODAL_WEBHOOK_URL?.trim()
  if (!modal) return []
  const res = await fetch(modal, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ video_url: videoUrl, analysis_id: `${analysisId}-orbit`, model: 'mediapipe' }),
  })
  const body = (await res.json().catch(() => null)) as { status?: string; metrics?: { pose_data?: unknown } } | null
  if (!res.ok || body?.status !== 'success') {
    console.warn('[Technique][hologram] orbit mediapipe failed', { analysisId, status: body?.status ?? res.status })
    return []
  }
  const pose = body.metrics?.pose_data as Array<{ frame?: number; landmarks?: Record<string, MpPoint> }> | undefined
  return mediapipeFramesToOrbit(pose)
}

/**
 * 4-second Seedance 2.0 orbit of the hologram still, then MediaPipe on that clip
 * so the joint dots can follow the figure while the finger scrubs.
 */
export async function generateHologramOrbit(opts: {
  analysisId: string
  imagePath: string
}): Promise<HologramOrbit> {
  const still = fs.readFileSync(opts.imagePath)
  const padded = await padPortrait(still)
  const video = await openRouterVideo(padded)
  const dir = path.dirname(opts.imagePath)
  const name = `orbit-${Date.now()}.mp4`
  const abs = path.join(dir, name)
  fs.writeFileSync(abs, video)
  await moveIndexToFront(abs)
  const rel = `/uploads/technique-holograms/${opts.analysisId}/${name}`
  const meta = await probeVideoStreamMeta(abs)
  const size = await probeSize(abs)
  const durationMs = Math.round((meta?.durationSec ?? 4) * 1000)
  const frameCount = meta?.nbFrames && meta.nbFrames > 1 ? meta.nbFrames : Math.max(2, Math.round((meta?.fps ?? 24) * (durationMs / 1000)))
  const publicUrl = publicFileUrl(rel)
  const orbitFrames = publicUrl ? await poseOrbit(publicUrl, opts.analysisId).catch((e) => {
    console.warn('[Technique][hologram] orbit pose skipped', e?.message)
    return [] as HologramOrbitFrame[]
  }) : []
  return {
    orbitVideo: rel,
    orbitDurationMs: durationMs,
    orbitFrameCount: frameCount,
    orbitWidth: size?.width ?? 496,
    orbitHeight: size?.height ?? 864,
    orbitFrames,
  }
}

export function isHologramOrbitConfigured(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY?.trim())
}

/** Phones only paint a paused clip when the mp4 index is at the front of the file. */
function moveIndexToFront(abs: string): Promise<void> {
  const bin = process.env.FFMPEG_PATH?.trim() || ffmpegStatic || 'ffmpeg'
  const tmp = `${abs}.fast.mp4`
  return new Promise((resolve) => {
    execFile(bin, ['-y', '-i', abs, '-c', 'copy', '-movflags', '+faststart', tmp], (err) => {
      if (err) {
        console.warn('[Technique][hologram] faststart skipped', err.message)
        fs.rmSync(tmp, { force: true })
        return resolve()
      }
      fs.renameSync(tmp, abs)
      resolve()
    })
  })
}
