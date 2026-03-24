import type { Request, Response } from 'express'
import crypto from 'crypto'

function getAppSecret(): string {
  return (
    process.env.FACEBOOK_APP_SECRET ||
    process.env.FACEBOOK_CLIENT_SECRET ||
    ''
  ).trim()
}

export function handleMetaWebhookVerification(req: Request, res: Response) {
  const mode = req.query['hub.mode']
  const token = req.query['hub.verify_token']
  const challenge = req.query['hub.challenge']
  const expected = process.env.META_WEBHOOK_VERIFY_TOKEN

  if (mode !== 'subscribe' || typeof challenge !== 'string') {
    return res.sendStatus(400)
  }
  if (!expected || token !== expected) {
    return res.sendStatus(403)
  }
  res.status(200).type('text/plain').send(challenge)
}

function timingSafeSigEqual(expected: string, received: string) {
  const a = Buffer.from(expected)
  const b = Buffer.from(received)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

export function handleMetaWebhookEvent(req: Request, res: Response) {
  const appSecret = getAppSecret()
  const rawBody = Buffer.isBuffer(req.body)
    ? req.body
    : Buffer.from(JSON.stringify(req.body ?? {}), 'utf8')
  const signatureHeader = req.headers['x-hub-signature-256']
  if (appSecret && typeof signatureHeader === 'string') {
    const expectedSig =
      'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex')
    const received = signatureHeader.trim().startsWith('sha256=')
      ? signatureHeader.trim()
      : `sha256=${signatureHeader.trim()}`
    if (!timingSafeSigEqual(expectedSig, received)) {
      return res.sendStatus(403)
    }
  } else if (!appSecret) {
    console.warn('[MetaWebhook] FACEBOOK_APP_SECRET or FACEBOOK_CLIENT_SECRET not set; skipping signature check')
  }
  res.sendStatus(200)
}
