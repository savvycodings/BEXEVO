import { Router, type Response } from 'express'
import multer from 'multer'
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { Readable } from 'stream'

const router = Router()
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 80 * 1024 * 1024 },
})

function drillsS3Configured() {
  return !!(
    process.env.DRILLS_S3_ENDPOINT?.trim() &&
    process.env.DRILLS_S3_BUCKET?.trim() &&
    process.env.DRILLS_S3_ACCESS_KEY_ID?.trim() &&
    process.env.DRILLS_S3_SECRET_ACCESS_KEY?.trim()
  )
}

function getDrillsS3() {
  if (!drillsS3Configured()) {
    throw new Error('Drills S3 is not configured')
  }
  return {
    client: new S3Client({
      endpoint: process.env.DRILLS_S3_ENDPOINT!.trim(),
      region: (process.env.DRILLS_S3_REGION || 'auto').trim(),
      credentials: {
        accessKeyId: process.env.DRILLS_S3_ACCESS_KEY_ID!.trim(),
        secretAccessKey: process.env.DRILLS_S3_SECRET_ACCESS_KEY!.trim(),
      },
      forcePathStyle: true,
    }),
    bucket: process.env.DRILLS_S3_BUCKET!.trim(),
  }
}

/** Normalize to drills/{shot}/{file}.mp4 */
function toObjectKey(shot: string, file: string): string | null {
  const s = shot.trim()
  const f = file.trim()
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(s)) return null
  if (!/^[a-z0-9][a-z0-9._-]*\.mp4$/i.test(f)) return null
  if (s.includes('..') || f.includes('..')) return null
  return `drills/${s}/${f}`
}

function mediaPathToKey(rawPath: string): string | null {
  const cleaned = rawPath
    .replace(/^\/+/, '')
    .replace(/^drills\//i, '')
    .split('/')
    .filter((p) => p && p !== '.' && p !== '..')
  if (cleaned.length !== 2) return null
  return toObjectKey(cleaned[0], cleaned[1])
}

function uploadAuthorized(req: { header: (n: string) => string | undefined }) {
  const expected = process.env.DRILLS_UPLOAD_SECRET?.trim()
  if (!expected) return false
  const got =
    req.header('x-drills-upload-secret')?.trim() ||
    req.header('authorization')?.replace(/^Bearer\s+/i, '').trim()
  return !!got && got === expected
}

function pipeS3Body(body: unknown, res: Response) {
  if (!body) {
    res.status(404).json({ error: 'Empty object' })
    return
  }
  if (typeof (body as any).pipe === 'function') {
    ;(body as Readable).pipe(res)
    return
  }
  if (typeof (body as any).transformToWebStream === 'function') {
    Readable.fromWeb((body as any).transformToWebStream()).pipe(res)
    return
  }
  res.status(500).json({ error: 'Unsupported S3 body type' })
}

async function streamKey(key: string, req: { headers: { range?: string } }, res: Response) {
  const { client, bucket } = getDrillsS3()
  const range = req.headers.range

  let contentLength: number | undefined
  try {
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
    contentLength = head.ContentLength
  } catch (e: any) {
    if (e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404) {
      return res.status(404).json({ error: 'Video not found' })
    }
    throw e
  }

  const fileSize = contentLength ?? 0
  res.setHeader('Content-Type', 'video/mp4')
  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('Cache-Control', 'public, max-age=86400')

  if (range && fileSize > 0) {
    const matches = /bytes=(\d*)-(\d*)/.exec(range)
    const start = matches?.[1] ? parseInt(matches[1], 10) : 0
    const end = matches?.[2] ? parseInt(matches[2], 10) : fileSize - 1
    const safeStart = Number.isFinite(start) ? Math.max(0, start) : 0
    const safeEnd = Number.isFinite(end) ? Math.min(end, fileSize - 1) : fileSize - 1
    if (safeStart > safeEnd || safeStart >= fileSize) {
      res.status(416).setHeader('Content-Range', `bytes */${fileSize}`)
      return res.end()
    }
    const chunkSize = safeEnd - safeStart + 1
    const obj = await client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        Range: `bytes=${safeStart}-${safeEnd}`,
      })
    )
    res.status(206)
    res.setHeader('Content-Range', `bytes ${safeStart}-${safeEnd}/${fileSize}`)
    res.setHeader('Content-Length', chunkSize.toString())
    pipeS3Body(obj.Body, res)
    return
  }

  const obj = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  if (fileSize > 0) res.setHeader('Content-Length', fileSize.toString())
  pipeS3Body(obj.Body, res)
}

router.get('/media/health', (_req, res) => {
  res.json({
    configured: drillsS3Configured(),
    bucket: process.env.DRILLS_S3_BUCKET || null,
  })
})

/**
 * GET /drills/media/:shot/:file
 * Example: /drills/media/bandeja/01-primary.mp4 → drills/bandeja/01-primary.mp4
 */
router.get('/media/:shot/:file', async (req, res) => {
  try {
    if (!drillsS3Configured()) {
      return res.status(503).json({ error: 'Drills media storage not configured' })
    }
    const key = toObjectKey(String(req.params.shot || ''), String(req.params.file || ''))
    if (!key) {
      return res.status(400).json({ error: 'Invalid media path' })
    }
    await streamKey(key, req, res)
  } catch (e: any) {
    console.error('[DrillsMedia] stream error:', e?.message || e)
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Failed to stream drill video' })
    }
  }
})

/**
 * POST /drills/media/upload
 * multipart: key=bandeja/01-primary.mp4, file=<mp4>
 * Auth: x-drills-upload-secret or Authorization: Bearer <DRILLS_UPLOAD_SECRET>
 */
router.post('/media/upload', upload.single('file'), async (req, res) => {
  try {
    if (!uploadAuthorized(req)) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
    if (!drillsS3Configured()) {
      return res.status(503).json({ error: 'Drills media storage not configured' })
    }
    const rawKey = String((req.body as any)?.key || '').trim()
    const key = mediaPathToKey(rawKey)
    if (!key) {
      return res.status(400).json({ error: 'Invalid key (expected shot/file.mp4)' })
    }
    const file = req.file
    if (!file?.buffer?.length) {
      return res.status(400).json({ error: 'Missing file' })
    }

    const { client, bucket } = getDrillsS3()
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: file.buffer,
        ContentType: 'video/mp4',
      })
    )
    return res.json({
      ok: true,
      key,
      bytes: file.buffer.length,
      url: `/drills/media/${key.replace(/^drills\//, '')}`,
    })
  } catch (e: any) {
    console.error('[DrillsMedia] upload error:', e?.message || e)
    return res.status(500).json({ error: 'Failed to upload drill video' })
  }
})

export default router
