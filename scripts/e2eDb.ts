/**
 * Starts the local e2e database and creates its schema from schema.ts: `pnpm db:e2e`.
 * Always uses the URL from .env.e2e, never .env, and refuses non-local databases unless
 * E2E_ALLOW_REMOTE_DB=1 (for a Neon branch).
 */
import fs from 'fs'
import path from 'path'
import { execFileSync, spawnSync } from 'child_process'
import { Client } from 'pg'
import { parse } from 'dotenv'

const root = process.cwd()
const envFile = path.join(root, '.env.e2e')
const env = fs.existsSync(envFile) ? parse(fs.readFileSync(envFile)) : {}
const url = env.DATABASE_URL || 'postgres://xevo:xevo@localhost:5444/xevo_e2e'
const host = new URL(url).hostname
const local = host === 'localhost' || host === '127.0.0.1'

async function waitForDb(ms = 60_000) {
  const t0 = Date.now()
  for (;;) {
    const c = new Client({ connectionString: url })
    try {
      await c.connect()
      await c.query('select 1')
      return c
    } catch (e) {
      await c.end().catch(() => {})
      if (Date.now() - t0 > ms) throw e
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
}

async function main() {
  if (!local && process.env.E2E_ALLOW_REMOTE_DB !== '1') {
    throw new Error(`Refusing non-local e2e database (${host}). Set E2E_ALLOW_REMOTE_DB=1 for a Neon test branch.`)
  }
  if (local) {
    execFileSync('docker', ['compose', '-f', path.join(root, 'e2e', 'docker-compose.yml'), 'up', '-d', '--wait'], { stdio: 'inherit' })
  }
  const c = await waitForDb()
  await c.query('CREATE EXTENSION IF NOT EXISTS vector')
  await c.end()
  // The drizzle/ migration chain doesn't replay on an empty database (train_video is created by
  // both 0005 and 0006), so the throwaway e2e database is built from schema.ts directly.
  const r = spawnSync('pnpm', ['exec', 'drizzle-kit', 'push', '--force'], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url },
  })
  if (r.status !== 0) throw new Error('drizzle-kit push failed')
  console.log(`e2e database ready: ${host}:${new URL(url).port}${new URL(url).pathname}`)
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
