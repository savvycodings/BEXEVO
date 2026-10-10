import fs from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

/** OpenPose-18 keypoints taken from MediaPipe indices; index 1 (neck) is the shoulder midpoint. */
const OP_FROM_MP: Array<number | 'neck'> = [0, 'neck', 12, 14, 16, 11, 13, 15, 24, 26, 28, 23, 25, 27, 5, 2, 8, 7]
const LIMBS: Array<[number, number]> = [
  [1, 2], [1, 5], [2, 3], [3, 4], [5, 6], [6, 7], [1, 8], [8, 9], [9, 10],
  [1, 11], [11, 12], [12, 13], [1, 0], [0, 14], [14, 16], [0, 15], [15, 17],
]
const COLORS = [
  [255, 0, 0], [255, 85, 0], [255, 170, 0], [255, 255, 0], [170, 255, 0], [85, 255, 0],
  [0, 255, 0], [0, 255, 85], [0, 255, 170], [0, 255, 255], [0, 170, 255], [0, 85, 255],
  [0, 0, 255], [85, 0, 255], [170, 0, 255], [255, 0, 255], [255, 0, 170], [255, 0, 85],
]
const rgb = (c: number[]) => `rgb(${c[0]},${c[1]},${c[2]})`

/** OpenPose-18 points in pixels from 33 normalized MediaPipe image landmarks. */
export function openPosePoints(image: number[][], w: number, h: number): Array<[number, number]> {
  return OP_FROM_MP.map((src) => {
    if (src === 'neck') {
      return [((image[11]![0]! + image[12]![0]!) / 2) * w, ((image[11]![1]! + image[12]![1]!) / 2) * h]
    }
    return [image[src]![0]! * w, image[src]![1]! * h]
  })
}

export type SkeletonStyle = { background: 'black' | 'none'; color?: string; opacity?: number }

/** SVG of one OpenPose-18 skeleton (standard limb order and colors unless `color` is set). */
export function skeletonSvg(pts: Array<[number, number]>, w: number, h: number, style: SkeletonStyle): string {
  const stroke = Math.max(3, Math.round(h / 160))
  const op = style.opacity ?? 0.6
  const parts: string[] = []
  if (style.background === 'black') parts.push(`<rect width="${w}" height="${h}" fill="black"/>`)
  LIMBS.forEach(([a, b], i) => {
    const [x1, y1] = pts[a]!
    const [x2, y2] = pts[b]!
    parts.push(`<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${style.color ?? rgb(COLORS[i]!)}" stroke-width="${stroke}" stroke-linecap="round" opacity="${op}"/>`)
  })
  pts.forEach(([x, y], i) => {
    parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${stroke}" fill="${style.color ?? rgb(COLORS[i]!)}"/>`)
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${parts.join('')}</svg>`
}

/** Black-background pose frames (what the model is conditioned on): 0001.png… */
export async function renderPoseFrames(frames: number[][][], w: number, h: number, dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
  await Promise.all(frames.map((img, i) =>
    sharp(Buffer.from(skeletonSvg(openPosePoints(img, w, h), w, h, { background: 'black' })))
      .png()
      .toFile(path.join(dir, `${String(i + 1).padStart(4, '0')}.png`)),
  ))
}

/** The corrected skeleton (colors) and the original (white) drawn over the player's frames. */
export async function renderOverlayFrames(
  playerFramePaths: string[],
  original: number[][][],
  corrected: number[][][],
  w: number,
  h: number,
  dir: string,
): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
  await Promise.all(playerFramePaths.map(async (src, i) => {
    const orig = skeletonSvg(openPosePoints(original[i]!, w, h), w, h, { background: 'none', color: 'white', opacity: 0.45 })
    const corr = skeletonSvg(openPosePoints(corrected[i]!, w, h), w, h, { background: 'none', opacity: 0.9 })
    await sharp(src)
      .resize(w, h)
      .composite([{ input: Buffer.from(orig) }, { input: Buffer.from(corr) }])
      .png()
      .toFile(path.join(dir, `${String(i + 1).padStart(4, '0')}.png`))
  }))
}

/** Provider frame size: the short side at the resolution, aspect kept, both sides multiples of 16. */
export function outputSize(srcW: number, srcH: number, resolution: '480p' | '580p' | '720p'): { w: number; h: number } {
  const short = Number(resolution.replace('p', ''))
  const r16 = (x: number) => Math.max(16, Math.round(x / 16) * 16)
  return srcW <= srcH ? { w: r16(short), h: r16((short * srcH) / srcW) } : { w: r16((short * srcW) / srcH), h: r16(short) }
}
