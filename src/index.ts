import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { toNodeHandler } from 'better-auth/node'
import { auth } from './auth'
import chatRouter from './chat/chatRouter'
import imagesRouter from './images/imagesRouter'
import techniqueRouter from './technique/techniqueRouter'
import trainRouter from './train/trainRouter'
import profileRouter from './profile/profileRouter'
import coachRouter from './coach/coachRouter'
import signupVerificationRouter from './auth/signupVerificationRouter'
import { getFromAddress, isEmailConfigured } from './lib/email/resendClient'
import bodyParser from 'body-parser'
import path from 'path'
import {
  handleMetaWebhookEvent,
  handleMetaWebhookVerification,
} from './webhooks/metaFacebookWebhook'
import { getPrivacyPolicyHtml } from './privacyPolicyHtml'
import { getDataDeletionHtml } from './dataDeletionHtml'
import { warnIfXevoModelMismatch } from './lib/xevoLlm'

const app = express()

app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'Cache-Control',
    'Accept',
    'X-Requested-With',
    'X-Admin-Train-Secret',
    'X-Xevo-Admin-Hub-Password',
    'ngrok-skip-browser-warning',
  ],
}))

app.use(express.json())
app.use(express.urlencoded({ extended: true }))

function maskEmail(email: string): string {
  const at = email.indexOf('@')
  if (at <= 1) return '***'
  return `${email.slice(0, 2)}***${email.slice(at)}`
}

function signupRequestLogger(req: express.Request, res: express.Response, next: express.NextFunction) {
  const startedAt = Date.now()
  const email = typeof req.body?.email === 'string' ? maskEmail(req.body.email) : undefined
  console.log('[SignupVerification][HTTP]', {
    method: req.method,
    url: req.originalUrl,
    email,
    hasBody: req.body != null && typeof req.body === 'object',
  })
  res.on('finish', () => {
    console.log('[SignupVerification][HTTP][DONE]', {
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
      email,
    })
  })
  next()
}

app.use('/api/auth', (req, _res, next) => {
  const startedAt = Date.now()
  const origin = req.headers.origin
  const hasCookie = typeof req.headers.cookie === 'string' && req.headers.cookie.length > 0
  const hasBearerAuth =
    typeof req.headers.authorization === 'string' &&
    req.headers.authorization.toLowerCase().startsWith('bearer ')
  if (origin === 'http://localhost:8081' || origin === 'http://127.0.0.1:8081') {
    _res.header('Access-Control-Allow-Origin', origin)
    _res.header('Access-Control-Allow-Credentials', 'true')
    _res.header(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, Cache-Control, Accept, X-Requested-With, X-Admin-Train-Secret, X-Xevo-Admin-Hub-Password, ngrok-skip-browser-warning',
    )
    _res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,PATCH,OPTIONS')
    _res.header('Vary', 'Origin')
  }
  if (req.method === 'OPTIONS') {
    return _res.sendStatus(204)
  }
  console.log('[BetterAuth][HTTP]', {
    method: req.method,
    url: req.originalUrl,
    origin: req.headers.origin,
    userAgent: req.headers['user-agent'],
    hasCookie,
    hasBearerAuth,
  })
  _res.on('finish', () => {
    console.log('[BetterAuth][HTTP][DONE]', {
      method: req.method,
      url: req.originalUrl,
      status: _res.statusCode,
      durationMs: Date.now() - startedAt,
      hasCookie,
      hasBearerAuth,
    })
  })
  next()
})

app.use('/api/auth/technique', techniqueRouter)
app.use('/api/auth/train', trainRouter)
app.use('/api/auth/profile', profileRouter)
app.use('/api/auth/coach', coachRouter)
app.use('/api/auth/signup', signupRequestLogger, signupVerificationRouter)

app.all('/api/auth/*', toNodeHandler(auth))

app.get('/api/webhooks/facebook', handleMetaWebhookVerification)
app.post(
  '/api/webhooks/facebook',
  express.raw({ type: 'application/json' }),
  handleMetaWebhookEvent
)

app.use(bodyParser.urlencoded({ extended: true }))
app.use(bodyParser.json())
app.use(express.json({ limit: '50mb' }))

app.get('/', (req, res) => {
  res.send('Hello World!')
})

function sendPrivacyPolicy(res: express.Response) {
  res
    .status(200)
    .setHeader('Content-Type', 'text/html; charset=utf-8')
    .setHeader('Cache-Control', 'public, max-age=3600')
    .send(getPrivacyPolicyHtml())
}

app.get('/privacy', (_req, res) => sendPrivacyPolicy(res))
app.get('/privacy-policy', (_req, res) => sendPrivacyPolicy(res))

function sendDataDeletion(res: express.Response) {
  res
    .status(200)
    .setHeader('Content-Type', 'text/html; charset=utf-8')
    .setHeader('Cache-Control', 'public, max-age=3600')
    .send(getDataDeletionHtml())
}

app.get('/data-deletion', (_req, res) => sendDataDeletion(res))
app.get('/user-data-deletion', (_req, res) => sendDataDeletion(res))

app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')))
app.use('/chat', chatRouter)
app.use('/images', imagesRouter)
app.use('/technique', techniqueRouter)
app.use('/train', trainRouter)
app.use('/profile', profileRouter)
app.use('/coach', coachRouter)
app.use('/signup', signupRequestLogger, signupVerificationRouter)

app.listen(3050, '0.0.0.0', () => {
  console.log('Server started on port 3050 (0.0.0.0)')
  console.log('[Email] Resend configured', {
    ready: isEmailConfigured(),
    from: getFromAddress(),
    hasApiKey: !!process.env.RESEND_API_KEY?.trim(),
  })
  console.log('[SignupVerification] Routes ready at /signup/* and /api/auth/signup/*')
  if (String(process.env.XEVO_TEXT_PROVIDER ?? '').trim().toLowerCase() === 'xevo') {
    void warnIfXevoModelMismatch()
  }
})
