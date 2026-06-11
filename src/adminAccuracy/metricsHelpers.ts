import { resolveCanonicalShotFromMetrics } from "../train/trainShotDisplay";
import { labelsMatch } from "./scoring";
import {
  meshConfidenceFromMetrics,
  meshUsedFromMetrics,
  parsePoseEnrichment,
} from "../technique/meshEmbedding";

export function retrievalFromMetrics(metrics: Record<string, unknown> | null | undefined) {
  const r = metrics?.retrieval;
  if (!r || typeof r !== "object") return null;
  return r as Record<string, unknown>;
}

export function shotHypothesis(metrics: Record<string, unknown> | null | undefined) {
  const hyp = retrievalFromMetrics(metrics)?.shot_hypothesis;
  if (!hyp || typeof hyp !== "object") return null;
  return hyp as Record<string, unknown>;
}

export function topNeighbor(metrics: Record<string, unknown> | null | undefined) {
  const neighbors = retrievalFromMetrics(metrics)?.neighbors;
  if (!Array.isArray(neighbors) || neighbors.length === 0) return null;
  const n = neighbors[0];
  if (!n || typeof n !== "object") return null;
  return n as Record<string, unknown>;
}

export function correctionShotName(metrics: Record<string, unknown> | null | undefined): string | null {
  const ctx = metrics?.correction_context;
  if (!ctx || typeof ctx !== "object") return null;
  const shot = (ctx as Record<string, unknown>).shot_and_handedness;
  if (!shot || typeof shot !== "object") return null;
  const name = (shot as Record<string, unknown>).shot;
  if (!name || typeof name !== "object") return null;
  const shotName = (name as Record<string, unknown>).shot_name;
  return typeof shotName === "string" ? shotName.trim() : null;
}

export function canonicalDisplayShot(metrics: Record<string, unknown> | null | undefined): string {
  return resolveCanonicalShotFromMetrics(metrics).shotName;
}

export function impactFrameSource(metrics: Record<string, unknown> | null | undefined): string | null {
  const src = metrics?.impact_frame_source;
  return typeof src === "string" ? src : null;
}

export function hasYoloContacts(metrics: Record<string, unknown> | null | undefined): boolean {
  const yolo = metrics?.yolo_summary;
  if (!yolo || typeof yolo !== "object") return false;
  const frames = (yolo as Record<string, unknown>).contact_window_frames;
  return Array.isArray(frames) && frames.length > 0;
}

export function hypothesisMatchesTopNeighbor(metrics: Record<string, unknown> | null | undefined): boolean {
  const hyp = shotHypothesis(metrics);
  const neighbor = topNeighbor(metrics);
  if (!hyp || !neighbor) return false;
  const hypLabel = typeof hyp.stroke_label === "string" ? hyp.stroke_label : "";
  const neighborLabel =
    typeof neighbor.stroke_label === "string" ? neighbor.stroke_label : "";
  return labelsMatch(hypLabel, neighborLabel);
}

export function displayMatchesSuggestion(metrics: Record<string, unknown> | null | undefined): boolean {
  const display = canonicalDisplayShot(metrics);
  const hyp = shotHypothesis(metrics);
  const hypLabel = typeof hyp?.stroke_label === "string" ? hyp.stroke_label : "";
  if (labelsMatch(display, hypLabel)) return true;
  const neighbor = topNeighbor(metrics);
  const neighborLabel =
    typeof neighbor?.stroke_label === "string" ? neighbor.stroke_label : "";
  return labelsMatch(display, neighborLabel);
}

export function correctionMatchesDisplay(metrics: Record<string, unknown> | null | undefined): boolean {
  const corr = correctionShotName(metrics);
  if (!corr) return false;
  return labelsMatch(corr, canonicalDisplayShot(metrics));
}

export function meshEnrichmentUsed(metrics: Record<string, unknown> | null | undefined): boolean {
  return meshUsedFromMetrics(metrics);
}

export function embeddingSource(metrics: Record<string, unknown> | null | undefined): string | null {
  const r = retrievalFromMetrics(metrics);
  const src = r?.embedding_source;
  return typeof src === "string" ? src : null;
}

export function meshDebugSample(metrics: Record<string, unknown> | null | undefined) {
  const pe = parsePoseEnrichment(metrics);
  const impact =
    typeof metrics?.impact_frame_resolved === "number"
      ? metrics.impact_frame_resolved
      : undefined;
  return {
    mesh_used: meshEnrichmentUsed(metrics),
    embedding_source: embeddingSource(metrics),
    mesh_confidence: meshConfidenceFromMetrics(metrics, impact),
    mesh_trigger: pe?.trigger ?? null,
    sam_model_loaded: pe?.sam_model_loaded ?? null,
    mesh_frame_count: Array.isArray(pe?.frames) ? pe.frames.length : 0,
  };
}
