import fs from 'fs'
import path from 'path'
import type { HologramKeypoints, HologramResult } from './hologram'

/** Camera ids the shot picker sends. `behind` is the sheet's back camera. */
export const PRO_LIBRARY_VIEWS = [
  'front',
  'behind',
  'side',
  'deg45_right_side_left_camera',
  'deg45_right_side_right_camera',
  'deg45_left_side_right_camera',
  'deg45_left_side_left_camera',
] as const

const VIDEO_EXTS = ['.mp4', '.mov', '.MP4', '.MOV']

export type ProLibraryClip = {
  id: string
  strokePreset: string
  viewId: string
  videoPath: string
}

/** Railway volume when it is mounted, otherwise the local uploads copy. */
export function proLibraryRoot(): string {
  const env = process.env.PRO_LIBRARY_ROOT?.trim()
  if (env) return env
  const railway = '/data/pro-library'
  if (fs.existsSync(railway)) return railway
  return path.join(process.cwd(), 'uploads', 'pro-library')
}

export function proClipId(strokePreset: string, viewId: string): string {
  return `${strokePreset}:${viewId}`
}

function renderStem(id: string): string {
  return id.replace(/:/g, '__')
}

export function proRenderPublicPath(id: string): string {
  return `/pro-library/${renderStem(id)}.png`
}

function renderDiskPath(id: string, kind: 'image' | 'frame'): string {
  const name = kind === 'image' ? `${renderStem(id)}.png` : `${renderStem(id)}-frame.png`
  return path.join(proLibraryRoot(), 'renders', name)
}

/** The curated clip for this shot and camera, when the file is on disk. */
export function findProClip(strokePreset: string, viewId: string): ProLibraryClip | null {
  const preset = strokePreset.trim()
  const view = viewId.trim()
  if (!preset || !view) return null
  const dir = path.join(proLibraryRoot(), preset)
  for (const ext of VIDEO_EXTS) {
    const videoPath = path.join(dir, `${view}${ext}`)
    if (fs.existsSync(videoPath)) {
      return { id: proClipId(preset, view), strokePreset: preset, viewId: view, videoPath }
    }
  }
  return null
}

function readContactMap(file: string): Record<string, number> {
  if (!fs.existsSync(file)) return {}
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    const out: Record<string, number> = {}
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) out[key] = Math.round(value)
    }
    return out
  } catch {
    return {}
  }
}

/**
 * Pro contact frame: ball-and-racket median, same rule as train_modal_app.
 * The volume file wins; the copy shipped with the server is the fallback.
 */
export function readProContactFrame(id: string): number | null {
  const maps = [
    readContactMap(path.join(proLibraryRoot(), 'contacts.json')),
    readContactMap(path.join(__dirname, 'proLibraryContacts.json')),
  ]
  for (const map of maps) {
    const frame = map[id]
    if (frame != null) return frame
  }
  return null
}

function publicFileOnDisk(publicPath: string): string | null {
  if (publicPath.startsWith('/pro-library/')) {
    return path.join(proLibraryRoot(), 'renders', path.basename(publicPath))
  }
  if (publicPath.startsWith('/uploads/')) {
    return path.join(process.cwd(), publicPath.replace(/^\//, ''))
  }
  return null
}

/** Stored orange still. Missing file means it has to be rendered again. */
export async function loadSharedProHologram(id: string): Promise<HologramResult | null> {
  const { db } = await import('../db')
  const { proHologramRender } = await import('../db/schema')
  const { eq } = await import('drizzle-orm')
  const row = (
    await db.select().from(proHologramRender).where(eq(proHologramRender.id, id)).limit(1)
  )[0]
  if (!row?.image || !row.frameImage) return null
  const imageDisk = publicFileOnDisk(row.image)
  const frameDisk = publicFileOnDisk(row.frameImage)
  if (!imageDisk || !frameDisk || !fs.existsSync(imageDisk) || !fs.existsSync(frameDisk)) return null
  return {
    image: row.image,
    frameImage: row.frameImage,
    contactMs: null,
    frame: row.contactFrame,
    keypoints: (row.keypoints as HologramKeypoints | null) ?? null,
  }
}

/** Keep the orange still so the next player with this shot does not call Nano Banana. */
export async function saveSharedProHologram(opts: {
  id: string
  strokePreset: string
  viewId: string
  videoPath: string
  result: HologramResult
}): Promise<HologramResult> {
  const dir = path.join(proLibraryRoot(), 'renders')
  fs.mkdirSync(dir, { recursive: true })
  const imageDisk = renderDiskPath(opts.id, 'image')
  const frameDisk = renderDiskPath(opts.id, 'frame')
  const srcImage = publicFileOnDisk(opts.result.image)
  const srcFrame = publicFileOnDisk(opts.result.frameImage)
  if (!srcImage || !srcFrame || !fs.existsSync(srcImage) || !fs.existsSync(srcFrame)) {
    throw new Error('Orange hologram files are missing')
  }
  fs.copyFileSync(srcImage, imageDisk)
  fs.copyFileSync(srcFrame, frameDisk)
  const image = proRenderPublicPath(opts.id)
  const frameImage = `/pro-library/${renderStem(opts.id)}-frame.png`
  const saved: HologramResult = { ...opts.result, image, frameImage }
  const { db } = await import('../db')
  const { proHologramRender } = await import('../db/schema')
  const { eq } = await import('drizzle-orm')
  const values = {
    id: opts.id,
    strokePreset: opts.strokePreset,
    viewId: opts.viewId,
    videoPath: opts.videoPath,
    contactFrame: opts.result.frame,
    image,
    frameImage,
    keypoints: opts.result.keypoints,
    updatedAt: new Date(),
  }
  const existing = await db
    .select({ id: proHologramRender.id })
    .from(proHologramRender)
    .where(eq(proHologramRender.id, opts.id))
    .limit(1)
  if (existing[0]) await db.update(proHologramRender).set(values).where(eq(proHologramRender.id, opts.id))
  else await db.insert(proHologramRender).values(values)
  return saved
}
