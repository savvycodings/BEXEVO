/**
 * Drop LLM placeholder lines that copy analyze-prompt "Legacy fallback…" examples
 * into stored ai_analysis.recommendations / observations.
 */

const LEGACY_PLACEHOLDER_RE =
  /legacy\s*(fallback)?|recomendaci[oó]n\s*legacy|observaci[oó]n\s*legacy/i

const BARE_NUMBERED_STUB_RE =
  /^(recommendation|observation|recomendaci[oó]n|observaci[oó]n)\s*\d+$/i

export function isLegacyCoachPlaceholderLine(value: string): boolean {
  const t = value.trim()
  if (!t) return true
  if (LEGACY_PLACEHOLDER_RE.test(t)) return true
  if (BARE_NUMBERED_STUB_RE.test(t)) return true
  return false
}

function filterLegacyLines(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  return raw.filter(
    (item): item is string =>
      typeof item === 'string' && !isLegacyCoachPlaceholderLine(item)
  )
}

function sanitizeLocaleBlock(block: unknown): void {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return
  const b = block as Record<string, unknown>
  const observations = filterLegacyLines(b.observations)
  if (observations) b.observations = observations
  const recommendations = filterLegacyLines(b.recommendations)
  if (recommendations) b.recommendations = recommendations
}

/** Mutates ai_analysis en/es (and top-level) recommendations/observations in place. */
export function sanitizeAiAnalysisNarrativePlaceholders(
  aiAnalysis: Record<string, unknown>
): void {
  sanitizeLocaleBlock(aiAnalysis.en)
  sanitizeLocaleBlock(aiAnalysis.es)
  sanitizeLocaleBlock(aiAnalysis)
}
