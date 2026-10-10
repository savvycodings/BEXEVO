/**
 * Starts BEXevo for e2e runs: `pnpm dev:e2e`. Values from .env.e2e are put in the process
 * environment first, so they win over .env (dotenv never overrides existing variables);
 * that keeps DATABASE_URL on the local test database and fakes mode on.
 */
import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { parse } from 'dotenv'

const file = path.join(process.cwd(), '.env.e2e')
if (!fs.existsSync(file)) {
  console.error('Missing .env.e2e (copy .env.e2e.example), then run `pnpm db:e2e`.')
  process.exit(1)
}
const e2e = parse(fs.readFileSync(file))
const host = new URL(e2e.DATABASE_URL ?? 'invalid://').hostname
if (host !== 'localhost' && host !== '127.0.0.1' && process.env.E2E_ALLOW_REMOTE_DB !== '1') {
  console.error(`Refusing to start: .env.e2e DATABASE_URL is not local (${host}).`)
  process.exit(1)
}
const child = spawn('pnpm', ['dev'], { stdio: 'inherit', env: { ...process.env, ...e2e } })
child.on('exit', (code) => process.exit(code ?? 0))
