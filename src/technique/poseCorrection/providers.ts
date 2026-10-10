import fs from 'fs/promises'
import { fal } from '@fal-ai/client'
import { fakesEnabled } from '../../e2e/fakes'

export type Resolution = '480p' | '580p' | '720p'

export type GenerateInput = {
  poseVideoPath: string
  firstFramePath: string
  prompt: string
  negativePrompt: string
  numFrames: number
  fps: number
  resolution: Resolution
  seed?: number
}

export type GenerateResult = { videoPath: string; requestId?: string }

export interface PoseVideoProvider {
  id: string
  pricePerSecond(res: Resolution): number
  /** Writes the generated MP4 to `outPath`. */
  generate(input: GenerateInput, outPath: string): Promise<GenerateResult>
}

/** Minimal surface of `@fal-ai/client` the provider uses, so tests can swap it. */
export type FalLike = {
  config(opts: { credentials: string }): void
  storage: { upload(file: Blob): Promise<string> }
  subscribe(endpoint: string, opts: { input: Record<string, unknown>; logs?: boolean }): Promise<{ data: unknown; requestId: string }>
}

export function falKey(env: NodeJS.ProcessEnv = process.env): string {
  return String(env.FAL_API_KEY || env.FAL_KEY || '').trim()
}

async function download(url: string, outPath: string): Promise<void> {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`Download of the generated video failed (${r.status}).`)
  await fs.writeFile(outPath, Buffer.from(await r.arrayBuffer()))
}

/** Input for fal's `/pose` endpoints: our skeleton (no preprocessing) + the player's real frame. */
export function falVaceInput(input: GenerateInput, videoUrl: string, imageUrl: string): Record<string, unknown> {
  return {
    prompt: input.prompt,
    negative_prompt: input.negativePrompt,
    video_url: videoUrl,
    preprocess: false,
    first_frame_url: imageUrl,
    ref_image_urls: [imageUrl],
    num_frames: input.numFrames,
    frames_per_second: input.fps,
    resolution: input.resolution,
    aspect_ratio: 'auto',
    ...(input.seed != null ? { seed: input.seed } : {}),
  }
}

/** fal.ai pose-controlled Wan VACE. Prices per output second, verified 2026-10-09 (frames ÷ 16). */
export function falVaceProvider(opts: {
  id: string
  endpoint: string
  prices: Record<Resolution, number>
  client?: FalLike
  downloader?: typeof download
}): PoseVideoProvider {
  const client = opts.client ?? (fal as unknown as FalLike)
  const dl = opts.downloader ?? download
  return {
    id: opts.id,
    pricePerSecond: (res) => opts.prices[res],
    async generate(input, outPath) {
      const key = falKey()
      if (!key) throw new Error('FAL_KEY (or FAL_API_KEY) is required for the pose-correction video.')
      client.config({ credentials: key })
      const blob = async (p: string, type: string) => new Blob([await fs.readFile(p)], { type })
      const [videoUrl, imageUrl] = await Promise.all([
        client.storage.upload(await blob(input.poseVideoPath, 'video/mp4')),
        client.storage.upload(await blob(input.firstFramePath, 'image/png')),
      ])
      const res = await client.subscribe(opts.endpoint, { input: falVaceInput(input, videoUrl, imageUrl), logs: true })
      const url = (res.data as { video?: { url?: string } })?.video?.url
      if (!url) throw new Error('The video provider returned no video.')
      await dl(url, outPath)
      return { videoPath: outPath, requestId: res.requestId }
    },
  }
}

/** Free stand-in (tests, fakes mode): returns the skeleton video itself. */
export function fakePoseVideoProvider(): PoseVideoProvider {
  return {
    id: 'fake',
    pricePerSecond: () => 0,
    async generate(input, outPath) {
      if (process.env.XEVO_E2E_FAKE_VIDEO_FAIL === '1') throw new Error('Fake provider failure (XEVO_E2E_FAKE_VIDEO_FAIL=1).')
      await fs.copyFile(input.poseVideoPath, outPath)
      return { videoPath: outPath }
    },
  }
}

const PROVIDERS: Record<string, () => PoseVideoProvider> = {
  'fal-wan-vace-pose': () =>
    falVaceProvider({ id: 'fal-wan-vace-pose', endpoint: 'fal-ai/wan-vace-14b/pose', prices: { '480p': 0.04, '580p': 0.06, '720p': 0.08 } }),
  'fal-wan22-vace-fun-pose': () =>
    falVaceProvider({ id: 'fal-wan22-vace-fun-pose', endpoint: 'fal-ai/wan-22-vace-fun-a14b/pose', prices: { '480p': 0.05, '580p': 0.075, '720p': 0.1 } }),
  fake: fakePoseVideoProvider,
}

/**
 * Provider for the pose-correction video: fake in e2e fakes mode (unless XEVO_E2E_REAL_VIDEO=1,
 * used by the @live spec to hit the real model with a fixture analysis), else
 * XEVO_POSE_VIDEO_PROVIDER (default fal VACE).
 */
export function resolvePoseVideoProvider(env: NodeJS.ProcessEnv = process.env): PoseVideoProvider {
  if (fakesEnabled(env) && env.XEVO_E2E_REAL_VIDEO !== '1') return fakePoseVideoProvider()
  const id = String(env.XEVO_POSE_VIDEO_PROVIDER ?? '').trim() || 'fal-wan-vace-pose'
  const make = PROVIDERS[id]
  if (!make) throw new Error(`Unknown XEVO_POSE_VIDEO_PROVIDER "${id}". Use one of: ${Object.keys(PROVIDERS).join(', ')}.`)
  return make()
}

export function resolvePoseVideoResolution(env: NodeJS.ProcessEnv = process.env): Resolution {
  const r = String(env.XEVO_POSE_VIDEO_RESOLUTION ?? '').trim()
  return r === '580p' || r === '720p' ? r : '480p'
}

export const POSE_VIDEO_PROMPT = (stroke: string) =>
  `The same padel player, same face, same clothes, on the same court, performing a ${stroke} with a padel racket in hand. Smooth, realistic athletic motion, natural lighting, sharp details, static camera.`

export const POSE_VIDEO_NEGATIVE_PROMPT =
  'extra limbs, extra arms, missing racket, two rackets, racket switching hands, floating racket, deformed hands, distorted face, different person, blurry, ghosting, flicker, camera movement, text, watermark'
