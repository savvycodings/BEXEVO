/**
 * Manual body measurements from Athlete Calibration, all in centimetres. Height and weight
 * live in their own columns; everything else is one jsonb blob on user_profile so new
 * measurements don't need a migration each.
 */

export type MeasurementPair = { left: number | null; right: number | null };

/** Plausible adult ranges in cm; the app uses the same ones to catch typos (e.g. inches in cm mode). */
export const SINGLE_RANGES = {
  wingspan: { min: 100, max: 260 },
  shoulder: { min: 25, max: 70 },
  chest: { min: 60, max: 160 },
  torso: { min: 30, max: 100 },
  hip: { min: 20, max: 150 },
  waist: { min: 45, max: 160 },
} as const;

export const PAIR_RANGES = {
  arm: { min: 40, max: 95 },
  upperArm: { min: 15, max: 60 },
  forearm: { min: 15, max: 50 },
  hand: { min: 10, max: 30 },
  upperLeg: { min: 25, max: 80 },
  lowerLeg: { min: 25, max: 75 },
  armCirc: { min: 18, max: 60 },
  thighCirc: { min: 35, max: 90 },
  calfCirc: { min: 25, max: 60 },
} as const;

export type SingleMeasurement = keyof typeof SINGLE_RANGES;
export type PairMeasurement = keyof typeof PAIR_RANGES;
export type BodyMeasurements = Partial<Record<SingleMeasurement, number | null>> &
  Partial<Record<PairMeasurement, MeasurementPair>>;

type Range = { min: number; max: number };
type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function parseCm(raw: unknown, key: string, range: Range): Parsed<number | null> {
  if (raw === null || raw === undefined || raw === "") return { ok: true, value: null };
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return { ok: false, error: `${key} must be a number or null.` };
  if (n < range.min || n > range.max) {
    return { ok: false, error: `${key} must be between ${range.min} and ${range.max} cm.` };
  }
  return { ok: true, value: Math.round(n * 10) / 10 };
}

/**
 * Validates a partial update. Unknown keys are rejected so a typo doesn't silently vanish;
 * a key sent as null clears it. Returns only the keys that were sent.
 */
export function parseBodyMeasurements(body: unknown): Parsed<BodyMeasurements> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Send an object of measurements in cm." };
  }
  const out: BodyMeasurements = {};
  for (const [key, raw] of Object.entries(body as Record<string, unknown>)) {
    if (key in SINGLE_RANGES) {
      const k = key as SingleMeasurement;
      const p = parseCm(raw, k, SINGLE_RANGES[k]);
      if (!p.ok) return p;
      out[k] = p.value;
    } else if (key in PAIR_RANGES) {
      const k = key as PairMeasurement;
      if (raw === null) {
        out[k] = { left: null, right: null };
        continue;
      }
      if (typeof raw !== "object" || Array.isArray(raw)) {
        return { ok: false, error: `${k} must be { left, right } or null.` };
      }
      const pr = raw as Record<string, unknown>;
      const l = parseCm(pr.left, `${k}.left`, PAIR_RANGES[k]);
      if (!l.ok) return l;
      const r = parseCm(pr.right, `${k}.right`, PAIR_RANGES[k]);
      if (!r.ok) return r;
      out[k] = { left: l.value, right: r.value };
    } else {
      return { ok: false, error: `Unknown measurement: ${key}.` };
    }
  }
  if (Object.keys(out).length === 0) return { ok: false, error: "Send at least one measurement." };
  return { ok: true, value: out };
}

/** Merges an update into what is stored, dropping cleared keys so the blob stays small. */
export function mergeBodyMeasurements(
  current: BodyMeasurements | null | undefined,
  update: BodyMeasurements
): BodyMeasurements {
  const next: Record<string, unknown> = { ...(current ?? {}) };
  for (const [k, v] of Object.entries(update)) {
    const empty = v == null || (typeof v === "object" && v.left == null && v.right == null);
    if (empty) delete next[k];
    else next[k] = v;
  }
  return next as BodyMeasurements;
}
