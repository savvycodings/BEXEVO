import sharp from 'sharp'

/**
 * 3×3 contact board for Nano Banana: full body in cell 0, MediaPipe-centered
 * close-ups in the rest. Cell order matches the Smart 3D body-part grid.
 */
export const HOLOGRAM_GRID_CELL = 480
export const HOLOGRAM_GRID_COLS = 3
export const HOLOGRAM_GRID_ROWS = 3
export const HOLOGRAM_GRID_SIZE = HOLOGRAM_GRID_CELL * HOLOGRAM_GRID_COLS

export const HOLOGRAM_PART_IDS = [
  'head',
  'shoulder',
  'elbow',
  'wrist',
  'torso',
  'knee',
  'feet',
  'racket',
] as const

export type HologramPartId = (typeof HOLOGRAM_PART_IDS)[number]

/** Full board slots: index 0 is always the full-body crop. */
export const HOLOGRAM_GRID_SLOTS = ['full', ...HOLOGRAM_PART_IDS] as const
export type HologramGridSlot = (typeof HOLOGRAM_GRID_SLOTS)[number]

type MpLandmark = { x?: number; y?: number; visibility?: number; score?: number }
type Landmarks = Record<string, MpLandmark | undefined>

const VIS_MIN = 0.35

/** How tight the window is vs the full-body square (higher = closer). */
const PART_ZOOM: Record<HologramPartId, number> = {
  head: 2.6,
  shoulder: 2.4,
  elbow: 3,
  wrist: 3,
  torso: 2.1,
  knee: 2.5,
  feet: 2.5,
  racket: 3,
}

function scoreOf(p: MpLandmark | undefined): number {
  if (!p) return 0
  if (typeof p.visibility === 'number') return p.visibility
  if (typeof p.score === 'number') return p.score
  return 0.9
}

function lm(landmarks: Landmarks, name: string): MpLandmark | null {
  const p = landmarks[name] || landmarks[name.toLowerCase()]
  if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') return null
  if (scoreOf(p) < VIS_MIN) return null
  return p
}

function mid(
  a: MpLandmark | null,
  b: MpLandmark | null
): { x: number; y: number } | null {
  if (a && b) return { x: (a.x! + b.x!) / 2, y: (a.y! + b.y!) / 2 }
  if (a) return { x: a.x!, y: a.y! }
  if (b) return { x: b.x!, y: b.y! }
  return null
}

/** Hitting side from wrist visibility, else RIGHT. */
export function inferHologramSide(
  landmarks: Landmarks,
  preferred?: 'LEFT' | 'RIGHT' | null
): 'LEFT' | 'RIGHT' {
  if (preferred === 'LEFT' || preferred === 'RIGHT') return preferred
  const lw = scoreOf(lm(landmarks, 'LEFT_WRIST') ?? undefined)
  const rw = scoreOf(lm(landmarks, 'RIGHT_WRIST') ?? undefined)
  if (lw <= 0 && rw <= 0) return 'RIGHT'
  return lw > rw ? 'LEFT' : 'RIGHT'
}

/** Normalised (0..1) centre in the source frame for a body-part cell. */
export function partCenter(
  landmarks: Landmarks,
  part: HologramPartId,
  side: 'LEFT' | 'RIGHT'
): { x: number; y: number } | null {
  const L = (n: string) => lm(landmarks, n)
  switch (part) {
    case 'head':
      return point(L('NOSE')) ?? mid(L('LEFT_EYE'), L('RIGHT_EYE')) ?? mid(L('LEFT_EAR'), L('RIGHT_EAR'))
    case 'shoulder':
      return mid(L('LEFT_SHOULDER'), L('RIGHT_SHOULDER'))
    case 'elbow':
      return side === 'LEFT' ? point(L('LEFT_ELBOW')) : point(L('RIGHT_ELBOW'))
    case 'wrist':
      return side === 'LEFT' ? point(L('LEFT_WRIST')) : point(L('RIGHT_WRIST'))
    case 'torso': {
      const shoulders = mid(L('LEFT_SHOULDER'), L('RIGHT_SHOULDER'))
      const hips = mid(L('LEFT_HIP'), L('RIGHT_HIP'))
      return mid(
        shoulders ? { x: shoulders.x, y: shoulders.y } : null,
        hips ? { x: hips.x, y: hips.y } : null
      )
    }
    case 'knee':
      return (
        mid(L('LEFT_KNEE'), L('RIGHT_KNEE')) ??
        (side === 'LEFT' ? point(L('LEFT_KNEE')) : point(L('RIGHT_KNEE')))
      )
    case 'feet':
      return (
        mid(L('LEFT_ANKLE'), L('RIGHT_ANKLE')) ??
        mid(L('LEFT_HEEL'), L('RIGHT_HEEL'))
      )
    case 'racket':
      return side === 'LEFT' ? point(L('LEFT_WRIST')) : point(L('RIGHT_WRIST'))
    default:
      return null
  }
}

function point(p: MpLandmark | null): { x: number; y: number } | null {
  return p && typeof p.x === 'number' && typeof p.y === 'number' ? { x: p.x, y: p.y } : null
}

export type FullBodyCropRect = { left: number; top: number; side: number; srcW: number; srcH: number }

async function blackCell(): Promise<Buffer> {
  return sharp({
    create: {
      width: HOLOGRAM_GRID_CELL,
      height: HOLOGRAM_GRID_CELL,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  })
    .png()
    .toBuffer()
}

/**
 * Square window centred on (cx,cy) in the source frame, sized as fullBody.side / zoom.
 * Clamped inside the frame; empty when the window would be tiny.
 */
async function zoomCell(
  source: Buffer,
  srcW: number,
  srcH: number,
  cx: number,
  cy: number,
  fullBodySide: number,
  zoom: number
): Promise<Buffer> {
  const side = Math.max(32, Math.round(fullBodySide / Math.max(1.2, zoom)))
  const maxSide = Math.min(srcW, srcH)
  const sideC = Math.min(side, maxSide)
  const px = cx * srcW
  const py = cy * srcH
  const left = Math.min(Math.max(0, Math.round(px - sideC / 2)), srcW - sideC)
  const top = Math.min(Math.max(0, Math.round(py - sideC / 2)), srcH - sideC)
  return sharp(source)
    .extract({ left, top, width: sideC, height: sideC })
    .resize(HOLOGRAM_GRID_CELL, HOLOGRAM_GRID_CELL)
    .png()
    .toBuffer()
}

export type BuiltHologramGrid = {
  grid: Buffer
  /** Which part cells actually had a MediaPipe centre. */
  filledParts: HologramPartId[]
  side: 'LEFT' | 'RIGHT'
}

/**
 * Compose the Nano Banana input board.
 * `fullBody` is the existing 1024 (or any square) player crop — fitted into cell 0.
 */
export async function buildHologramGrid(opts: {
  sourceFrame: Buffer
  fullBody: Buffer
  landmarks: Landmarks
  fullBodyCrop: FullBodyCropRect
  racketSide?: 'LEFT' | 'RIGHT' | null
}): Promise<BuiltHologramGrid> {
  const meta = await sharp(opts.sourceFrame).metadata()
  const srcW = meta.width ?? opts.fullBodyCrop.srcW
  const srcH = meta.height ?? opts.fullBodyCrop.srcH
  if (!srcW || !srcH) throw new Error('Source frame has no dimensions')

  const side = inferHologramSide(opts.landmarks, opts.racketSide)
  const fullCell = await sharp(opts.fullBody)
    .resize(HOLOGRAM_GRID_CELL, HOLOGRAM_GRID_CELL, { fit: 'cover' })
    .png()
    .toBuffer()

  const cells: Buffer[] = [fullCell]
  const filledParts: HologramPartId[] = []

  for (const part of HOLOGRAM_PART_IDS) {
    const center = partCenter(opts.landmarks, part, side)
    if (!center) {
      cells.push(await blackCell())
      continue
    }
    cells.push(
      await zoomCell(
        opts.sourceFrame,
        srcW,
        srcH,
        center.x,
        center.y,
        opts.fullBodyCrop.side,
        PART_ZOOM[part]
      )
    )
    filledParts.push(part)
  }

  const composites = cells.map((input, i) => ({
    input,
    left: (i % HOLOGRAM_GRID_COLS) * HOLOGRAM_GRID_CELL,
    top: Math.floor(i / HOLOGRAM_GRID_COLS) * HOLOGRAM_GRID_CELL,
  }))

  const grid = await sharp({
    create: {
      width: HOLOGRAM_GRID_SIZE,
      height: HOLOGRAM_GRID_SIZE,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  })
    .composite(composites)
    .png()
    .toBuffer()

  return { grid, filledParts, side }
}

export type SlicedHologramGrid = {
  full: Buffer
  parts: Partial<Record<HologramPartId, Buffer>>
  /** Normalised to the expected board size before slicing. */
  normalizedGrid: Buffer
}

/** Force the model output onto the 1440 board, then cut nine cells. */
export async function sliceHologramGrid(
  edited: Buffer,
  fullOutSize: number
): Promise<SlicedHologramGrid> {
  const normalizedGrid = await sharp(edited)
    .resize(HOLOGRAM_GRID_SIZE, HOLOGRAM_GRID_SIZE, { fit: 'fill' })
    .png()
    .toBuffer()

  const extractCell = async (index: number) => {
    const left = (index % HOLOGRAM_GRID_COLS) * HOLOGRAM_GRID_CELL
    const top = Math.floor(index / HOLOGRAM_GRID_COLS) * HOLOGRAM_GRID_CELL
    return sharp(normalizedGrid)
      .extract({ left, top, width: HOLOGRAM_GRID_CELL, height: HOLOGRAM_GRID_CELL })
      .resize(fullOutSize, fullOutSize, { fit: 'fill' })
      .png()
      .toBuffer()
  }

  const full = await extractCell(0)
  const parts: Partial<Record<HologramPartId, Buffer>> = {}
  for (let i = 0; i < HOLOGRAM_PART_IDS.length; i++) {
    parts[HOLOGRAM_PART_IDS[i]] = await extractCell(i + 1)
  }
  return { full, parts, normalizedGrid }
}

/** Extra instructions so Nano Banana keeps the board layout while applying the hologram look. */
export function hologramGridPromptSuffix(): string {
  return (
    ' The input is a 3x3 contact board. Top-left is the full body; the other eight cells are close-ups ' +
    'of the same player at the same instant (head, shoulders, elbows, wrists, torso, knees, feet, racket), ' +
    'left-to-right, top-to-bottom after the full-body cell. Apply the holographic look to every cell. ' +
    'Keep the exact 3x3 layout, cell order, framing and proportions of each panel. Do not merge cells, ' +
    'swap panels, add labels or change the black gaps between cells.'
  )
}
