/** Human-facing train shot title (admin catalog label), not enum preset. */

const TRAIN_LEVEL_SUFFIXES = new Set(["Beginner", "Intermediate", "Advanced"]);

export function adminStrokeLabelKey(
  strokeLabel: string | null | undefined,
  strokeName: string
): string {
  const fromCol = (strokeLabel ?? "").trim();
  if (fromCol) return fromCol;
  const parts = strokeName.split(" · ");
  if (parts.length >= 2 && TRAIN_LEVEL_SUFFIXES.has(parts[parts.length - 1] ?? "")) {
    return parts.slice(0, -1).join(" · ").trim();
  }
  return strokeName.trim();
}

function looksLikeStrokePresetId(s: string): boolean {
  return /^[a-z0-9]+(_[a-z0-9]+)+$/.test(s.trim());
}

function presetIdToDisplayTitle(preset: string): string {
  return preset
    .trim()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

/**
 * Human shot title for Activities / coach lists from persisted analysis metrics.
 * Prefers stroke_label, then pro-neighbor stroke_name (e.g. "Forehand Half Volley · Advanced").
 */
export function deriveHumanShotLabelFromMetrics(
  metrics: Record<string, unknown> | null | undefined
): string {
  const fallback = "Technique";
  if (!metrics || typeof metrics !== "object") return fallback;

  const retrieval = metrics.retrieval as Record<string, unknown> | undefined;
  const hyp = retrieval?.shot_hypothesis as Record<string, unknown> | undefined;
  if (typeof hyp?.stroke_label === "string" && hyp.stroke_label.trim()) {
    const sl = hyp.stroke_label.trim();
    if (!looksLikeStrokePresetId(sl)) return sl;
  }

  const neighbors = Array.isArray(retrieval?.neighbors)
    ? (retrieval.neighbors as Array<Record<string, unknown>>)
    : [];
  for (const n of neighbors.slice(0, 6)) {
    if (typeof n.stroke_label === "string" && n.stroke_label.trim()) {
      return n.stroke_label.trim();
    }
    const strokeName = typeof n.stroke_name === "string" ? n.stroke_name : "";
    const colLabel = typeof n.stroke_label === "string" ? n.stroke_label : null;
    const key = adminStrokeLabelKey(colLabel, strokeName);
    if (key && !looksLikeStrokePresetId(key)) return key;
  }

  const ai = metrics.ai_analysis as Record<string, unknown> | undefined;
  const en = ai?.en as Record<string, unknown> | undefined;
  if (typeof en?.shot_context === "string" && en.shot_context.trim()) {
    const first = en.shot_context.split(/[.!?]/)[0]?.trim() ?? "";
    if (first) return first.length > 36 ? `${first.slice(0, 34)}…` : first;
  }

  if (typeof hyp?.stroke_preset === "string" && hyp.stroke_preset.trim()) {
    return presetIdToDisplayTitle(hyp.stroke_preset);
  }

  return fallback;
}
