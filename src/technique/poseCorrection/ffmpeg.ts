import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import ffmpegPath from 'ffmpeg-static'

const run = promisify(execFile)
const FFMPEG = (ffmpegPath as unknown as string) || 'ffmpeg'

export async function ffmpeg(args: string[]): Promise<string> {
  try {
    const { stderr } = await run(FFMPEG, ['-hide_banner', '-y', ...args], { maxBuffer: 64 * 1024 * 1024 })
    return stderr
  } catch (e) {
    const err = e as { stderr?: string; message: string }
    const tail = String(err.stderr ?? '').trim().split('\n').slice(-4).join('\n')
    throw new Error(`ffmpeg failed: ${tail || err.message}`)
  }
}

export type Probe = { durationS: number; width: number; height: number; fps: number }

/** Duration, display size (rotation applied) and fps, parsed from `ffmpeg -i`. */
export async function probe(file: string): Promise<Probe> {
  let stderr = ''
  try {
    await run(FFMPEG, ['-hide_banner', '-i', file])
  } catch (e) {
    stderr = String((e as { stderr?: string }).stderr ?? '') // ffmpeg exits 1 with no output file
  }
  const dur = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr)
  const video = /Stream #.*Video: .*?(\d{2,5})x(\d{2,5})/.exec(stderr)
  if (!dur || !video) throw new Error(`Not a readable video: ${path.basename(file)}`)
  const fpsM = /(\d+(?:\.\d+)?) fps/.exec(stderr)
  const rot = /rotation of (-?\d+(?:\.\d+)?) degrees/.exec(stderr)
  let width = Number(video[1])
  let height = Number(video[2])
  if (rot && Math.abs(Math.abs(Number(rot[1])) - 90) < 1) [width, height] = [height, width]
  return {
    durationS: Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]),
    width,
    height,
    fps: fpsM ? Number(fpsM[1]) : 30,
  }
}

export async function extractFrame(file: string, t: number, out: string, size?: { w: number; h: number }): Promise<void> {
  const { durationS } = await probe(file)
  if (!(t >= 0) || t > durationS) throw new RangeError(`Time ${t}s is outside the clip (0–${durationS.toFixed(2)}s).`)
  const seek = Math.min(t, Math.max(0, durationS - 0.05))
  const vf = size ? ['-vf', `scale=${size.w}:${size.h}`] : []
  await ffmpeg(['-ss', seek.toFixed(3), '-i', file, '-frames:v', '1', ...vf, out])
}

/**
 * Frames of `file` at exactly the given times, scaled to w×h, written as 0001.png… in `dir`.
 * Decodes the window once at a high rate and picks the nearest decoded frame for each time.
 */
export async function extractFramesAt(file: string, times: number[], dir: string, w: number, h: number): Promise<string[]> {
  await fs.mkdir(dir, { recursive: true })
  const tmp = path.join(dir, '_all')
  await fs.mkdir(tmp, { recursive: true })
  const start = Math.max(0, times[0]! - 0.05)
  const end = times[times.length - 1]! + 0.05
  const rate = 60
  await ffmpeg(['-ss', start.toFixed(3), '-i', file, '-t', (end - start).toFixed(3), '-vf', `fps=${rate},scale=${w}:${h}`, path.join(tmp, '%05d.png')])
  const decoded = (await fs.readdir(tmp)).filter((f) => f.endsWith('.png')).sort()
  if (!decoded.length) throw new Error('No frames decoded from the clip window.')
  const out: string[] = []
  for (let i = 0; i < times.length; i++) {
    const k = Math.min(decoded.length - 1, Math.max(0, Math.round((times[i]! - start) * rate)))
    const dest = path.join(dir, `${String(i + 1).padStart(4, '0')}.png`)
    await fs.copyFile(path.join(tmp, decoded[k]!), dest)
    out.push(dest)
  }
  await fs.rm(tmp, { recursive: true, force: true })
  return out
}

/** Encode 0001.png… in `dir` to an H.264 MP4 at `fps`. */
export async function encodeFrames(dir: string, fps: number, out: string): Promise<void> {
  await ffmpeg([
    '-framerate', String(fps), '-i', path.join(dir, '%04d.png'),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '17', '-movflags', '+faststart', out,
  ])
}

/** Count frames by decoding (accurate for short clips). */
export async function countFrames(file: string): Promise<number> {
  const stderr = await ffmpeg(['-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'null', '-'])
  const m = [...stderr.matchAll(/frame=\s*(\d+)/g)].pop()
  return m ? Number(m[1]) : 0
}
