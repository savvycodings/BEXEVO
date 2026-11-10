import fs from 'fs'
import path from 'path'
import type { HologramKeypoints, HologramOrbitFrame, HologramPartId, HologramResult } from './hologram'
import type { HologramOrbit } from './hologramOrbit'
import { HOLOGRAM_PART_IDS } from './hologramGrid'

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

export function proOrbitPublicPath(id: string): string {
  return `/pro-library/${renderStem(id)}.mp4`
}

export function proOrbitDiskPath(id: string): string {
  return path.join(proLibraryRoot(), 'renders', `${renderStem(id)}.mp4`)
}

function renderDiskPath(id: string, kind: 'image' | 'frame'): string {
  const name = kind === 'image' ? `${renderStem(id)}.png` : `${renderStem(id)}-frame.png`
  return path.join(proLibraryRoot(), 'renders', name)
}

/** Labeled CoreShots impact still on the volume (`impact/{preset}__{view}.png`). */
export function proImpactStillDiskPath(id: string): string {
  return path.join(proLibraryRoot(), 'impact', `${renderStem(id)}.png`)
}

export function proImpactStillPublicPath(id: string): string {
  return `/pro-library/impact/${renderStem(id)}.png`
}

const IMPACT_EXTS = ['.png', '.PNG', '.jpg', '.JPG', '.jpeg', '.JPEG', '.webp', '.WEBP']

/** Curated impact contact still for this shot and camera, when present on disk. */
export function findProImpactStill(
  strokePreset: string,
  viewId: string
): { id: string; strokePreset: string; viewId: string; imagePath: string } | null {
  const preset = strokePreset.trim()
  const view = viewId.trim()
  if (!preset || !view) return null
  const id = proClipId(preset, view)
  const stemPath = proImpactStillDiskPath(id)
  if (fs.existsSync(stemPath)) {
    return { id, strokePreset: preset, viewId: view, imagePath: stemPath }
  }
  const dir = path.join(proLibraryRoot(), 'impact')
  for (const ext of IMPACT_EXTS) {
    if (ext === '.png') continue
    const alt = path.join(dir, `${renderStem(id)}${ext}`)
    if (fs.existsSync(alt)) return { id, strokePreset: preset, viewId: view, imagePath: alt }
  }
  return null
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

export function proStoredFile(publicPath: string): string | null {
  if (publicPath.startsWith('/pro-library/impact/')) {
    return path.join(proLibraryRoot(), 'impact', path.basename(publicPath))
  }
  if (publicPath.startsWith('/pro-library/')) {
    return path.join(proLibraryRoot(), 'renders', path.basename(publicPath))
  }
  if (publicPath.startsWith('/uploads/')) {
    return path.join(process.cwd(), publicPath.replace(/^\//, ''))
  }
  return null
}

/**
 * Register a CoreShots impact PNG as the shared pro contact still (no Nano Banana).
 * Copies into renders/ so /pro-library/{stem}.png serves it while/after Seedance.
 */
export async function saveSharedProImpactStill(opts: {
  id: string
  strokePreset: string
  viewId: string
  imagePath: string
  videoPath?: string | null
}): Promise<HologramResult> {
  if (!fs.existsSync(opts.imagePath)) throw new Error('Impact still file is missing')
  const dir = path.join(proLibraryRoot(), 'renders')
  fs.mkdirSync(dir, { recursive: true })
  const imageDisk = renderDiskPath(opts.id, 'image')
  const frameDisk = renderDiskPath(opts.id, 'frame')
  fs.copyFileSync(opts.imagePath, imageDisk)
  fs.copyFileSync(opts.imagePath, frameDisk)
  const image = proRenderPublicPath(opts.id)
  const frameImage = `/pro-library/${renderStem(opts.id)}-frame.png`
  const contactFrame = readProContactFrame(opts.id)
  const clip = findProClip(opts.strokePreset, opts.viewId)
  const videoPath = opts.videoPath?.trim() || clip?.videoPath || `impact:${opts.id}`
  const saved: HologramResult = {
    image,
    frameImage,
    contactMs: null,
    frame: contactFrame,
    keypoints: null,
  }
  const { db } = await import('../db')
  const { proHologramRender } = await import('../db/schema')
  const { eq } = await import('drizzle-orm')
  const values = {
    id: opts.id,
    strokePreset: opts.strokePreset,
    viewId: opts.viewId,
    videoPath,
    contactFrame,
    image,
    frameImage,
    keypoints: null,
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

function loadSharedProParts(id: string): Partial<Record<HologramPartId, string>> | null {
  const dir = path.join(proLibraryRoot(), 'renders')
  const stem = renderStem(id)
  const parts: Partial<Record<HologramPartId, string>> = {}
  for (const part of HOLOGRAM_PART_IDS) {
    const disk = path.join(dir, `${stem}-part-${part}.png`)
    if (fs.existsSync(disk)) parts[part] = `/pro-library/${stem}-part-${part}.png`
  }
  return Object.keys(parts).length ? parts : null
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
  const imageDisk = proStoredFile(row.image)
  const frameDisk = proStoredFile(row.frameImage)
  if (!imageDisk || !frameDisk || !fs.existsSync(imageDisk) || !fs.existsSync(frameDisk)) return null
  const orbitDisk = row.orbitVideo ? proStoredFile(row.orbitVideo) : null
  const orbitReady = Boolean(orbitDisk && fs.existsSync(orbitDisk))
  const parts = loadSharedProParts(id)
  return {
    image: row.image,
    frameImage: row.frameImage,
    contactMs: null,
    frame: row.contactFrame,
    keypoints: (row.keypoints as HologramKeypoints | null) ?? null,
    ...(parts ? { parts } : {}),
    ...(orbitReady
      ? {
          orbitVideo: row.orbitVideo,
          orbitDurationMs: row.orbitDurationMs,
          orbitFrameCount: row.orbitFrameCount,
          orbitWidth: row.orbitWidth,
          orbitHeight: row.orbitHeight,
          orbitFrames: Array.isArray(row.orbitFrames) ? (row.orbitFrames as HologramOrbitFrame[]) : null,
        }
      : {}),
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
  const srcImage = proStoredFile(opts.result.image)
  const srcFrame = proStoredFile(opts.result.frameImage)
  if (!srcImage || !srcFrame || !fs.existsSync(srcImage) || !fs.existsSync(srcFrame)) {
    throw new Error('Orange hologram files are missing')
  }
  fs.copyFileSync(srcImage, imageDisk)
  fs.copyFileSync(srcFrame, frameDisk)
  const image = proRenderPublicPath(opts.id)
  const frameImage = `/pro-library/${renderStem(opts.id)}-frame.png`
  const stem = renderStem(opts.id)
  const parts: Partial<Record<HologramPartId, string>> = {}
  for (const part of HOLOGRAM_PART_IDS) {
    const srcPart = opts.result.parts?.[part] ? proStoredFile(opts.result.parts[part]!) : null
    if (!srcPart || !fs.existsSync(srcPart)) continue
    const dest = path.join(dir, `${stem}-part-${part}.png`)
    fs.copyFileSync(srcPart, dest)
    parts[part] = `/pro-library/${stem}-part-${part}.png`
  }
  const saved: HologramResult = {
    ...opts.result,
    image,
    frameImage,
    ...(Object.keys(parts).length ? { parts } : { parts: undefined }),
  }
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

/** Attach the shared Seedance clip. The mp4 is already at the public pro-library path. */
export async function saveSharedProOrbit(id: string, orbit: HologramOrbit): Promise<HologramResult | null> {
  const { db } = await import('../db')
  const { proHologramRender } = await import('../db/schema')
  const { eq } = await import('drizzle-orm')
  await db
    .update(proHologramRender)
    .set({
      orbitVideo: orbit.orbitVideo,
      orbitDurationMs: orbit.orbitDurationMs,
      orbitFrameCount: orbit.orbitFrameCount,
      orbitWidth: orbit.orbitWidth,
      orbitHeight: orbit.orbitHeight,
      orbitFrames: orbit.orbitFrames,
      updatedAt: new Date(),
    })
    .where(eq(proHologramRender.id, id))
  return loadSharedProHologram(id)
}
