export type Vec3 = [number, number, number]

/** One video frame of MediaPipe output: 33 image landmarks [x, y, z, visibility] (normalized) and 33 world landmarks [x, y, z] (meters, hip-centered). */
export type PoseFrame = {
  t: number
  image: number[][] | null
  world: number[][] | null
}

export type PoseTrack = {
  fps: number
  width: number
  height: number
  frameCount: number
  detectionRate: number
  frames: PoseFrame[]
}

/** A track with every frame filled (gaps interpolated) and smoothed. */
export type DenseFrame = { t: number; image: number[][]; world: Vec3[] }
export type DenseTrack = Omit<PoseTrack, 'frames'> & { frames: DenseFrame[] }

export type Side = 'LEFT' | 'RIGHT'

export type StrokeInfo = {
  racketSide: Side
  /** Frame indices into the dense track. */
  startFrame: number
  contactFrame: number
  endFrame: number
  startT: number
  contactT: number
  endT: number
}

export type Region = 'racketArm' | 'freeArm' | 'trunk' | 'legs'
export const REGIONS: Region[] = ['racketArm', 'freeArm', 'trunk', 'legs']
export type Strengths = Record<Region, number>

export type Phase = 'preparation' | 'contact' | 'followThrough'

export type Correction = {
  region: Region
  phase: Phase
  joint: string
  playerDeg: number
  refDeg: number
  deltaDeg: number
  sentence: string
}
