import type { FrameLandmarks } from "./impactPoseContext";

/** Must match train_sample_embedding.embedding dimension (pgvector). */
export const POSE_EMBEDDING_DIM = 128;
export const POSE_EMBEDDING_SPEC_VERSION = "v1";

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

/** Train Modal: pose_sequence rows use frame_idx + landmarks. */
export function embedTrainPoseSequence(
  poseSequence: PoseFrameRow[] | null | undefined
): number[] | null {
  if (!Array.isArray(poseSequence) || poseSequence.length === 0) return null;
  const withLm = poseSequence.filter((r) => r?.landmarks && typeof r.landmarks === "object");
  if (withLm.length === 0) return null;
  const mid = Math.floor(withLm.length / 2);
  const frame = withLm[mid];
  return landmarksToEmbeddingVector(frame.landmarks as FrameLandmarks);
}

/**
 * Pro-library kNN (must match {@link embedTrainPoseSequence}): middle frame of
 * subsampled `pose_data` only. Using impact-frame here breaks matching when the
 * same file exists in train (train embeds middle of clip, not user trim impact).
 */
export function embedPoseForProRetrieval(metrics: {
  pose_data?: Array<{ frame: number; landmarks: FrameLandmarks }>;
}): number[] | null {
  const pd = metrics.pose_data;
  if (!Array.isArray(pd) || pd.length === 0) return null;
  const sorted = [...pd].sort((a, b) => a.frame - b.frame);
  const mid = sorted[Math.floor(sorted.length / 2)];
  if (!mid?.landmarks) return null;
  return landmarksToEmbeddingVector(mid.landmarks);
}

/** Cap pose frames sent to GPT (full `metrics.pose_data` stays for embeddings / impact math). */
export const MAX_POSE_FRAMES_IN_GPT_PROMPT = 72;

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
