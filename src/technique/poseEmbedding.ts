import type {
  ClipMsRange,
  FrameLandmarks,
  LabeledPoseFrame,
} from "./impactPoseContext";
import { estimateFps, impactMsToFrameIndex } from "./impactPoseContext";

/** Must match train_sample_embedding.embedding dimension (pgvector). */
export const POSE_EMBEDDING_DIM = 128;
/** v2: impact/clip-end (technique) and last frame (train trim ≈ contact). */
export const POSE_EMBEDDING_SPEC_VERSION = "v2";

/** MediaPipe PoseLandmark enum order (33 landmarks). */
export const MEDIAPIPE_POSE_LANDMARK_NAMES = [
  "NOSE",
  "LEFT_EYE_INNER",
  "LEFT_EYE",
  "LEFT_EYE_OUTER",
  "RIGHT_EYE_INNER",
  "RIGHT_EYE",
  "RIGHT_EYE_OUTER",
  "LEFT_EAR",
  "RIGHT_EAR",
  "MOUTH_LEFT",
  "MOUTH_RIGHT",
  "LEFT_SHOULDER",
  "RIGHT_SHOULDER",
  "LEFT_ELBOW",
  "RIGHT_ELBOW",
  "LEFT_WRIST",
  "RIGHT_WRIST",
  "LEFT_PINKY",
  "RIGHT_PINKY",
  "LEFT_INDEX",
  "RIGHT_INDEX",
  "LEFT_THUMB",
  "RIGHT_THUMB",
  "LEFT_HIP",
  "RIGHT_HIP",
  "LEFT_KNEE",
  "RIGHT_KNEE",
  "LEFT_ANKLE",
  "RIGHT_ANKLE",
  "LEFT_HEEL",
  "RIGHT_HEEL",
  "LEFT_FOOT_INDEX",
  "RIGHT_FOOT_INDEX",
] as const;

function getPt(
  lm: FrameLandmarks,
  name: string
): { x: number; y: number } {
  const p = lm[name];
  if (!p || typeof p.x !== "number" || typeof p.y !== "number") {
    return { x: 0.5, y: 0.5 };
  }
  return { x: p.x, y: p.y };
}

/**
 * Torso-anchored normalization: hip mid origin, scale by shoulder–hip distance.
 * Returns 66 values (33×2), then zero-padded to POSE_EMBEDDING_DIM and L2-normalized.
 */
export function landmarksToEmbeddingVector(lm: FrameLandmarks): number[] {
  const lh = getPt(lm, "LEFT_HIP");
  const rh = getPt(lm, "RIGHT_HIP");
  const ls = getPt(lm, "LEFT_SHOULDER");
  const rs = getPt(lm, "RIGHT_SHOULDER");

  const hipMid = { x: (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2 };
  const shoulderMid = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
  let scale = Math.hypot(shoulderMid.x - hipMid.x, shoulderMid.y - hipMid.y);
  if (!Number.isFinite(scale) || scale < 1e-4) scale = 1e-4;

  const raw: number[] = [];
  for (const name of MEDIAPIPE_POSE_LANDMARK_NAMES) {
    const p = getPt(lm, name);
    raw.push((p.x - hipMid.x) / scale, (p.y - hipMid.y) / scale);
  }

  while (raw.length < POSE_EMBEDDING_DIM) raw.push(0);
  const trimmed = raw.slice(0, POSE_EMBEDDING_DIM);
  return l2Normalize(trimmed);
}

function l2Normalize(v: number[]): number[] {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) + 1e-8;
  return v.map((x) => x / n);
}

type PoseFrameRow = {
  frame_idx?: number;
  frame?: number;
  landmarks?: FrameLandmarks;
};

export type RetrievalEmbeddingInput = {
  pose_data?: Array<{ frame: number; landmarks: FrameLandmarks }>;
  impact_pose_sequence?: LabeledPoseFrame[];
  /** Resolved impact frame index (YOLO/clip); aligns embedding with impact_pose_sequence */
  impact_frame_resolved?: number;
  user_clips?: ClipMsRange[];
  /** Train Modal `pose_sequence` — admin trim ends near contact; use last frame. */
  pose_sequence?: PoseFrameRow[];
  total_frames?: number;
  video_duration_ms?: number;
  mode?: "train" | "technique";
};

function frameIndexOfRow(row: PoseFrameRow): number {
  if (typeof row.frame_idx === "number") return row.frame_idx;
  if (typeof row.frame === "number") return row.frame;
  return 0;
}

/**
 * Single-frame selector shared by technique k-NN query and train index (spec v2).
 */
export function selectLandmarksForRetrievalEmbedding(
  input: RetrievalEmbeddingInput
): FrameLandmarks | null {
  const mode = input.mode ?? (input.pose_sequence?.length ? "train" : "technique");

  if (mode === "train") {
    const seq = input.pose_sequence;
    if (!Array.isArray(seq) || seq.length === 0) return null;
    const withLm = seq.filter((r) => r?.landmarks && typeof r.landmarks === "object");
    if (withLm.length === 0) return null;
    const sorted = [...withLm].sort((a, b) => frameIndexOfRow(a) - frameIndexOfRow(b));
    const last = sorted[sorted.length - 1];
    return (last?.landmarks as FrameLandmarks) ?? null;
  }

  const impactSeq = input.impact_pose_sequence;
  if (impactSeq?.length) {
    const impact =
      impactSeq.find((p) => p.phase === "impact") ?? impactSeq[impactSeq.length - 1];
    if (impact?.landmarks) return impact.landmarks;
  }

  const pd = input.pose_data;
  const tf = input.total_frames;
  if (
    pd?.length &&
    typeof input.impact_frame_resolved === "number" &&
    Number.isFinite(input.impact_frame_resolved)
  ) {
    const target = Math.round(input.impact_frame_resolved);
    const sorted = [...pd].sort((a, b) => a.frame - b.frame);
    let closest = sorted[0]!;
    let bestD = Math.abs(sorted[0]!.frame - target);
    for (const p of sorted) {
      const d = Math.abs(p.frame - target);
      if (d < bestD) {
        bestD = d;
        closest = p;
      }
    }
    if (closest?.landmarks) return closest.landmarks;
  }

  const clips = input.user_clips;
  const vdur = input.video_duration_ms;
  if (clips?.length && pd?.length && vdur && vdur > 0 && tf && tf > 0) {
    const fps = estimateFps(tf, vdur);
    const impactFrame = impactMsToFrameIndex(clips[0]!.endMs, fps);
    const sorted = [...pd].sort((a, b) => a.frame - b.frame);
    let closest = sorted[0]!;
    let bestD = Math.abs(sorted[0]!.frame - impactFrame);
    for (const p of sorted) {
      const d = Math.abs(p.frame - impactFrame);
      if (d < bestD) {
        bestD = d;
        closest = p;
      }
    }
    if (closest?.landmarks) return closest.landmarks;
  }

  if (pd?.length) {
    const sorted = [...pd].sort((a, b) => a.frame - b.frame);
    const mid = sorted[Math.floor(sorted.length / 2)];
    if (mid?.landmarks) return mid.landmarks;
  }
  return null;
}

/** Train Modal: last pose_sequence frame (admin trim ends near ball contact). */
export function embedTrainPoseSequence(
  poseSequence: PoseFrameRow[] | null | undefined
): number[] | null {
  const lm = selectLandmarksForRetrievalEmbedding({
    pose_sequence: poseSequence ?? undefined,
    mode: "train",
  });
  if (!lm) return null;
  return landmarksToEmbeddingVector(lm);
}

/** Technique analyze: impact phase, else clip endMs, else middle of pose_data. */
export function embedPoseForProRetrieval(
  metrics: RetrievalEmbeddingInput
): number[] | null {
  const lm = selectLandmarksForRetrievalEmbedding({
    ...metrics,
    mode: "technique",
  });
  if (!lm) return null;
  return landmarksToEmbeddingVector(lm);
}

/** Cap pose frames sent to GPT (full `metrics.pose_data` stays for embeddings / impact math). */
export const MAX_POSE_FRAMES_IN_GPT_PROMPT = 72;

/**
 * Pose frame cap for technique analyze LLM prompt.
 * Local Unsloth (transformers) struggles with ~140k-char prompts; default 12 frames when provider=xevo.
 */
export function maxPoseFramesForAnalyzePrompt(): number {
  const raw = String(process.env.XEVO_ANALYZE_MAX_POSE_FRAMES ?? "").trim();
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  const provider = String(process.env.XEVO_TEXT_PROVIDER ?? "")
    .trim()
    .toLowerCase();
  if (provider === "xevo") return 12;
  return MAX_POSE_FRAMES_IN_GPT_PROMPT;
}

/** Cap Comfy/Gemini correction images per `/correction-images` request (Railway: `XEVO_CORRECTION_MAX_FRAMES`). */
export function maxCorrectionImageFrames(): number {
  const raw = String(process.env.XEVO_CORRECTION_MAX_FRAMES ?? "").trim();
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return Math.min(Math.floor(n), 20);
  return 5;
}

export function downsamplePoseFramesForPrompt<T extends { frame: number }>(
  poseData: T[] | null | undefined,
  maxFrames: number
): T[] {
  if (!poseData?.length) return [];
  const n = poseData.length;
  if (n <= maxFrames) return poseData;
  if (maxFrames <= 1) return [poseData[Math.min(n - 1, Math.floor(n / 2))]];
  const out: T[] = [];
  for (let i = 0; i < maxFrames; i++) {
    const idx = Math.round((i / (maxFrames - 1)) * (n - 1));
    out.push(poseData[idx]);
  }
  return out;
}

export function formatVectorSqlLiteral(values: number[]): string {
  if (values.length !== POSE_EMBEDDING_DIM) {
    throw new Error(`Expected ${POSE_EMBEDDING_DIM} dims, got ${values.length}`);
  }
  return `[${values.map((x) => (Number.isFinite(x) ? x : 0)).join(",")}]`;
}
