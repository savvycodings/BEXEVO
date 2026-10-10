/**
 * E2E fakes mode (`XEVO_E2E_FAKES=1`): replaces the paid or home-PC AI calls (Modal analyzer,
 * LLM, correction images, correction video provider, Resend) with recorded fixtures so local
 * test runs are free and repeatable. Routing, auth, Postgres and file storage stay real.
 * Never allowed in production; see `assertFakesAllowed`.
 */
import fs from 'fs'
import path from 'path'
import express from 'express'

export function fakesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = String(env.XEVO_E2E_FAKES ?? '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes'
}

export function isProductionEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const railway = String(env.RAILWAY_ENVIRONMENT_NAME ?? env.RAILWAY_ENVIRONMENT ?? '').trim().toLowerCase()
  return String(env.NODE_ENV ?? '').trim().toLowerCase() === 'production' || railway === 'production'
}

/** Throws when fakes mode is requested in a production environment. */
export function assertFakesAllowed(env: NodeJS.ProcessEnv = process.env): void {
  if (fakesEnabled(env) && isProductionEnv(env)) {
    throw new Error('XEVO_E2E_FAKES is not allowed in production. Unset it, or run outside production.')
  }
}

/** Neon endpoint id from DATABASE_URL (`ep-…`, without `-pooler`), so tests can refuse production. */
export function dbEndpointId(url = process.env.DATABASE_URL ?? ''): string | null {
  try {
    const host = new URL(url).hostname
    const first = host.split('.')[0] ?? ''
    return first.replace(/-pooler$/, '') || null
  } catch {
    return null
  }
}

// Fixtures live in src/ and aren't copied to dist/, so resolve them from the project root.
const FIXTURE_DIR = [path.join(process.cwd(), 'src', 'e2e', 'fixtures'), path.join(__dirname, 'fixtures')].find((d) =>
  fs.existsSync(d),
) ?? path.join(process.cwd(), 'src', 'e2e', 'fixtures')

export function fixturePath(name: string): string {
  return path.join(FIXTURE_DIR, name)
}

export function readJsonFixture<T = unknown>(name: string): T {
  const p = fixturePath(name)
  if (!fs.existsSync(p)) {
    throw new Error(`E2E fakes: missing fixture ${name}. Run scripts/recordE2eFixtures.ts.`)
  }
  return JSON.parse(fs.readFileSync(p, 'utf8')) as T
}

/** Count of real outbound requests made while fakes were on (should stay 0). */
const outbound: Array<{ at: string; url: string }> = []
let fetchPatched = false

/**
 * In fakes mode, record every global `fetch` to a non-local host so a test can assert the
 * fakes covered every external call. Requests still go through; this only counts them.
 */
export function watchOutboundFetch(): void {
  if (fetchPatched || !fakesEnabled() || typeof globalThis.fetch !== 'function') return
  const original = globalThis.fetch.bind(globalThis)
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    if (!/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/i.test(url)) {
      outbound.push({ at: new Date().toISOString(), url: url.replace(/\?.*$/, '') })
      console.warn('[E2E fakes] real outbound request while fakes are on', { url })
    }
    return original(input, init)
  }) as typeof fetch
  fetchPatched = true
}

export function noteOutbound(url: string): void {
  if (fakesEnabled()) outbound.push({ at: new Date().toISOString(), url })
}

export type OutboxEmail = { at: string; to: string; subject: string; text?: string; html?: string }
const outbox: OutboxEmail[] = []

export function recordEmail(email: Omit<OutboxEmail, 'at'>): void {
  outbox.push({ at: new Date().toISOString(), ...email })
}

/** `/__e2e/*`, mounted only when fakes are on. */
export function e2eRouter(): express.Router {
  const r = express.Router()
  r.get('/health', (_req, res) => {
    res.json({ fakes: fakesEnabled(), dbEndpoint: dbEndpointId(), outboundCalls: outbound.length, outbound })
  })
  r.get('/outbox', (req, res) => {
    const to = String(req.query.to ?? '').trim().toLowerCase()
    res.json({ emails: to ? outbox.filter((e) => e.to.toLowerCase() === to) : outbox })
  })
  r.delete('/outbox', (_req, res) => {
    outbox.length = 0
    res.json({ ok: true })
  })
  r.post('/seed', async (_req, res) => {
    try {
      const { seedE2eAccounts } = await import('./seed')
      res.json({ accounts: await seedE2eAccounts() })
    } catch (e) {
      console.error('[E2E fakes] seed failed', e)
      res.status(500).json({ error: (e as Error).message })
    }
  })
  r.delete('/outbound', (_req, res) => {
    outbound.length = 0
    res.json({ ok: true })
  })
  return r
}

/** Mount `/__e2e` only when fakes are on; returns whether it was mounted. */
export function mountE2eRoutes(app: express.Express, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!fakesEnabled(env)) return false
  console.warn('[E2E fakes] ON: AI providers and email are faked; /__e2e routes are mounted')
  app.use('/__e2e', e2eRouter())
  return true
}

/** Fake correction image (base64 PNG), in place of ComfyUI / Gemini / fal. */
export function fakeCorrectionImageBase64(): string {
  return fs.readFileSync(fixturePath('correction-image.png')).toString('base64')
}

/** Fake correction video (MP4 bytes), in place of ComfyUI / Veo. */
export function fakeCorrectionVideoBuffer(): Buffer {
  return fs.readFileSync(fixturePath('correction-video.mp4'))
}

/** Resend stand-in: `emails.send` records to the outbox and reports success. */
export function fakeResendClient() {
  return {
    emails: {
      async send(opts: { from: string; to: string | string[]; subject: string; html?: string; text?: string }) {
        for (const to of Array.isArray(opts.to) ? opts.to : [opts.to]) {
          recordEmail({ to, subject: opts.subject, text: opts.text, html: opts.html })
        }
        return { data: { id: `e2e-${Date.now()}` }, error: null }
      },
    },
  }
}
