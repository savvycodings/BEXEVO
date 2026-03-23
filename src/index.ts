import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { toNodeHandler } from 'better-auth/node'
import { auth } from './auth'
import chatRouter from './chat/chatRouter'
import imagesRouter from './images/imagesRouter'
import techniqueRouter from './technique/techniqueRouter'
import profileRouter from './profile/profileRouter'
import bodyParser from 'body-parser'
import path from 'path'

const app = express()

app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Cache-Control', 'Accept', 'X-Requested-With'],
}))

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
    _res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Cache-Control, Accept, X-Requested-With')
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
app.use('/api/auth/profile', profileRouter)

app.all('/api/auth/*', toNodeHandler(auth))

app.use(bodyParser.urlencoded({ extended: true }))
app.use(bodyParser.json())
app.use(express.json({ limit: '50mb' }))

app.get('/', (req, res) => {
  res.send('Hello World!')
})

app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')))
app.use('/chat', chatRouter)
app.use('/images', imagesRouter)
app.use('/technique', techniqueRouter)
app.use('/profile', profileRouter)

app.listen(3050, () => {
  console.log('Server started on port 3050')
})
