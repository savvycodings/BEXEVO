/**
 * SAM / mesh 128-dim vectors (spec sam_v1) from Modal pose_enrichment or train extraction_meta.
 */

import type { FrameLandmarks } from "./impactPoseContext";
import { POSE_EMBEDDING_DIM } from "./poseEmbedding";

export const MESH_EMBEDDING_SPEC_VERSION = "sam_v1";
/** Reject garbage mesh vectors; not the same as planning-doc MediaPipe 0.7 gate. */
export const MESH_CONFIDENCE_MIN = 0.4;
/** Version tag written into retrieval eval snapshots when blend is used. */
export const BLEND_FORMULA_ID = "v1";

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/** Mesh share of blended query vector (remainder = MediaPipe). Default 0.4 = 40% mesh / 60% MP. */
export function retrievalBlendMeshWeight(): number {
  const raw = (process.env.RETRIEVAL_BLEND_MESH_WEIGHT ?? "0.4").trim();
  const n = Number(raw);
  return clamp01(Number.isFinite(n) ? n : 0.4);
}

const KEY_JOINTS = [
  "LEFT_SHOULDER",
  "RIGHT_SHOULDER",
  "LEFT_ELBOW",
  "RIGHT_ELBOW",
  "LEFT_WRIST",
  "RIGHT_WRIST",
  "LEFT_HIP",
  "RIGHT_HIP",
  "LEFT_KNEE",
  "RIGHT_KNEE",
] as const;

export type PoseEnrichmentFrame = {
  frame?: number;
  mesh_confidence?: number;
  feature_vector?: number[];
  landmarks_3d?: Record<string, { x?: number; y?: number; z?: number }>;
};

export type PoseEnrichment = {
  provider?: string;
  spec_version?: string;
  trigger?: string;
  sam_model_loaded?: boolean;
  frames?: PoseEnrichmentFrame[];
  latency_ms?: number;
};

export type EmbeddingSource = "mediapipe_v2" | "sam_v1" | "blended";

type LandmarkPt = { x?: number; y?: number; z?: number; visibility?: number };

function pt(
  lm: FrameLandmarks | Record<string, LandmarkPt>,
  name: string
): { x: number; y: number; z: number; visibility?: number } {
  const p = lm[name] as LandmarkPt | undefined;
  if (!p || typeof p.x !== "number" || typeof p.y !== "number") {
    return { x: 0.5, y: 0.5, z: 0 };
  }
  return {
    x: p.x,
    y: p.y,
    z: typeof p.z === "number" ? p.z : 0,
    visibility: typeof p.visibility === "number" ? p.visibility : undefined,
  };
}

function l2Normalize(v: number[]): number[] {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) + 1e-8;
  return v.map((x) => x / n);
}

function angleCosine(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
  c: { x: number; y: number; z: number }
): number {
  const v1 = { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
  const v2 = { x: c.x - b.x, y: c.y - b.y, z: c.z - b.z };
  const n1 = Math.hypot(v1.x, v1.y, v1.z) + 1e-8;
  const n2 = Math.hypot(v2.x, v2.y, v2.z) + 1e-8;
  const dot = (v1.x * v2.x + v1.y * v2.y + v1.z * v2.z) / (n1 * n2);
  return Math.max(-1, Math.min(1, dot));
}

/** Server-side mesh proxy — must stay aligned with sam_mesh.py mesh_proxy_feature_vector. */
export function meshProxyFeatureVector(lm: FrameLandmarks): number[] {
  const lh = pt(lm, "LEFT_HIP");
  const rh = pt(lm, "RIGHT_HIP");
  const ls = pt(lm, "LEFT_SHOULDER");
  const rs = pt(lm, "RIGHT_SHOULDER");
  const hipMid = { x: (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2, z: (lh.z + rh.z) / 2 };
  const shoulderMid = {
    x: (ls.x + rs.x) / 2,
    y: (ls.y + rs.y) / 2,
    z: (ls.z + rs.z) / 2,
  };
  let scale = Math.hypot(shoulderMid.x - hipMid.x, shoulderMid.y - hipMid.y);
  if (!Number.isFinite(scale) || scale < 1e-4) scale = 1e-4;

  const raw: number[] = [];
  for (const name of KEY_JOINTS) {
    const p = pt(lm, name);
    raw.push((p.x - hipMid.x) / scale, (p.y - hipMid.y) / scale, p.z / scale);
  }

  for (const side of ["RIGHT", "LEFT"] as const) {
    const sh = pt(lm, `${side}_SHOULDER`);
    const el = pt(lm, `${side}_ELBOW`);
    const wr = pt(lm, `${side}_WRIST`);
    raw.push(angleCosine(sh, el, wr));
  }

  raw.push((shoulderMid.z - hipMid.z) / scale);
  for (const side of ["RIGHT", "LEFT"] as const) {
    const wr = pt(lm, `${side}_WRIST`);
    raw.push((wr.y - hipMid.y) / scale);
  }

  while (raw.length < POSE_EMBEDDING_DIM) raw.push(0);
  return l2Normalize(raw.slice(0, POSE_EMBEDDING_DIM));
}

export function parsePoseEnrichment(metrics: Record<string, unknown> | null | undefined): PoseEnrichment | null {
  const pe = metrics?.pose_enrichment;
  if (!pe || typeof pe !== "object") return null;
  return pe as PoseEnrichment;
}

export function pickImpactEnrichmentFrame(
  enrichment: PoseEnrichment | null,
  impactFrameResolved?: number
): PoseEnrichmentFrame | null {
  const frames = enrichment?.frames;
  if (!Array.isArray(frames) || frames.length === 0) return null;
  if (typeof impactFrameResolved === "number" && Number.isFinite(impactFrameResolved)) {
    let best = frames[0]!;
    let bestD = Math.abs((best.frame ?? 0) - impactFrameResolved);
    for (const f of frames) {
      const d = Math.abs((f.frame ?? 0) - impactFrameResolved);
      if (d < bestD) {
        bestD = d;
        best = f;
      }
    }
    return best;
  }
  return frames[Math.floor(frames.length / 2)] ?? frames[0] ?? null;
}

export function meshVectorFromEnrichmentFrame(frame: PoseEnrichmentFrame | null): number[] | null {
  if (!frame) return null;
  const vec = frame.feature_vector;
  if (Array.isArray(vec) && vec.length >= POSE_EMBEDDING_DIM) {
    return l2Normalize(vec.slice(0, POSE_EMBEDDING_DIM));
  }
  return null;
}

/** weightA = share of vector `a` (typically MediaPipe); `b` gets the remainder. */
export function blendEmbeddings(a: number[], b: number[], weightA = 0.4): number[] {
  const w = clamp01(weightA);
  const out = a.map((x, i) => w * x + (1 - w) * (b[i] ?? 0));
  return l2Normalize(out);
}

/** Blend stored v2 + sam_v1 vectors; meshWeight is mesh share (0 = v2 only, 1 = sam only). */
export function blendStoredTrainVectors(
  mediapipeVector: number[],
  meshVector: number[],
  meshWeight: number
): number[] {
  const mw = clamp01(meshWeight);
  if (mw <= 0) return l2Normalize(mediapipeVector);
  if (mw >= 1) return l2Normalize(meshVector);
  return blendEmbeddings(mediapipeVector, meshVector, 1 - mw);
}

export function meshUsedFromMetrics(metrics: Record<string, unknown> | null | undefined): boolean {
  const pe = parsePoseEnrichment(metrics);
  return Array.isArray(pe?.frames) && pe.frames.length > 0;
}

export function meshConfidenceFromMetrics(
  metrics: Record<string, unknown> | null | undefined,
  impactFrameResolved?: number
): number | null {
  const pe = parsePoseEnrichment(metrics);
  const frame = pickImpactEnrichmentFrame(pe, impactFrameResolved);
  const c = frame?.mesh_confidence;
  return typeof c === "number" && Number.isFinite(c) ? c : null;
}

export type ResolvedRetrievalEmbedding = {
  vector: number[];
  embedding_source: EmbeddingSource;
  query_spec_version: string;
  mesh_used: boolean;
  mesh_confidence: number | null;
};

export type RetrievalEmbeddingMode = "blended" | "sam_v1" | "mediapipe_v2";

function retrievalEmbeddingMode(): RetrievalEmbeddingMode {
  const raw = (process.env.RETRIEVAL_EMBEDDING_MODE ?? "blended").trim().toLowerCase();
  if (raw === "sam_v1" || raw === "sam" || raw === "mesh") return "sam_v1";
  if (raw === "mediapipe_v2" || raw === "v2" || raw === "mediapipe") return "mediapipe_v2";
  return "blended";
}

export type ResolveRetrievalEmbeddingOpts = {
  meshWeight?: number;
};

/** Prefer sam_v1 mesh vector when quality passes floor; else mediapipe_v2; mode via RETRIEVAL_EMBEDDING_MODE. */
export function resolveRetrievalEmbedding(
  metrics: Record<string, unknown> | null | undefined,
  mediapipeVector: number[] | null,
  impactFrameResolved?: number,
  opts?: ResolveRetrievalEmbeddingOpts
): ResolvedRetrievalEmbedding | null {
  const pe = parsePoseEnrichment(metrics);
  const impactFrame =
    typeof impactFrameResolved === "number"
      ? impactFrameResolved
      : typeof metrics?.impact_frame_resolved === "number"
        ? (metrics.impact_frame_resolved as number)
        : undefined;

  const meshFrame = pickImpactEnrichmentFrame(pe, impactFrame);
  const meshVec = meshVectorFromEnrichmentFrame(meshFrame);
  const meshConf = meshFrame?.mesh_confidence ?? null;
  const meshOk =
    meshVec != null &&
    meshConf != null &&
    meshConf >= MESH_CONFIDENCE_MIN;

  const mode = retrievalEmbeddingMode();

  if (meshOk && meshVec && mode === "sam_v1") {
    return {
      vector: meshVec,
      embedding_source: "sam_v1",
      query_spec_version: MESH_EMBEDDING_SPEC_VERSION,
      mesh_used: true,
      mesh_confidence: meshConf,
    };
  }

  if (meshOk && meshVec && mediapipeVector && mode === "blended") {
    const meshWeight = opts?.meshWeight ?? retrievalBlendMeshWeight();
    return {
      vector: blendStoredTrainVectors(mediapipeVector, meshVec, meshWeight),
      embedding_source: "blended",
      query_spec_version: MESH_EMBEDDING_SPEC_VERSION,
      mesh_used: true,
      mesh_confidence: meshConf,
    };
  }

  if (meshOk && meshVec && !mediapipeVector) {
    return {
      vector: meshVec,
      embedding_source: "sam_v1",
      query_spec_version: MESH_EMBEDDING_SPEC_VERSION,
      mesh_used: true,
      mesh_confidence: meshConf,
    };
  }

  if (mediapipeVector) {
    return {
      vector: mediapipeVector,
      embedding_source: "mediapipe_v2",
      query_spec_version: "v2",
      mesh_used: Array.isArray(pe?.frames) && pe.frames.length > 0,
      mesh_confidence: meshConf,
    };
  }

  return null;
}

/** Train pro-library: mesh vector from extraction_meta.pose_enrichment last frame. */
export function embedTrainMeshFromExtractionMeta(
  extractionMeta: Record<string, unknown> | null | undefined
): number[] | null {
  const pe = parsePoseEnrichment(extractionMeta as Record<string, unknown>);
  if (!pe?.frames?.length) return null;
  const last = pe.frames[pe.frames.length - 1]!;
  const conf = last.mesh_confidence;
  if (typeof conf === "number" && conf < MESH_CONFIDENCE_MIN) return null;
  return meshVectorFromEnrichmentFrame(last);
}
