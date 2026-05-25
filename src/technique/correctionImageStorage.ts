import fs from 'fs'
import path from 'path'
import type { CorrectionResult } from './correctionPrompt'

const CORRECTION_UPLOAD_ROOT = path.join(
  process.cwd(),
  'uploads',
  'technique-corrections'
)

function correctionDir(analysisId: string): string {
  return path.join(CORRECTION_UPLOAD_ROOT, analysisId)
}

/** Persist data-URI correction frames to disk; return public `/uploads/…` paths. */
export function persistCorrectionImageUri(
  analysisId: string,
  frame: number,
  kind: 'original' | 'corrected',
  uri: string
): string {
  const trimmed = String(uri ?? '').trim()
  if (!trimmed) return trimmed
  if (trimmed.startsWith('/uploads/')) return trimmed
  if (/^https?:\/\//i.test(trimmed)) return trimmed

  const match = trimmed.match(/^data:image\/([a-z0-9.+-]+);base64,(.+)$/i)
  if (!match) return trimmed

  const sub = match[1].toLowerCase()
  const ext = sub === 'jpeg' ? 'jpg' : sub === 'png' ? 'png' : sub
  const dir = correctionDir(analysisId)
  fs.mkdirSync(dir, { recursive: true })
  const fileName = `${frame}-${kind}.${ext}`
  const fullPath = path.join(dir, fileName)
  if (!fs.existsSync(fullPath)) {
    fs.writeFileSync(fullPath, Buffer.from(match[2], 'base64'))
  }
  return `/uploads/technique-corrections/${analysisId}/${fileName}`
}

export function normalizeCorrectionResultForClient(
  analysisId: string,
  row: CorrectionResult
): CorrectionResult {
  return {
    frame: row.frame,
    originalImage: persistCorrectionImageUri(
      analysisId,
      row.frame,
      'original',
      row.originalImage
    ),
    correctedImage: persistCorrectionImageUri(
      analysisId,
      row.frame,
      'corrected',
      row.correctedImage
    ),
  }
}

export function normalizeCorrectionsForClient(
  analysisId: string,
  rows: CorrectionResult[]
): CorrectionResult[] {
  return rows.map((r) => normalizeCorrectionResultForClient(analysisId, r))
}
