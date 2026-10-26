import type { TechniqueAnalysisMetrics } from "../db/schema";
import {
  readUserDeclaredShot,
  resolveCanonicalShotFromMetrics,
  stripTrainClipIndexSuffix,
} from "../train/trainShotDisplay";
export type CoachLocale = "en" | "es";

/** Minimal analysis facts needed for history (avoids circular import with coachContext). */
export type HistoryAnalysisFacts = {
  analysisId: string;
  source: "selected" | "latest" | "compare_current" | "compare_prior";
  shotName: string | null;
  videoUrl: string | null;
  score: number | null;
  rating: string | null;
  breakdown: { technique: number | null; outcome: number | null; tactics: number | null };
  focusArea: string | null;
  strengths: string[];
  corrections: string[];
  technicalErrors: string[];
  observations: string[];
  diagnosis: string | null;
  /** Non-null measured motion lines only (never invented). */
  measuredMotion: string[];
  citeOk: boolean;
  /** Top pro-library neighbor treated as the professional reference clip. */
  proReference: {
    label: string;
    skillLevel: string | null;
    distance: number | null;
    trainSampleId: string | null;
  } | null;
  /** You-vs-pro joint lines when pose align succeeded. */
  vsProJoints: string[];
  createdAt: string;
};

export type CoachHistorySession = HistoryAnalysisFacts & {
  technicalErrors: string[];
  prepToImpactMs: number | null;
};

export type CoachHistoryFacts = {
  /** High-level ask we detected. */
  intent:
    | "trend"
    | "rank"
    | "mistakes"
    | "theme"
    | "theme_compare"
    | "first_vs_last"
    | "corrected"
    | "best_shot_type"
    | "catalog"
    | "goal"
    | "weakness"
    | "consistency"
    | "general";
  windowLabel: string;
  shotQuery: string | null;
  theme: string | null;
  sessions: CoachHistorySession[];
  /** Short factual bullets the model must use. */
  notes: string[];
};

/**
 * History = trends / multi-session / catalog recall.
 * Do NOT match bare body-part themes alone (elbow, footwork, …) — those are single-shot
 * biomechanics questions unless paired with progress/catalog language below.
 */
const HISTORY_INTENT =
  /\b(improv(e|ed|ing|ement|ements)?|worse|worsen(ing)?|progress|last\s+\d+|past\s+\d+|over\s+the\s+(last|past)|30\s*days?|this\s+month|next\s+month|based\s+on\s+my\s+(progress|history)|my\s+history|since\s+(i\s+)?started|previous\s+videos?|same\s+mistakes?|remained\s+unchanged|unchanged|corrected|biggest\s+improvements?|last\s+five|first\s+upload|most\s+recent\s+upload|worst\s+shot|best\s+shot|all\s+(my\s+)?shots?|shot\s+catalog|holding\s+back|weakness|next\s+(technical\s+)?goal|technical\s+goal|raise\s+my|from\s+\d{1,3}\s+to\s+\d{1,3}|performance\s+score|less\s+consistent|consistenc(y|ies)|end\s+of\s+(training|practice|session)|toward\s+the\s+end|improving\s+faster|mejorad[oa]|empeor|progreso|este\s+mes|pr[oó]ximo\s+mes|ultim[oa]s?\s+\d+|primer\s+(video|upload)|errores?\s+corregid|golpe\s+peor)\b/i;

const THEME_PATTERNS: Array<{ theme: string; re: RegExp }> = [
  { theme: "elbow", re: /\belbow\b|\bcodo\b/i },
  { theme: "racket preparation", re: /\bracket\s+prep|\bpreparation\b|\bprep(araci[oó]n)?\b/i },
  { theme: "footwork", re: /\bfootwork\b|\bpies\b|\bfoot\s*work\b|\brecovery\s+steps?\b/i },
  { theme: "upper-body", re: /\bupper[- ]?body\b|\bshoulder\b|\bwrist\b|\bracket\s+face\b|\btorso\b|\bhombro\b|\bmu[nñ]eca\b/i },
  { theme: "technique", re: /\btechnique\b|\bt[eé]cnica\b/i },
];

const WORD_NUM: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  una: 1,
  un: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
};

/** Extra aliases for history (broader than pairwise compare). */
const HISTORY_SHOT_ALIASES: Array<{ query: string; patterns: RegExp[] }> = [
  { query: "forehand", patterns: [/\bforehand\b/i, /\bderecha\b/i] },
  { query: "backhand", patterns: [/\bbackhand\b/i, /\brev[eé]s\b/i] },
  { query: "smash", patterns: [/\bsmash(es)?\b/i, /\bremates?\b/i] },
  { query: "bandeja", patterns: [/\bbandeja\b/i] },
  { query: "vibora", patterns: [/\bv[ií]bora\b/i, /\bvibora\b/i] },
  { query: "volley", patterns: [/\bvolley\b/i, /\bvolea\b/i] },
  { query: "serve", patterns: [/\bserve\b/i, /\bsaque\b/i] },
  { query: "lob", patterns: [/\blob\b/i, /\bglobo\b/i] },
  { query: "bajada", patterns: [/\bbajada\b/i] },
];

const FOOTWORK_RE = /\bfoot|\bstep|\brecovery|\bsplit\s*step|\bbalance|\bpies\b|\bready\s+position\b/i;
const UPPER_BODY_RE =
  /\bshoulder|\belbow|\bwrist|\bracket|\btorso|\barm\b|\bcodo\b|\bhombro\b|\bmu[nñ]eca\b|\bracket\s+face\b|\bbackswing\b|\bprep/i;

export function wantsHistoryContext(message: string): boolean {
  return HISTORY_INTENT.test(message);
}

function parseAmount(raw: string): number | null {
  const t = raw.trim().toLowerCase();
  if (/^\d+$/.test(t)) return Number(t);
  return WORD_NUM[t] ?? null;
}

export function extractHistoryShotQuery(message: string): string | null {
  for (const alias of HISTORY_SHOT_ALIASES) {
    if (alias.patterns.some((p) => p.test(message))) return alias.query;
  }
  return null;
}

export function extractTheme(message: string): string | null {
  for (const t of THEME_PATTERNS) {
    if (t.re.test(message)) return t.theme;
  }
  return null;
}

export function parseHistoryWindow(message: string): { since: Date | null; label: string; limit: number | null } {
  const lastN = message.match(
    /\b(?:last|past|ultim[oa]s?)\s+(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(shots?|smashes?|videos?|uploads?|analyses|golpes?|remates?)\b/i
  );
  if (lastN) {
    const n = parseAmount(lastN[1]!);
    if (n) return { since: null, label: `last ${n} matching shots`, limit: Math.min(n, 60) };
  }
  const days = message.match(/\b(?:last|past|over the (?:last|past)|ultim[oa]s?)\s+(\d+)\s+days?\b/i);
  if (days) {
    const n = Number(days[1]);
    const since = new Date();
    since.setDate(since.getDate() - n);
    return { since, label: `last ${n} days`, limit: null };
  }
  if (/\b(next month|pr[oó]ximo mes|over the next month|for the next month)\b/i.test(message)) {
    const since = new Date();
    since.setDate(since.getDate() - 90);
    return { since, label: "last 90 days (to plan next month)", limit: null };
  }
  if (/\b(this month|este mes|past month|last month|ultimo mes|último mes)\b/i.test(message)) {
    const since = new Date();
    since.setDate(1);
    since.setHours(0, 0, 0, 0);
    return { since, label: "this month", limit: null };
  }
  if (/\b(since (i )?started|desde que (empec[eé]|uso)|first upload|primer (video|upload))\b/i.test(message)) {
    return { since: null, label: "since you started on AXEVO", limit: null };
  }
  if (/\b(30\s*days?|treinta d[ií]as)\b/i.test(message)) {
    const since = new Date();
    since.setDate(since.getDate() - 30);
    return { since, label: "last 30 days", limit: null };
  }
  // Catalog / goal / theme-compare: look further back so all shot families appear.
  if (
    /\b(worst\s+shot|best\s+shot|all\s+(my\s+)?shots?|shot\s+catalog|next\s+(technical\s+)?goal|holding\s+back|weakness|based\s+on\s+my\s+(progress|history)|my\s+history|raise\s+my|from\s+\d{1,3}\s+to\s+\d{1,3}|improving\s+faster|footwork|upper[- ]?body|less\s+consistent|consistenc(y|ies)|end\s+of\s+(training|practice|session))\b/i.test(
      message
    )
  ) {
    const since = new Date();
    since.setDate(since.getDate() - 180);
    return { since, label: "last 180 days (full catalog window)", limit: null };
  }
  // default for history questions: last 90 days of library
  const since = new Date();
  since.setDate(since.getDate() - 90);
  return { since, label: "last 90 days", limit: null };
}

export function extractScoreGoal(message: string): { from: number | null; to: number | null } {
  const both = message.match(/\bfrom\s+(\d{1,3})\s+to\s+(\d{1,3})\b/i);
  if (both) return { from: Number(both[1]), to: Number(both[2]) };
  const toOnly = message.match(/\b(?:raise|get|bring)\b[^.]{0,40}\bto\s+(\d{1,3})\b/i);
  if (toOnly) return { from: null, to: Number(toOnly[1]) };
  return { from: null, to: null };
}

export function detectHistoryIntent(message: string): CoachHistoryFacts["intent"] {
  if (/\b(first upload|primer (video|upload)|most recent upload|ultim[oa] upload|último upload)\b/i.test(message)) {
    return "first_vs_last";
  }
  if (
    /\b(worst\s+shot|best\s+shot|all\s+(my\s+)?shots?|shot\s+catalog|which\s+shot\s+(is|are)\s+(my\s+)?(worst|best)|golpe\s+peor)\b/i.test(
      message
    )
  ) {
    return "catalog";
  }
  if (/\b(holding\s+back|weakness|overall\s+performance|performance\s+score)\b/i.test(message)) {
    return "weakness";
  }
  if (
    /\b(next\s+(technical\s+)?goal|technical\s+goal|raise\s+my|from\s+\d{1,3}\s+to\s+\d{1,3}|work\s+on\s+over\s+the\s+next|what\s+should\s+i\s+work\s+on|based\s+on\s+my\s+(progress|history))\b/i.test(
      message
    )
  ) {
    return "goal";
  }
  if (
    /\b(footwork\b.*\b(upper[- ]?body|shoulder|wrist|elbow)|((upper[- ]?body|shoulder|wrist|elbow).*\bfootwork)|improving\s+faster\s+in)\b/i.test(
      message
    )
  ) {
    return "theme_compare";
  }
  if (
    /\b(less\s+consistent|consistenc(y|ies)|end\s+of\s+(training|practice|session)|toward\s+the\s+end|end\s+of\s+the\s+(session|day))\b/i.test(
      message
    )
  ) {
    return "consistency";
  }
  if (
    /\b(same mistakes|previous videos|errores?\s+igual|mismos errores|remained\s+unchanged|unchanged|mistake\s+has\s+remained)\b/i.test(
      message
    )
  ) {
    return "mistakes";
  }
  if (/\b(successfully corrected|corrected|corregid[oa]s?)\b/i.test(message)) {
    return "corrected";
  }
  if (/\b(which shot has improved|improved the most|golpe.*mejorad)\b/i.test(message)) {
    return "best_shot_type";
  }
  if (/\b(last five|which one had|compar(e|a).*(five|cinco))\b/i.test(message)) {
    return "rank";
  }
  if (/\b(improv\w*|worse|worsen\w*|progress|biggest improvements?|mejorad\w*|empeor\w*)\b/i.test(message)) {
    return "trend";
  }
  if (extractTheme(message)) return "theme";
  return "general";
}

function normalizeToken(raw: string): string {
  return stripTrainClipIndexSuffix(raw)
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function historyShotMatches(
  metrics: TechniqueAnalysisMetrics | null | undefined,
  query: string
): boolean {
  const q = normalizeToken(query);
  if (!q) return false;
  const declared = readUserDeclaredShot(metrics as Record<string, unknown> | null);
  const candidates: string[] = [];
  if (declared?.shotLabel) candidates.push(declared.shotLabel);
  if (declared?.strokePreset) candidates.push(declared.strokePreset.replace(/_/g, " "));
  const canonical = resolveCanonicalShotFromMetrics(metrics as Record<string, unknown> | null);
  if (canonical.source !== "fallback" && canonical.shotName) candidates.push(canonical.shotName);
  return candidates.some((c) => {
    const n = normalizeToken(c);
    return n === q || n.includes(q) || q.includes(n);
  });
}

function stringList(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .map((s) => s.replace(/\[\[|\]\]/g, "").trim())
    .slice(0, max);
}

function prepMs(metrics: TechniqueAnalysisMetrics | null | undefined): number | null {
  const bio = (metrics as Record<string, unknown> | null | undefined)?.biomechanics_summary;
  if (!bio || typeof bio !== "object") return null;
  const timing = (bio as { timing?: { prep_to_impact_ms?: unknown } }).timing;
  const v = timing?.prep_to_impact_ms;
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null;
}

function technicalErrors(metrics: TechniqueAnalysisMetrics | null | undefined, locale: CoachLocale): string[] {
  const ai = metrics?.ai_analysis as Record<string, unknown> | null | undefined;
  if (!ai) return [];
  const loc = (ai[locale] ?? ai.en) as Record<string, unknown> | undefined;
  return stringList(loc?.technical_errors, 4);
}

function normPhrase(s: string): string {
  return s
    .toLowerCase()
    .replace(/\[\[|\]\]/g, "")
    .replace(/[^a-z0-9áéíóúñ\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function mentionsTheme(text: string, theme: string | null): boolean {
  if (!theme) return true;
  if (theme === "elbow") return /\belbow\b|\bcodo\b/i.test(text);
  if (theme === "racket preparation") return /\bprep|\bracket|\bpreparation|\bbackswing\b/i.test(text);
  if (theme === "footwork") return FOOTWORK_RE.test(text);
  if (theme === "upper-body") return UPPER_BODY_RE.test(text);
  if (theme === "technique") return true;
  return text.toLowerCase().includes(theme.toLowerCase());
}

type ShotFamilyStat = {
  shot: string;
  count: number;
  avg: number;
  latest: number | null;
  topErrors: string[];
  topFixes: string[];
  focusAreas: string[];
};

function shotFamilyStats(chrono: CoachHistorySession[]): ShotFamilyStat[] {
  const byShot = new Map<
    string,
    { scores: number[]; errors: string[]; fixes: string[]; focuses: string[]; latest: number | null }
  >();
  for (const s of chrono) {
    const key = (s.shotName || "unknown").trim() || "unknown";
    const bucket = byShot.get(key) ?? {
      scores: [],
      errors: [],
      fixes: [],
      focuses: [],
      latest: null,
    };
    if (s.score != null) {
      bucket.scores.push(s.score);
      bucket.latest = s.score;
    }
    for (const e of s.technicalErrors) bucket.errors.push(e);
    for (const c of s.corrections) bucket.fixes.push(c);
    if (s.focusArea) bucket.focuses.push(s.focusArea);
    byShot.set(key, bucket);
  }
  const out: ShotFamilyStat[] = [];
  for (const [shot, b] of byShot) {
    if (!b.scores.length) continue;
    const avg = Math.round(b.scores.reduce((a, n) => a + n, 0) / b.scores.length);
    out.push({
      shot,
      count: b.scores.length,
      avg,
      latest: b.latest,
      topErrors: uniquePhrases(b.errors, 3),
      topFixes: uniquePhrases(b.fixes, 3),
      focusAreas: uniquePhrases(b.focuses, 3),
    });
  }
  return out.sort((a, b) => a.avg - b.avg);
}

function uniquePhrases(items: string[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const k = normPhrase(raw);
    if (k.length < 8 || seen.has(k.slice(0, 48))) continue;
    seen.add(k.slice(0, 48));
    out.push(raw.replace(/\[\[|\]\]/g, "").trim());
    if (out.length >= max) break;
  }
  return out;
}

function pushCatalogDigest(notes: string[], chrono: CoachHistorySession[]) {
  const families = shotFamilyStats(chrono);
  if (!families.length) {
    notes.push("Shot catalog: no scored shot families in this window.");
    return families;
  }
  notes.push(
    `Shot catalog (${families.length} families): ` +
      families
        .map((f) => `${f.shot} avg ${f.avg}/100 (n=${f.count}, latest ${f.latest ?? "n/a"})`)
        .join(" | ")
  );
  const worst = families[0]!;
  const best = families[families.length - 1]!;
  notes.push(
    `Lowest-scoring shot family: ${worst.shot} (avg ${worst.avg}/100, n=${worst.count}).` +
      (worst.topErrors.length ? ` Typical issues: ${worst.topErrors.join(" | ")}` : "") +
      (worst.topFixes.length ? ` Fixes to try: ${worst.topFixes.join(" | ")}` : "")
  );
  if (best.shot !== worst.shot) {
    notes.push(`Highest-scoring shot family: ${best.shot} (avg ${best.avg}/100, n=${best.count}).`);
  }
  return families;
}

type RowLike = {
  id: string;
  metrics: TechniqueAnalysisMetrics | null;
  createdAt: Date;
  videoUrl?: string | null;
};

export function toHistorySession(
  row: RowLike,
  locale: CoachLocale,
  facts: HistoryAnalysisFacts
): CoachHistorySession {
  return {
    ...facts,
    technicalErrors: facts.technicalErrors.length
      ? facts.technicalErrors
      : technicalErrors(row.metrics, locale),
    prepToImpactMs: prepMs(row.metrics),
  };
}

export function buildHistoryNotes(
  intent: CoachHistoryFacts["intent"],
  sessionsNewestFirst: CoachHistorySession[],
  shotQuery: string | null,
  theme: string | null,
  windowLabel: string,
  opts?: { scoreFrom?: number | null; scoreTo?: number | null }
): string[] {
  const notes: string[] = [];
  const n = sessionsNewestFirst.length;
  if (n === 0) {
    notes.push(
      shotQuery
        ? `No completed "${shotQuery}" analyses found in ${windowLabel}.`
        : `No completed analyses found in ${windowLabel}.`
    );
    return notes;
  }

  notes.push(`Recalled ${n} analysis(es) for ${windowLabel}${shotQuery ? ` filtered to "${shotQuery}"` : ""}.`);

  const chrono = [...sessionsNewestFirst].reverse(); // oldest → newest
  const scores = chrono.map((s) => s.score).filter((s): s is number => s != null);
  if (scores.length >= 2) {
    const early = scores.slice(0, Math.max(1, Math.ceil(scores.length / 3)));
    const late = scores.slice(-Math.max(1, Math.ceil(scores.length / 3)));
    const avg = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
    const a0 = avg(early);
    const a1 = avg(late);
    notes.push(
      `Score trend (early third avg ${a0} -> late third avg ${a1}): ${a1 >= a0 ? "improving" : "declining"} by ${Math.abs(a1 - a0)} points.`
    );
  } else if (scores.length === 1) {
    notes.push(`Only one scored session in range (score ${scores[0]}). Not enough samples for a strong trend.`);
  }

  const wantCatalog =
    !shotQuery &&
    (intent === "catalog" ||
      intent === "goal" ||
      intent === "weakness" ||
      intent === "best_shot_type" ||
      intent === "general");
  const families = wantCatalog || intent === "catalog" ? pushCatalogDigest(notes, chrono) : shotFamilyStats(chrono);

  if (intent === "rank" || intent === "trend") {
    const withTech = sessionsNewestFirst.filter((s) => s.breakdown.technique != null);
    if (withTech.length) {
      const best = [...withTech].sort(
        (a, b) => (b.breakdown.technique ?? 0) - (a.breakdown.technique ?? 0)
      )[0]!;
      notes.push(
        `Best technique score: ${best.breakdown.technique}/100 on ${best.createdAt.slice(0, 10)}${
          best.shotName ? ` (${best.shotName})` : ""
        }.`
      );
    }
  }

  if (intent === "first_vs_last" && chrono.length >= 2) {
    const first = chrono[0]!;
    const last = chrono[chrono.length - 1]!;
    notes.push(
      `First in range: ${first.createdAt.slice(0, 10)} score ${first.score ?? "n/a"}; most recent: ${last.createdAt.slice(0, 10)} score ${last.score ?? "n/a"}.`
    );
  }

  if (intent === "best_shot_type") {
    const deltas: Array<{ shot: string; delta: number; early: number; late: number; count: number }> = [];
    const byShot = new Map<string, number[]>();
    for (const s of chrono) {
      const key = (s.shotName || "unknown").toLowerCase();
      if (s.score == null) continue;
      const arr = byShot.get(key) ?? [];
      arr.push(s.score);
      byShot.set(key, arr);
    }
    for (const [shot, vals] of byShot) {
      if (vals.length < 2) continue;
      const early = vals[0]!;
      const late = vals[vals.length - 1]!;
      deltas.push({ shot, delta: late - early, early, late, count: vals.length });
    }
    deltas.sort((a, b) => b.delta - a.delta);
    if (deltas[0]) {
      const d = deltas[0];
      notes.push(
        `Largest score gain by shot family: ${d.shot} (${d.early} -> ${d.late}, d${d.delta > 0 ? "+" : ""}${d.delta}, n=${d.count}).`
      );
    } else {
      notes.push("Not enough repeated shot types to crown a biggest improver.");
    }
  }

  // Mistakes / corrections across time
  const olderHalf = chrono.slice(0, Math.max(1, Math.floor(chrono.length / 2)));
  const newerHalf = chrono.slice(Math.floor(chrono.length / 2));
  const bag = (sessions: CoachHistorySession[]) => {
    const set = new Set<string>();
    for (const s of sessions) {
      for (const e of [...s.technicalErrors, ...s.corrections]) {
        if (theme && !mentionsTheme(e, theme)) continue;
        const k = normPhrase(e);
        if (k.length > 12) set.add(k.slice(0, 80));
      }
    }
    return set;
  };
  const oldBag = bag(olderHalf);
  const newBag = bag(newerHalf);
  const recurring = [...oldBag].filter((k) => newBag.has(k)).slice(0, 5);
  const cleared = [...oldBag].filter((k) => !newBag.has(k)).slice(0, 5);
  const newIssues = [...newBag].filter((k) => !oldBag.has(k)).slice(0, 5);

  // Phrases that appear in many sessions (stable mistakes across last N uploads)
  const phraseHits = new Map<string, { count: number; sample: string }>();
  for (const s of chrono) {
    const seenInSession = new Set<string>();
    for (const e of [...s.technicalErrors, ...s.corrections]) {
      const k = normPhrase(e).slice(0, 80);
      if (k.length < 12 || seenInSession.has(k)) continue;
      seenInSession.add(k);
      const cur = phraseHits.get(k) ?? { count: 0, sample: e.replace(/\[\[|\]\]/g, "").trim() };
      cur.count += 1;
      phraseHits.set(k, cur);
    }
  }
  const sticky = [...phraseHits.values()]
    .filter((p) => p.count >= Math.max(2, Math.ceil(chrono.length * 0.35)))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  if (intent === "mistakes" || intent === "general" || intent === "trend" || intent === "catalog") {
    if (recurring.length) notes.push(`Recurring issues still showing up: ${recurring.join(" | ")}`);
    else notes.push("No clear repeated mistake phrases across older vs newer halves.");
  }
  if (intent === "mistakes" || intent === "weakness" || intent === "goal") {
    if (sticky.length) {
      notes.push(
        `Most persistent mistake phrases (appear in many uploads): ` +
          sticky.map((p) => `"${p.sample}" (in ${p.count}/${chrono.length})`).join(" | ")
      );
    } else {
      notes.push("No single mistake phrase dominates enough uploads to call it unchanged.");
    }
  }
  if (intent === "corrected" || intent === "general") {
    if (cleared.length) notes.push(`Issues that appear corrected (older half only): ${cleared.join(" | ")}`);
    else notes.push("Could not confirm cleared mistakes from text overlap alone.");
  }
  if (newIssues.length && (intent === "mistakes" || intent === "theme")) {
    notes.push(`Newer issues to watch: ${newIssues.join(" | ")}`);
  }

  if (intent === "weakness") {
    const worst = families[0];
    if (worst) {
      notes.push(
        `Primary performance drag candidate: ${worst.shot} (lowest avg ${worst.avg}/100).` +
          (worst.focusAreas.length ? ` Focus areas: ${worst.focusAreas.join(", ")}.` : "") +
          (worst.topErrors.length ? ` Issues: ${worst.topErrors.join(" | ")}` : "") +
          (worst.topFixes.length ? ` Suggested fixes from analyses: ${worst.topFixes.join(" | ")}` : "")
      );
    }
    const lowSessions = chrono.filter((s) => s.score != null && s.score < 70);
    const focusCount = new Map<string, number>();
    for (const s of lowSessions) {
      if (!s.focusArea) continue;
      focusCount.set(s.focusArea, (focusCount.get(s.focusArea) ?? 0) + 1);
    }
    const topFocus = [...focusCount.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topFocus) {
      notes.push(
        `Most common train focus on sub-70 scores: ${topFocus[0]} (${topFocus[1]} of ${lowSessions.length} low-score clips).`
      );
    }
  }

  if (intent === "goal" || intent === "catalog") {
    const worst = families[0];
    const scoreTo = opts?.scoreTo ?? null;
    const scoreFrom = opts?.scoreFrom ?? null;
    if (shotQuery && scores.length) {
      const latest = scores[scores.length - 1]!;
      const avg = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
      notes.push(
        `Target shot "${shotQuery}": latest score ${latest}/100, window avg ${avg}/100` +
          (scoreFrom != null ? `, player mentioned from ${scoreFrom}` : "") +
          (scoreTo != null ? `, aim toward ${scoreTo}` : "") +
          "."
      );
      const recentFixes = uniquePhrases(
        chrono.flatMap((s) => s.corrections),
        4
      );
      const recentErrors = uniquePhrases(
        chrono.flatMap((s) => s.technicalErrors),
        4
      );
      if (recentErrors.length) notes.push(`What has been going wrong on ${shotQuery}: ${recentErrors.join(" | ")}`);
      if (recentFixes.length) {
        notes.push(
          `Priority fixes to climb` +
            (scoreTo != null ? ` toward ${scoreTo}` : "") +
            `: ${recentFixes.join(" | ")}`
        );
      }
    } else if (worst) {
      notes.push(
        `Suggested next technical goal from catalog: improve ${worst.shot} (avg ${worst.avg}/100).` +
          (worst.topFixes.length ? ` Start with: ${worst.topFixes.join(" | ")}` : "") +
          (sticky[0] ? ` Persistent pattern across shots: "${sticky[0].sample}".` : "")
      );
    }
  }

  if (intent === "theme_compare") {
    const thirds = Math.max(1, Math.floor(chrono.length / 3));
    const early = chrono.slice(0, thirds);
    const late = chrono.slice(-thirds);
    const countTheme = (sessions: CoachHistorySession[], re: RegExp) => {
      let hits = 0;
      for (const s of sessions) {
        const blob = [...s.technicalErrors, ...s.corrections, ...s.strengths, s.diagnosis ?? ""].join(" ");
        if (re.test(blob)) hits += 1;
      }
      return hits;
    };
    const fwEarly = countTheme(early, FOOTWORK_RE);
    const fwLate = countTheme(late, FOOTWORK_RE);
    const upEarly = countTheme(early, UPPER_BODY_RE);
    const upLate = countTheme(late, UPPER_BODY_RE);
    notes.push(
      `Footwork coaching notes appeared on ${fwEarly} of ${early.length} early-third clips and ${fwLate} of ${late.length} late-third clips (counts of mentions, not scores out of 100).`
    );
    notes.push(
      `Upper-body coaching notes appeared on ${upEarly} of ${early.length} early-third clips and ${upLate} of ${late.length} late-third clips (counts of mentions, not scores out of 100).`
    );
    const fwDelta = fwLate - fwEarly;
    const upDelta = upLate - upEarly;
    // Fewer error mentions late can mean improvement; more strength+fewer issues is soft.
    notes.push(
      `Theme compare (soft signal from coaching text frequency, not a pure speed metric): footwork mention d ${fwDelta > 0 ? "+" : ""}${fwDelta}, upper-body mention d ${upDelta > 0 ? "+" : ""}${upDelta}. Prefer discussing which theme's corrections are clearing vs recurring; do not invent a percentage improvement rate.`
    );
    const fwRecurring = recurring.filter((k) => FOOTWORK_RE.test(k));
    const upRecurring = recurring.filter((k) => UPPER_BODY_RE.test(k));
    if (fwRecurring.length) notes.push(`Persistent footwork issues: ${fwRecurring.slice(0, 3).join(" | ")}`);
    if (upRecurring.length) notes.push(`Persistent upper-body issues: ${upRecurring.slice(0, 3).join(" | ")}`);
    if (cleared.length) {
      const fwCleared = cleared.filter((k) => FOOTWORK_RE.test(k));
      const upCleared = cleared.filter((k) => UPPER_BODY_RE.test(k));
      if (fwCleared.length) notes.push(`Footwork issues that look cleared: ${fwCleared.slice(0, 2).join(" | ")}`);
      if (upCleared.length) notes.push(`Upper-body issues that look cleared: ${upCleared.slice(0, 2).join(" | ")}`);
    }
  }

  if (intent === "consistency") {
    const byDay = new Map<string, number[]>();
    for (const s of chrono) {
      if (s.score == null) continue;
      const day = s.createdAt.slice(0, 10);
      const arr = byDay.get(day) ?? [];
      arr.push(s.score);
      byDay.set(day, arr);
    }
    let daysWithDrop = 0;
    let daysChecked = 0;
    const examples: string[] = [];
    for (const [day, vals] of byDay) {
      if (vals.length < 3) continue;
      daysChecked += 1;
      const mid = Math.floor(vals.length / 2);
      const earlyAvg = Math.round(vals.slice(0, mid).reduce((a, b) => a + b, 0) / Math.max(1, mid));
      const lateAvg = Math.round(vals.slice(mid).reduce((a, b) => a + b, 0) / Math.max(1, vals.length - mid));
      if (lateAvg + 3 < earlyAvg) {
        daysWithDrop += 1;
        if (examples.length < 3) {
          examples.push(`${day}: early avg ${earlyAvg} -> late avg ${lateAvg} (n=${vals.length})`);
        }
      }
    }
    if (daysChecked === 0) {
      notes.push(
        "Not enough same-day multi-upload sessions to judge end-of-training consistency. Need days with 3+ scored analyses."
      );
    } else {
      notes.push(
        `Same-day consistency check: ${daysWithDrop}/${daysChecked} training days showed a late-session score drop (>=3 pts).` +
          (examples.length ? ` Examples: ${examples.join(" | ")}` : "")
      );
    }
  }

  if (theme === "racket preparation") {
    const timed = chrono.filter((s) => s.prepToImpactMs != null);
    if (timed.length >= 2) {
      const first = timed[0]!.prepToImpactMs!;
      const last = timed[timed.length - 1]!.prepToImpactMs!;
      notes.push(
        `Prep-to-impact timing samples: ${timed.length} (older ${first}ms -> newer ${last}ms). Lower can mean faster preparation when pose timing is reliable.`
      );
    } else {
      notes.push(
        "Prep-to-impact timing is missing on most clips; use correction/error text about preparation instead of inventing speed numbers."
      );
    }
  }

  if (theme) {
    const themed = chrono
      .flatMap((s) =>
        [...s.technicalErrors, ...s.corrections, ...s.strengths].map((t) => ({
          t,
          d: s.createdAt.slice(0, 10),
        }))
      )
      .filter((x) => mentionsTheme(x.t, theme))
      .slice(0, 8);
    if (themed.length) {
      notes.push(`Notes mentioning ${theme}: ${themed.map((x) => `[${x.d}] ${x.t}`).join(" | ")}`);
    } else {
      notes.push(`No explicit "${theme}" notes in recalled corrections/errors - say evidence is limited.`);
    }
  }

  // Biggest improvements this month style
  if (/\bbiggest improvements?\b/i.test(windowLabel) || intent === "trend") {
    if (cleared.length) {
      notes.push(`Candidate improvements (issues no longer repeated): ${cleared.slice(0, 3).join(" | ")}`);
    }
  }

  notes.push(
    "Use only these recalled facts. Recommend goals/fixes only from shot-catalog stats and listed issues/fixes. NEVER invent measurements, angles, distances, racket speeds, or historical improvements. If a figure is missing, say we do not have that here — never criticize Xevo tracking, training data, or analysis quality."
  );
  return notes;
}
