/** The player's racket from Profile Edit → Racket Information. One jsonb blob on user_profile. */

export type Racket = {
  brand?: string | null;
  model?: string | null;
  /** grams */
  weightG?: number | null;
  /** cm from the butt cap */
  balanceCm?: number | null;
  /** mm */
  lengthMm?: number | null;
  /** e.g. "L3" — free text so new sizes don't need a deploy */
  grip?: string | null;
  /** kg·cm² */
  swingweight?: number | null;
  /** e.g. "Carbon 12K" */
  surface?: string | null;
};

const NUMBERS = {
  weightG: { min: 300, max: 420, step: 1 },
  balanceCm: { min: 22, max: 30, step: 0.1 },
  lengthMm: { min: 420, max: 480, step: 1 },
  swingweight: { min: 200, max: 450, step: 1 },
} as const;
const TEXTS = { brand: 40, model: 80, grip: 20, surface: 40 } as const;

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** Partial update: keys sent overwrite, null or "" clears, unknown keys are rejected. */
export function parseRacket(body: unknown): Parsed<Racket> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Send an object with racket fields." };
  }
  const out: Record<string, string | number | null> = {};
  for (const [key, raw] of Object.entries(body as Record<string, unknown>)) {
    if (key in TEXTS) {
      if (raw == null || raw === "") {
        out[key] = null;
        continue;
      }
      if (typeof raw !== "string") return { ok: false, error: `${key} must be text or null.` };
      const v = raw.trim().replace(/\s+/g, " ");
      const max = TEXTS[key as keyof typeof TEXTS];
      if (v.length > max) return { ok: false, error: `${key} must be at most ${max} characters.` };
      out[key] = v || null;
    } else if (key in NUMBERS) {
      if (raw == null || raw === "") {
        out[key] = null;
        continue;
      }
      const n = typeof raw === "number" ? raw : Number(raw);
      const r = NUMBERS[key as keyof typeof NUMBERS];
      if (!Number.isFinite(n)) return { ok: false, error: `${key} must be a number or null.` };
      if (n < r.min || n > r.max) return { ok: false, error: `${key} must be between ${r.min} and ${r.max}.` };
      out[key] = r.step < 1 ? Math.round(n * 10) / 10 : Math.round(n);
    } else {
      return { ok: false, error: `Unknown racket field: ${key}.` };
    }
  }
  if (Object.keys(out).length === 0) return { ok: false, error: "Send at least one racket field." };
  return { ok: true, value: out as Racket };
}

export function mergeRacket(current: Racket | null | undefined, update: Racket): Racket {
  const next: Record<string, unknown> = { ...(current ?? {}) };
  for (const [k, v] of Object.entries(update)) {
    if (v == null) delete next[k];
    else next[k] = v;
  }
  return next as Racket;
}
