import fs from 'fs'
import type { Request, Response } from 'express'
import { findProClip } from './proShotLibrary'

/**
 * Stream the filmed pro-library clip (not the orange hologram render).
 * Save & Track / Compare play this raw video; Smart 3D still uses `/pro-library/*.mp4` renders.
 */
export function streamProLibrarySource(req: Request, res: Response): void {
  const preset = String(req.params.preset || '').trim()
  const view = String(req.params.view || '').trim()
  if (!preset || !view || preset.includes('..') || view.includes('..') || preset.includes('/') || view.includes('/')) {
    res.status(400).json({ error: 'Invalid preset or view' })
    return
  }

  const clip = findProClip(preset, view)
  if (!clip || !fs.existsSync(clip.videoPath)) {
    res.status(404).json({ error: 'Pro source video not found' })
    return
  }

  const ext = clip.videoPath.toLowerCase()
  let mime = 'application/octet-stream'
  if (ext.endsWith('.mp4')) mime = 'video/mp4'
  else if (ext.endsWith('.mov') || ext.endsWith('.qt')) mime = 'video/quicktime'

  void fs.promises
    .stat(clip.videoPath)
    .then((stat) => {
      const fileSize = stat.size
      res.setHeader('Content-Type', mime)
      res.setHeader('Accept-Ranges', 'bytes')
      res.setHeader('Cache-Control', 'public, max-age=3600')
      res.setHeader('Content-Length', String(fileSize))

      if (req.method === 'HEAD') {
        res.status(200).end()
        return
      }

      const range = req.headers.range
      if (range) {
        const matches = /bytes=(\d*)-(\d*)/.exec(range)
        const start = matches?.[1] ? parseInt(matches[1], 10) : 0
        const end = matches?.[2] ? parseInt(matches[2], 10) : fileSize - 1
        const safeStart = Number.isFinite(start) ? Math.max(0, start) : 0
        const safeEnd = Number.isFinite(end) ? Math.min(end, fileSize - 1) : fileSize - 1
        if (safeStart > safeEnd || safeStart >= fileSize) {
          res.status(416).setHeader('Content-Range', `bytes */${fileSize}`)
          res.end()
          return
        }
        const chunkSize = safeEnd - safeStart + 1
        res.status(206)
        res.setHeader('Content-Range', `bytes ${safeStart}-${safeEnd}/${fileSize}`)
        res.setHeader('Content-Length', String(chunkSize))
        fs.createReadStream(clip.videoPath, { start: safeStart, end: safeEnd }).pipe(res)
        return
      }

      fs.createReadStream(clip.videoPath).pipe(res)
    })
    .catch((e) => {
      console.error('[ProLibrary] source stream failed', e)
      if (!res.headersSent) res.status(500).json({ error: 'Failed to stream pro source video' })
    })
}
