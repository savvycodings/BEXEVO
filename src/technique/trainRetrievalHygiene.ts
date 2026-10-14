/** Filters mislabeled train rows out of technique k-NN results. */

export type TrainNeighborCandidate = {
  train_sample_id: string;
  train_video_id: string;
  stroke_name: string;
  stroke_label: string;
  category: string;
  stroke_preset: string;
  skill_level: string;
  distance: number;
  view_profile?: string | null;
  extraction_meta?: {
    normalized_label?: {
      canonical_stroke?: string;
      confidence?: number | string;
    } | null;
  } | null;
};

const BLOCKED_PRESET_LABELS: Array<{ preset: string; labelIncludes: string }> = [
  { preset: "forehand_lob", labelIncludes: "por cuatro smash" },
];

function normalizedLabelConflicts(
  strokeLabel: string,
  extractionMeta: TrainNeighborCandidate["extraction_meta"]
): boolean {
  const norm = extractionMeta?.normalized_label;
  if (!norm || typeof norm !== "object") return false;
  const canonical =
    typeof norm.canonical_stroke === "string" ? norm.canonical_stroke.trim() : "";
  const label = strokeLabel.trim();
  if (!canonical || !label) return false;
  const confRaw = norm.confidence;
  const conf =
    typeof confRaw === "number"
      ? confRaw
      : typeof confRaw === "string" && confRaw.toLowerCase() === "advanced"
        ? 0.9
        : Number(confRaw);
  if (!Number.isFinite(conf) || conf < 0.85) return false;
  if (label.toLowerCase() === canonical.toLowerCase()) return false;
  if (label.toLowerCase().includes(canonical.toLowerCase())) return false;
  return true;
}

export function isExcludedTrainNeighbor(row: TrainNeighborCandidate): boolean {
  const labelLower = row.stroke_label.toLowerCase();
  for (const blocked of BLOCKED_PRESET_LABELS) {
    if (
      row.stroke_preset === blocked.preset &&
      labelLower.includes(blocked.labelIncludes)
    ) {
      return true;
    }
  }
  return normalizedLabelConflicts(row.stroke_label, row.extraction_meta);
}

export function filterTrainNeighborsForRetrieval(
  rows: TrainNeighborCandidate[]
): TrainNeighborCandidate[] {
  return rows.filter((r) => !isExcludedTrainNeighbor(r));
}

export type RetrievalCandidateFilter = {
  strokePreset?: string | null;
  category?: string | null;
  skillLevel?: string | null;
};

const TRAIN_SKILL_LEVELS = new Set(["beginner", "intermediate", "advanced"]);

/**
 * Filters to try for a declared shot, strictest first: category + stroke preset + skill level,
 * then without skill level (the library is mostly `advanced`), then preset alone, then category.
 */
export function declaredShotConstraints(declared: {
  category?: string | null;
  strokePreset?: string | null;
  skillLevel?: string | null;
} | null): RetrievalCandidateFilter[] {
  const category = declared?.category?.trim() || null;
  const strokePreset = declared?.strokePreset?.trim() || null;
  // The app sends the display label ("Advanced"); train_video stores the lowercase enum.
  const rawSkill = declared?.skillLevel?.trim().toLowerCase() ?? "";
  const skillLevel = TRAIN_SKILL_LEVELS.has(rawSkill) ? rawSkill : null;
  const steps: RetrievalCandidateFilter[] = [
    { category, strokePreset, skillLevel },
    { category, strokePreset },
    { strokePreset },
    { category },
  ];
  const seen = new Set<string>();
  return steps.filter((c) => {
    if (!c.category && !c.strokePreset) return false;
    const key = JSON.stringify([c.category ?? null, c.strokePreset ?? null, c.skillLevel ?? null]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
