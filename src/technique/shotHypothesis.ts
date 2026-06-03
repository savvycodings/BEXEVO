import type { TechniqueRetrievalResult } from "../db/schema";

/** Neighbor fields used for label-only shot hypothesis voting. */
export type ShotHypothesisNeighbor = {
  stroke_label: string;
  stroke_preset: string;
  category: string;
  skill_level: string;
  distance: number;
};

type LabelVoteBucket = {
  w: number;
  neighbors: ShotHypothesisNeighbor[];
};

function neighborWeight(distance: number): number {
  return 1 / (distance + 0.03);
}

function modeValue(values: string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) {
    const t = v?.trim();
    if (!t) continue;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  let best = "";
  let bestN = 0;
  for (const [k, n] of counts) {
    if (n > bestN) {
      bestN = n;
      best = k;
    }
  }
  return best;
}

/**
 * Single vote on admin stroke_label (trained name). Preset/category come from the
 * winning label cluster — not a separate preset vote (v9).
 */
export function buildShotHypothesis(
  neighbors: ShotHypothesisNeighbor[]
): TechniqueRetrievalResult["shot_hypothesis"] {
  if (neighbors.length === 0) {
    return {
      stroke_preset: null,
      stroke_label: null,
      category: null,
      skill_level: null,
      confidence: 0,
    };
  }

  const byLabel = new Map<string, LabelVoteBucket>();
  for (const n of neighbors) {
    const labelKey = n.stroke_label.trim() || n.stroke_preset;
    const add = neighborWeight(n.distance);
    const cur = byLabel.get(labelKey);
    if (cur) {
      cur.w += add;
      cur.neighbors.push(n);
    } else {
      byLabel.set(labelKey, { w: add, neighbors: [n] });
    }
  }

  const sortedLabels = [...byLabel.entries()].sort((a, b) => b[1].w - a[1].w);
  const topLabel = sortedLabels[0]!;
  const secondLabel = sortedLabels[1];
  const winners = topLabel[1].neighbors;
  const closestInWinners = winners.reduce((a, b) => (a.distance < b.distance ? a : b));

  let confidence: number;
  if (secondLabel) {
    confidence = Math.max(
      0,
      Math.min(1, (topLabel[1].w - secondLabel[1].w) / (topLabel[1].w + 1e-6))
    );
  } else {
    confidence = Math.max(0, Math.min(1, 1 - neighbors[0]!.distance / 0.45));
  }

  return {
    stroke_label: topLabel[0],
    stroke_preset: closestInWinners.stroke_preset,
    category: modeValue(winners.map((n) => n.category)),
    skill_level: modeValue(winners.map((n) => n.skill_level)),
    confidence,
  };
}
