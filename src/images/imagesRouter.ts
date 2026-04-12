import express from 'express'
import multer from 'multer'
import { geminiImage } from './gemini'
import { falFluxLora, falFluxLoraFastTraining } from './fal'

const upload = multer()
const router = express.Router()

router.post('/gemini', upload.single('file'), geminiImage)
router.post('/fal/flux-lora', express.json({ limit: '2mb' }), falFluxLora)
router.post(
  '/fal/flux-lora-fast-training',
  express.json({ limit: '2mb' }),
  falFluxLoraFastTraining
)

export default router
