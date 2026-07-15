import type { TechniqueRetrievalResult } from "../db/schema";

/** Neighbor fields used for label-only shot hypothesis voting. */
export type ShotHypothesisNeighbor = {
  stroke_label: string;
  stroke_preset: string;
  category: string;
  skill_level: string;
  distance: number;
  /** Optional per-source vote multiplier (channel/impact weight). Defaults to 1. */
  sourceWeight?: number;
};

function envNum(name: string, def: number): number {
  const raw = (process.env[name] ?? "").trim();
  if (raw === "") return def;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

/**
 * Peaked distance → vote weight. A near-zero-distance (near-exact) match must dominate
 * so it is not outvoted by several slightly-further duplicates of another label.
 * exp(-d/tau) is sharply peaked near 0, unlike the old near-flat 1/(d+0.03).
 */
export function voteWeight(distance: number): number {
  const tau = envNum("RETRIEVAL_DISTANCE_TAU", 0.02);
  const t = tau > 0 ? tau : 0.02;
  return Math.exp(-Math.max(0, distance) / t);
}

/**
 * Nearest-neighbor override: an almost-exact pose match should win outright, even if
 * another label has more (slightly further) exemplars in the library.
 */
const NN_OVERRIDE_MAX_DIST = () => envNum("RETRIEVAL_NN_OVERRIDE_MAX_DIST", 0.02);
const NN_OVERRIDE_RATIO = () => envNum("RETRIEVAL_NN_OVERRIDE_RATIO", 2.5);
const NN_OVERRIDE_MARGIN = () => envNum("RETRIEVAL_NN_OVERRIDE_MARGIN", 0.015);

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function labelKeyOf(n: { stroke_label: string; stroke_preset: string }): string {
  return n.stroke_label.trim() || n.stroke_preset;
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
 * Shared shot-label selection used by both the per-channel hypothesis and the
 * dual-channel ensemble aggregate, so every surface agrees on one rule:
 *  1. Distinct-source, peaked, weighted label vote (duplicates cannot dominate).
 *  2. Nearest-neighbor override when one label owns a decisively closer match.
 *
 * Input MUST already be de-duplicated to one row per train source (best distance).
 */
export function selectShotLabel(
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

  const byLabel = new Map<string, { w: number; members: ShotHypothesisNeighbor[] }>();
  for (const n of neighbors) {
    const key = labelKeyOf(n);
    const add = (n.sourceWeight ?? 1) * voteWeight(n.distance);
    const cur = byLabel.get(key);
    if (cur) {
      cur.w += add;
      cur.members.push(n);
    } else {
      byLabel.set(key, { w: add, members: [n] });
    }
  }

  const byVote = [...byLabel.entries()].sort((a, b) => b[1].w - a[1].w);
  const byDistance = [...neighbors].sort((a, b) => a.distance - b.distance);

  const nearest = byDistance[0]!;
  const nearestLabel = labelKeyOf(nearest);
  const dMin = nearest.distance;
  const runnerUp = byDistance.find((n) => labelKeyOf(n) !== nearestLabel);
  const runnerDist = runnerUp ? runnerUp.distance : Infinity;

  const override =
    dMin <= NN_OVERRIDE_MAX_DIST() &&
    (runnerDist >= dMin + NN_OVERRIDE_MARGIN() || runnerDist >= dMin * NN_OVERRIDE_RATIO());

  let winnerLabel: string;
  let confidence: number;
  if (override) {
    winnerLabel = nearestLabel;
    confidence = Number.isFinite(runnerDist)
      ? clamp01((runnerDist - dMin) / (runnerDist + 1e-6))
      : clamp01(1 - dMin / 0.45);
  } else {
    winnerLabel = byVote[0]![0];
    const top = byVote[0]![1].w;
    const second = byVote[1]?.[1].w;
    confidence =
      second != null
        ? clamp01((top - second) / (top + 1e-6))
        : clamp01(1 - dMin / 0.45);
  }

  const winners = (byLabel.get(winnerLabel)?.members ?? []).slice();
  const closest = winners.reduce(
    (a, b) => (a.distance < b.distance ? a : b),
    winners[0] ?? nearest
  );

  return {
    stroke_label: winnerLabel,
    stroke_preset: closest.stroke_preset,
    category: modeValue(winners.map((n) => n.category)),
    skill_level: modeValue(winners.map((n) => n.skill_level)),
    confidence,
  };
}

/**
 * Single-channel vote on admin stroke_label (trained name). Preset/category come from the
 * winning label cluster. Thin wrapper over the shared selector (input should already be
 * de-duplicated to one neighbor per source).
 */
export function buildShotHypothesis(
  neighbors: ShotHypothesisNeighbor[]
): TechniqueRetrievalResult["shot_hypothesis"] {
  return selectShotLabel(neighbors);
}
