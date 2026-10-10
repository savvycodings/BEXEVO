import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import express from 'express'
import { assertFakesAllowed, dbEndpointId, fakesEnabled, mountE2eRoutes, recordEmail } from './fakes'

test('fakes flag parsing', () => {
  assert.equal(fakesEnabled({}), false)
  assert.equal(fakesEnabled({ XEVO_E2E_FAKES: '1' }), true)
  assert.equal(fakesEnabled({ XEVO_E2E_FAKES: 'true' }), true)
  assert.equal(fakesEnabled({ XEVO_E2E_FAKES: '0' }), false)
})

test('fakes refused in production', () => {
  assert.throws(() => assertFakesAllowed({ XEVO_E2E_FAKES: '1', NODE_ENV: 'production' }), /not allowed in production/)
  assert.throws(() => assertFakesAllowed({ XEVO_E2E_FAKES: '1', RAILWAY_ENVIRONMENT_NAME: 'production' }), /not allowed in production/)
  assert.doesNotThrow(() => assertFakesAllowed({ XEVO_E2E_FAKES: '1', NODE_ENV: 'development' }))
  assert.doesNotThrow(() => assertFakesAllowed({ NODE_ENV: 'production' }))
})

test('db endpoint id from a Neon URL', () => {
  assert.equal(dbEndpointId('postgresql://u:p@ep-cool-river-123-pooler.c-2.us-east-1.aws.neon.tech/db?sslmode=require'), 'ep-cool-river-123')
  assert.equal(dbEndpointId('not a url'), null)
})

async function get(app: express.Express, path: string): Promise<{ status: number; body: any }> {
  const server = http.createServer(app).listen(0)
  const port = (server.address() as { port: number }).port
  try {
    const r = await fetch(`http://localhost:${port}${path}`)
    const json = (r.headers.get('content-type') ?? '').includes('application/json')
    return { status: r.status, body: json ? await r.json() : await r.text() }
  } finally {
    server.close()
  }
}

test('/__e2e routes exist only with fakes on', async () => {
  const off = express()
  assert.equal(mountE2eRoutes(off, {}), false)
  assert.equal((await get(off, '/__e2e/health')).status, 404)

  const on = express()
  assert.equal(mountE2eRoutes(on, { XEVO_E2E_FAKES: '1' }), true)
  recordEmail({ to: 'a@xevo.test', subject: 'code', text: '123456' })
  const outbox = await get(on, '/__e2e/outbox?to=a@xevo.test')
  assert.equal(outbox.status, 200)
  assert.equal(outbox.body.emails[0].text, '123456')
})
