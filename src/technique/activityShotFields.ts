import { trainCategoryFromMetrics } from "../gamification/stats";
import { parsePhysicalMetrics } from "./physicalMetrics";

export type ShotCardMetrics = { stability: number; power: number; agility: number };

/** Extra per-item fields for the Shots list cards: shot category and the three card sub-scores. */
export function shotCardFields(metrics: unknown): {
  category: string | null;
  physicalMetrics: ShotCardMetrics | null;
} {
  const m = metrics && typeof metrics === "object" ? (metrics as Record<string, unknown>) : null;
  const ai = m?.ai_analysis as Record<string, unknown> | undefined;
  const pm = parsePhysicalMetrics(ai?.physical_metrics);
  return {
    category: trainCategoryFromMetrics(m),
    physicalMetrics: pm ? { stability: pm.stability, power: pm.power, agility: pm.agility } : null,
  };
}
