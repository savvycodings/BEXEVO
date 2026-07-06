import type { TechniquePhysicalMetrics } from "../db/schema";

export const PHYSICAL_METRICS_VERSION = "v1";

const METRIC_KEYS = [
  "stability",
  "power",
  "agility",
  "reactions",
  "acceleration",
] as const;

export type PhysicalMetricKey = (typeof METRIC_KEYS)[number];

function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

export function defaultPhysicalMetrics(): TechniquePhysicalMetrics {
  return {
    stability: 50,
    power: 50,
    agility: 50,
    reactions: 50,
    acceleration: 50,
    source: "llm",
    version: PHYSICAL_METRICS_VERSION,
  };
}

/** Parse LLM physical_metrics block; returns null if raw is missing/invalid. */
export function parsePhysicalMetrics(raw: unknown): TechniquePhysicalMetrics | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const out: Partial<TechniquePhysicalMetrics> = {};
  for (const key of METRIC_KEYS) {
    const v = o[key];
    if (typeof v !== "number" && typeof v !== "string") return null;
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n)) return null;
    out[key] = clampPercent(n);
  }
  return {
    stability: out.stability!,
    power: out.power!,
    agility: out.agility!,
    reactions: out.reactions!,
    acceleration: out.acceleration!,
    source: "llm",
    version: PHYSICAL_METRICS_VERSION,
  };
}

/** Attach normalized physical_metrics to ai_analysis (defaults if LLM omitted). */
export function normalizePhysicalMetricsOnAnalysis(
  aiAnalysis: Record<string, unknown>
): TechniquePhysicalMetrics {
  const parsed = parsePhysicalMetrics(aiAnalysis.physical_metrics);
  const metrics = parsed ?? defaultPhysicalMetrics();
  aiAnalysis.physical_metrics = metrics;
  return metrics;
}

export { METRIC_KEYS };
