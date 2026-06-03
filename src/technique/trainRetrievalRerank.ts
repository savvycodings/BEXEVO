import type { TrainNeighborCandidate } from "./trainRetrievalHygiene";
import { overheadEvidenceFromMetrics } from "./overheadPoseEvidence";

export type RetrievalRerankMeta = {
  applied: boolean;
  supports_overhead: boolean;
  bandeja_contention: boolean;
  bandeja_bonus: number;
  serve_penalty: number;
  top_raw_distance: number | null;
  top_effective_distance: number | null;
};

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export const BANDEJA_DISTANCE_BONUS = envNum("RETRIEVAL_BANDEJA_DISTANCE_BONUS", 0.05);
export const SAVE_RETURN_SERVE_PENALTY = envNum("RETRIEVAL_SAVE_RETURN_SERVE_PENALTY", 0.05);
export const CONTENTION_MARGIN = envNum("RETRIEVAL_BANDEJA_CONTENTION_MARGIN", 0.12);

export function isBandejaNeighbor(row: TrainNeighborCandidate): boolean {
  if (row.stroke_preset === "bandeja") return true;
  return row.stroke_label.toLowerCase().includes("bandeja");
}

export function isServeLikeSaveReturn(row: TrainNeighborCandidate): boolean {
  if (row.category !== "save_return") return false;
  const label = row.stroke_label.trim();
  if (!label) return false;
  if (/serve/i.test(label)) return true;
  const lower = label.toLowerCase();
  return lower === "flat serve" || lower === "slice serve";
}

function bestRawBandejaDistance(rows: TrainNeighborCandidate[]): number | null {
  let best: number | null = null;
  for (const r of rows) {
    if (!isBandejaNeighbor(r)) continue;
    if (best == null || r.distance < best) best = r.distance;
  }
  return best;
}

export function shouldApplyBandejaRerank(
  rows: TrainNeighborCandidate[],
  supportsOverhead: boolean
): { apply: boolean; bandejaContention: boolean } {
  if (rows.length === 0) {
    return { apply: false, bandejaContention: false };
  }
  const topRaw = rows[0]!.distance;
  const bestBandeja = bestRawBandejaDistance(rows);
  const bandejaContention =
    bestBandeja != null && bestBandeja < topRaw + CONTENTION_MARGIN;
  const apply = supportsOverhead || bandejaContention;
  return { apply, bandejaContention };
}

export function effectiveNeighborDistance(
  row: TrainNeighborCandidate,
  ctx: { apply: boolean; supportsOverhead: boolean }
): number {
  let d = row.distance;
  if (!ctx.apply) return d;

  if (isBandejaNeighbor(row)) {
    d -= BANDEJA_DISTANCE_BONUS;
  }
  if (isServeLikeSaveReturn(row)) {
    d += SAVE_RETURN_SERVE_PENALTY;
  }
  return Math.max(0, d);
}

export type RerankedNeighbor = TrainNeighborCandidate & {
  /** Cosine distance before bandeja/serve rerank */
  raw_distance: number;
};

export function rerankTrainNeighbors(
  rows: TrainNeighborCandidate[],
  metrics: Record<string, unknown> | null | undefined
): { neighbors: RerankedNeighbor[]; rerank: RetrievalRerankMeta } {
  const overhead = overheadEvidenceFromMetrics(metrics);
  const { apply, bandejaContention } = shouldApplyBandejaRerank(
    rows,
    overhead.supportsOverhead
  );

  const withEffective: RerankedNeighbor[] = rows.map((r) => ({
    ...r,
    raw_distance: r.distance,
    distance: effectiveNeighborDistance(r, {
      apply,
      supportsOverhead: overhead.supportsOverhead,
    }),
  }));

  withEffective.sort((a, b) => a.distance - b.distance);

  const topRaw = rows.length > 0 ? Math.min(...rows.map((r) => r.distance)) : null;
  const topEffective =
    withEffective.length > 0 ? withEffective[0]!.distance : null;

  return {
    neighbors: withEffective,
    rerank: {
      applied: apply,
      supports_overhead: overhead.supportsOverhead,
      bandeja_contention: bandejaContention,
      bandeja_bonus: apply ? BANDEJA_DISTANCE_BONUS : 0,
      serve_penalty: apply ? SAVE_RETURN_SERVE_PENALTY : 0,
      top_raw_distance: topRaw,
      top_effective_distance: topEffective,
    },
  };
}
