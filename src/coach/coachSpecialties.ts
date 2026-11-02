/**
 * Fixed coach specialty catalog, in display order. Keep in sync with
 * FEXevo/src/lib/coachSpecialties.ts (guarded by coachSpecialtiesParity.test.ts).
 */
export const COACH_SPECIALTY_KEYS = [
  "technique",
  "tactics",
  "matchplay",
  "fitness",
  "mental",
  "beginners",
  "juniors",
  "competition",
] as const;
export type CoachSpecialtyKey = (typeof COACH_SPECIALTY_KEYS)[number];

export const MAX_COACH_SPECIALTIES = 5;

export type NormalizeSpecialtiesError = "not_array" | "unknown_key" | "too_many";

/** Dedupes, sorts into catalog order, and rejects non-arrays, unknown keys and more than 5. */
export function normalizeSpecialties(
  input: unknown
):
  | { ok: true; specialties: CoachSpecialtyKey[] }
  | { ok: false; error: NormalizeSpecialtiesError; detail?: string } {
  if (!Array.isArray(input)) return { ok: false, error: "not_array" };
  const known = new Set<string>(COACH_SPECIALTY_KEYS);
  const picked = new Set<string>();
  for (const v of input) {
    if (typeof v !== "string" || !known.has(v)) {
      return { ok: false, error: "unknown_key", detail: String(v) };
    }
    picked.add(v);
  }
  if (picked.size > MAX_COACH_SPECIALTIES) return { ok: false, error: "too_many" };
  return { ok: true, specialties: COACH_SPECIALTY_KEYS.filter((k) => picked.has(k)) };
}

/** What a profile read returns: the stored list for coaches, empty for everyone else. */
export function visibleSpecialties(role: unknown, stored: unknown): string[] {
  if (role !== "coach" || !Array.isArray(stored)) return [];
  return stored.filter((v): v is string => typeof v === "string");
}
