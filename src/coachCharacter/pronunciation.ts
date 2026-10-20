/**
 * Pronunciation lexicon for coach speech. Rewrites brand names, padel terms and
 * units into spellings the TTS model reads correctly, before the text is sent
 * to the voice instance. Only the audio input changes; the chat reply the
 * player sees keeps the real spelling.
 *
 * Spoken forms are ordinary spelling approximations, not phonemes, so each one
 * has to be approved by ear with the voice that is actually loaded. Set
 * `reviewed: true` once an entry sounds right, and test it alone and inside a
 * couple of sentences: a spelling that works in one context can fail in another.
 *
 * `en` forms target the current English Orpheus voice (Ceylia). `es` forms are
 * written in Spanish spelling for a Spanish voice; the English voice reads them
 * with English phonetics either way.
 */
import type { CoachLocale } from "./coachContext";

export type PronunciationEntry = {
  /** Canonical written form, matched as a whole word. */
  term: string;
  /** Spoken form per locale. A locale without one leaves the term untouched. */
  spoken: Partial<Record<CoachLocale, string>>;
  /** Match case exactly. Use for acronyms that collide with ordinary words. */
  caseSensitive?: boolean;
  /** Approved by ear with the current voice. */
  reviewed?: boolean;
};

export const PRONUNCIATION_LEXICON: PronunciationEntry[] = [
  // Brand. The intended pronunciation is a product decision; confirm before relying on it.
  { term: "Xevo", spoken: { en: "Zee-voh", es: "Ché-vo" } },
  // Spanish pronunciation confirmed by the product owner: "A equis evo éi ái", said as one
  // word. Spelled with spaces: joined spellings ("Aequisevoeiai") garble in Chatterbox.
  // Picked by ear 2026-10-20 with Chatterbox Multilingual (es).
  { term: "Axevo AI", spoken: { es: "A equis evo ei ai" }, reviewed: true },
  { term: "AxevoAI", spoken: { es: "A equis evo ei ai" }, reviewed: true },
  { term: "Axevo", spoken: { en: "Ax-ee-voh", es: "A equis evo" } },

  // Padel words the English voice mangles. Measured 2026-10-20 against the Ceylia voice:
  // plain Spanish spelling already works for bandeja, chiquita, cristal, globo, volea,
  // bajada, dejada and salida de pared, so they have no entry. Avoid hyphenated
  // respellings: the voice pauses at every hyphen.
  { term: "víbora", spoken: { en: "vibora" } },
  { term: "vibora", spoken: { es: "víbora" } },
  { term: "contrapared", spoken: { en: "contra pared" } },
  { term: "rulo", spoken: { en: "roo lo" } },
  { term: "gancho", spoken: { en: "gahncho" } },
  { term: "remate", spoken: { en: "reh mah tay" } },
  { term: "revés", spoken: { en: "rehvess" } },
  { term: "padel", spoken: { es: "pádel" } },
  { term: "pádel", spoken: { en: "padel" } },

  // Training categories reach the coach as raw ids ("Main area to train: net_play").
  { term: "ground_strokes", spoken: { en: "ground strokes", es: "golpes de fondo" } },
  { term: "net_play", spoken: { en: "net play", es: "juego de red" } },
  { term: "defence_glass", spoken: { en: "defence off the glass", es: "defensa con el cristal" } },
  { term: "save_return", spoken: { en: "saves and returns", es: "defensa y resto" } },
  { term: "overhead", spoken: { es: "golpes por arriba" } },
  { term: "tactical_specials", spoken: { en: "tactical specials", es: "golpes tácticos" } },

  // Scores are given to the coach as "82/100".
  { term: "/100", spoken: { en: " out of 100", es: " de 100" } },
  { term: "/10", spoken: { en: " out of 10", es: " de 10" } },

  // Acronyms and abbreviations. The English voice already spells AI, WPT and FIP.
  { term: "AI", spoken: { es: "I A" }, caseSensitive: true },
  { term: "IA", spoken: { es: "I A" }, caseSensitive: true },
  { term: "WPT", spoken: { es: "uve doble pe te" }, caseSensitive: true },
  { term: "FIP", spoken: { es: "efe i pe" }, caseSensitive: true },
  { term: "vs", spoken: { en: "versus", es: "contra" } },
  { term: "vs.", spoken: { en: "versus", es: "contra" } },
  { term: "pts", spoken: { en: "points", es: "puntos" } },
  { term: "pts.", spoken: { en: "points", es: "puntos" } },
  { term: "x3", spoken: { en: "por tres", es: "por tres" } },
  { term: "x4", spoken: { en: "por cuatro", es: "por cuatro" } },

  // Units.
  { term: "km/h", spoken: { en: "kilometers per hour", es: "kilómetros por hora" } },
  { term: "mph", spoken: { en: "miles per hour", es: "millas por hora" } },
  { term: "m/s", spoken: { en: "meters per second", es: "metros por segundo" } },
  { term: "rpm", spoken: { en: "R P M", es: "revoluciones por minuto" } },
  { term: "°", spoken: { en: " degrees", es: " grados" } },
  { term: "%", spoken: { en: " percent", es: " por ciento" } },
];

type CompiledEntry = { pattern: RegExp; spoken: string };

const compiled = new Map<CoachLocale, CompiledEntry[]>();

const WORD_CHAR = /[\p{L}\p{N}]/u;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/**
 * Whole-word match, Unicode-aware so accented neighbours count as letters. Edges
 * that are symbols ("/100", "°") skip the boundary so they still match after a digit.
 */
function termPattern(e: PronunciationEntry): RegExp {
  const before = WORD_CHAR.test(e.term[0]) ? "(?<![\\p{L}\\p{N}])" : "";
  const after = WORD_CHAR.test(e.term[e.term.length - 1]) ? "(?![\\p{L}\\p{N}])" : "";
  return new RegExp(`${before}${escapeRegExp(e.term)}${after}`, e.caseSensitive ? "gu" : "giu");
}

/** Longest terms first so "Axevo" wins over "Xevo" and "/100" over "/10". */
function entriesFor(locale: CoachLocale, lexicon: PronunciationEntry[]): CompiledEntry[] {
  return lexicon
    .filter((e) => e.spoken[locale])
    .sort((a, b) => b.term.length - a.term.length)
    .map((e) => ({ pattern: termPattern(e), spoken: e.spoken[locale] as string }));
}

/** Replaces lexicon terms with their spoken form for `locale`. */
export function applyPronunciation(
  text: string,
  locale: CoachLocale,
  lexicon: PronunciationEntry[] = PRONUNCIATION_LEXICON
): string {
  let entries = lexicon === PRONUNCIATION_LEXICON ? compiled.get(locale) : undefined;
  if (!entries) {
    entries = entriesFor(locale, lexicon);
    if (lexicon === PRONUNCIATION_LEXICON) compiled.set(locale, entries);
  }
  let out = text;
  for (const { pattern, spoken } of entries) out = out.replace(pattern, () => spoken);
  return out.replace(/ {2,}/g, " ");
}
