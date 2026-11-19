import { trainCategoryFromMetrics } from "../gamification/stats";
import { parsePhysicalMetrics } from "./physicalMetrics";

/** All five movement scores — clients average these for the headline ring. */
export type ShotCardMetrics = {
  stability: number;
  power: number;
  agility: number;
  reactions: number;
  acceleration: number;
};

/** Extra per-item fields for the Shots list cards: shot category and physical metrics. */
export function shotCardFields(metrics: unknown): {
  category: string | null;
  physicalMetrics: ShotCardMetrics | null;
} {
  const m = metrics && typeof metrics === "object" ? (metrics as Record<string, unknown>) : null;
  const ai = m?.ai_analysis as Record<string, unknown> | undefined;
  const pm = parsePhysicalMetrics(ai?.physical_metrics);
  return {
    category: trainCategoryFromMetrics(m),
    physicalMetrics: pm
      ? {
          stability: pm.stability,
          power: pm.power,
          agility: pm.agility,
          reactions: pm.reactions,
          acceleration: pm.acceleration,
        }
      : null,
  };
}
