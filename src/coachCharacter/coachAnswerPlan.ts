/**
 * Decides what evidence an assistant question actually needs.
 * A time range, a named shot, a measurement, and a training-plan question
 * are not the same request, so they must not all attach the latest clip.
 */
export type CoachPlanLocale = "en" | "es";

export type AnswerFamily =
  | "compare"
  | "pro"
  | "window"
  | "dialogue"
  | "pattern"
  | "biomechanics"
  | "mistake"
  | "shot"
  | "clip";

export type ClipPick = "best_score" | "best_technique" | "worst_score" | "latest";

export type CoachWindow = {
  since: Date | null;
  /** Exclusive end. Set for "last week" / "last month" so the current period is not included. */
  until: Date | null;
  label: string;
  limit: number | null;
};

export type AnswerPlan = {
  family: AnswerFamily;
  /** Pull a library of clips (a week, a month, trends, drills grounded in history). */
  needsLibrary: boolean;
  showVideo: boolean;
  showScore: boolean;
  showBreakdown: boolean;
  showMotion: boolean;
  includePro: boolean;
  pick: ClipPick;
  shotQuery: string | null;
  theme: string | null;
  window: CoachWindow | null;
};

const SHOTS: Array<{ query: string; re: RegExp }> = [
  { query: "forehand volley", re: /\bforehand\s+volley\b|\bvolley\s+de\s+derecha\b/i },
  { query: "backhand volley", re: /\bbackhand\s+volley\b|\bvolley\s+de\s+rev[eé]s\b/i },
  { query: "bandeja", re: /\bbandeja\b/i },
  { query: "vibora", re: /\bv[ií]bora\b|\bvibora\b/i },
  { query: "smash", re: /\bsmash(es)?\b|\bremates?\b/i },
  { query: "forehand", re: /\bforehand\b|\bderecha\b/i },
  { query: "backhand", re: /\bbackhand\b|\brev[eé]s\b/i },
  { query: "volley", re: /\bvolley\b|\bvolea\b/i },
  { query: "serve", re: /\bserve\b|\bsaque\b/i },
  { query: "lob", re: /\blob\b|\bglobo\b/i },
  { query: "bajada", re: /\bbajada\b/i },
  { query: "chiquita", re: /\bchiquita\b/i },
];

const THEMES: Array<{ theme: string; re: RegExp }> = [
  { theme: "elbow", re: /\belbow\b|\bcodo\b/i },
  { theme: "shoulder", re: /\bshoulder\b|\bhombro\b/i },
  { theme: "torso", re: /\btorso\b|\btrunk\b|\brotaci[oó]n\b/i },
  { theme: "wrist", re: /\bwrist\b|\bmu[nñ]eca\b/i },
  { theme: "racket face", re: /\bracket\s+face\b|\bopen\b.*\bclosed\b|\bcara\s+de\s+la\s+pala\b/i },
  { theme: "contact", re: /\bcontact\s+point\b|\bcontact\b|\bimpacto\b/i },
  { theme: "footwork", re: /\bfootwork\b|\bfeet\b|\bfoot\b|\bweight\b|\bpies\b|\bpeso\b/i },
  { theme: "kinetic chain", re: /\bkinetic\s+chain\b|\bcadena\s+cin[eé]tica\b/i },
  { theme: "racket preparation", re: /\bracket\s+prep|\bpreparation\b|\bpreparaci[oó]n\b/i },
];

const COMPARE_WORD =
  /\b(compare|comparison|vs\.?|versus|against|diferencia|compar(a|ar|aci[oó]n)|which\s+of\s+these\s+two|these\s+two\s+shots?|what\s+changed\s+between|between\s+these\s+(two\s+)?videos?)\b/i;
const PAIRWISE =
  /\b(which\s+of\s+these\s+two|these\s+two\s+shots?|which\s+(one|shot)\s+is\s+better|what\s+changed\s+between|between\s+these\s+(two\s+)?(videos?|shots?|clips?))\b/i;
const PRO =
  /\b(professional|pro\s+player|pro\s+level|pro\s+reference|professional\s+(player|reference|technique|level|example)|reference\s+(technique|player|clip|video|shot|example)|the\s+reference|jugador\s+profesional|referencia(\s+profesional)?|nivel\s+profesional|like\s+a\s+pro|closer\s+to\s+(the\s+)?(pro|professional))\b/i;
const DIALOGUE =
  /\b(drill|drills|training\s+plan|seven[- ]day|7[- ]day|practice\s+tomorrow|next\s+training|what\s+should\s+i\s+(focus|practice|stop|work)|stop\s+doing|simple\s+language|fastest\s+way|give\s+me\s+three|without\s+changing|ejercicios?|plan\s+de\s+entrenamiento|qu[eé]\s+debo\s+(practicar|dejar|trabajar))\b/i;
const TREND =
  /\b(improv(e|ed|ing|ement|ements)?|worse|worsen(ing)?|getting\s+worse|progress|biggest\s+improvements?|same\s+mistakes?|corrected|successfully\s+corrected|remained\s+unchanged|unchanged|since\s+(i\s+)?started|first\s+upload|mejorad[oa]|empeor|progreso|corregid)\b/i;
const PERIOD_SUMMARY = /\b(how\s+(was|were|did)|what\s+about|c[oó]mo\s+(fueron|me\s+fue)|qu[eé]\s+tal)\b/i;
const BEST = /\b(best|highest|top\s+score|mejor\s+(puntuaci[oó]n|score|golpe)?)\b/i;
const WORST = /\b(worst|weakest|lowest|peor)\b/i;
const PATTERN =
  /\b(inconsistent|consistency|consistent|most\s+frequently|across\s+my\s+last|patterns?|sometimes|end\s+of\s+(training|practice)|losing\s+technique|m[aá]s\s+frecuente)\b/i;
const BIO =
  /\b(how\s+many\s+degrees|degrees?|rotat(e|ing|ion)|generating\s+enough\s+power|power|contact\s+point|kinetic\s+chain|racket\s+face|too\s+open|too\s+closed|weight\s+transfer|technique\s+breaks\s+down|exact\s+moment|elbow|shoulder|torso|wrist|knee|racket\s+(speed|moved)|ball[- ]contact|grados|rotaci[oó]n|potencia|cadena)\b/i;
const MISTAKE =
  /\b(biggest\s+mistake|mistake\s+in\s+this\s+shot|which\s+mistake|causing\s+my|lose\s+balance|correct\s+first|needs?\s+work|technical\s+error|error\s+t[eé]cnico|qu[eé]\s+falla)\b/i;
const GREETING = /^(hi|hey|hello|thanks|thank you|ok|okay|hola|gracias)\b/i;

const WORD_NUM: Record<string, number> = {
  a: 1,
  an: 1,
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
};

function amount(raw: string): number | null {
  const t = raw.trim().toLowerCase();
  if (/^\d+$/.test(t)) return Number(t);
  return WORD_NUM[t] ?? null;
}

function atMidnight(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/** Monday 00:00 of the week containing `d` (server local time, same as the rest of the coach). */
function startOfWeek(d: Date): Date {
  const x = atMidnight(d);
  const mondayOffset = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - mondayOffset);
  return x;
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function L(locale: CoachPlanLocale, en: string, es: string): string {
  return locale === "es" ? es : en;
}

export function extractPlannedShot(message: string): string | null {
  for (const shot of SHOTS) {
    if (shot.re.test(message)) return shot.query;
  }
  return null;
}

export function extractPlannedTheme(message: string): string | null {
  for (const theme of THEMES) {
    if (theme.re.test(message)) return theme.theme;
  }
  return null;
}

/** Calendar window the question names. Null when the question is not about a period. */
export function parseAnswerWindow(message: string, locale: CoachPlanLocale): CoachWindow | null {
  const now = new Date();
  const lastN = message.match(
    /\b(?:last|past|ultim[oa]s?)\s+(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(shots?|smashes?|volleys?|videos?|uploads?|analyses|golpes?|remates?|voleas?)\b/i
  );
  if (lastN) {
    const n = amount(lastN[1]!);
    if (n) {
      return {
        since: null,
        until: null,
        label: L(locale, `last ${n} matching shots`, `últimos ${n} golpes`),
        limit: Math.min(n, 60),
      };
    }
  }
  if (/\b(last|past|previous)\s+week\b|\bsemana\s+pasada\b/i.test(message)) {
    const thisWeek = startOfWeek(now);
    const prev = new Date(thisWeek);
    prev.setDate(prev.getDate() - 7);
    return { since: prev, until: thisWeek, label: L(locale, "last week", "semana pasada"), limit: null };
  }
  if (/\bthis\s+week\b|\besta\s+semana\b/i.test(message)) {
    return { since: startOfWeek(now), until: null, label: L(locale, "this week", "esta semana"), limit: null };
  }
  if (/\b(last|past|previous)\s+month\b|\bmes\s+pasado\b|\b[uú]ltimo\s+mes\b/i.test(message)) {
    const thisMonth = startOfMonth(now);
    const prev = new Date(thisMonth);
    prev.setMonth(prev.getMonth() - 1);
    return { since: prev, until: thisMonth, label: L(locale, "last month", "mes pasado"), limit: null };
  }
  if (/\b(this\s+month|este\s+mes)\b/i.test(message)) {
    return { since: startOfMonth(now), until: null, label: L(locale, "this month", "este mes"), limit: null };
  }
  const days = message.match(/\b(?:last|past|over\s+the\s+(?:last|past)|ultim[oa]s?)\s+(\d+)\s+days?\b|\b(\d+)\s*days?\b/i);
  if (days) {
    const n = Number(days[1] || days[2]);
    if (n > 0 && n < 400) {
      const since = new Date(now);
      since.setDate(since.getDate() - n);
      return { since, until: null, label: L(locale, `last ${n} days`, `últimos ${n} días`), limit: null };
    }
  }
  if (/\b(today|hoy|todays|today's)\b/i.test(message) && !/\bago\b|\bhace\b/i.test(message)) {
    return { since: atMidnight(now), until: null, label: L(locale, "today", "hoy"), limit: null };
  }
  if (/\b(past\s+month|over\s+the\s+past\s+month)\b/i.test(message)) {
    const since = new Date(now);
    since.setDate(since.getDate() - 30);
    return { since, until: null, label: L(locale, "the past month", "el último mes"), limit: null };
  }
  return null;
}

function base(partial: Partial<AnswerPlan> & Pick<AnswerPlan, "family">): AnswerPlan {
  return {
    needsLibrary: false,
    showVideo: false,
    showScore: false,
    showBreakdown: false,
    showMotion: false,
    includePro: false,
    pick: "latest",
    shotQuery: null,
    theme: null,
    window: null,
    ...partial,
  };
}

/**
 * One plan per question. Earlier families win so "compare my bandeja with the pro"
 * stays a pro compare, and "best score last week" stays inside last week.
 */
export function planAnswer(message: string, locale: CoachPlanLocale = "en"): AnswerPlan {
  const text = message.trim();
  const shotQuery = extractPlannedShot(text);
  const theme = extractPlannedTheme(text);
  const window = parseAnswerWindow(text, locale);
  const datedCompare = /\b(day|days|week|weeks|month|months|d[ií]as?|semanas?|meses?)\s+ago\b|\bhace\s+/i.test(text);

  if ((COMPARE_WORD.test(text) && datedCompare && shotQuery) || PAIRWISE.test(text)) {
    return base({
      family: "compare",
      showVideo: true,
      showScore: true,
      showBreakdown: true,
      shotQuery,
      theme,
      window,
    });
  }

  if (PRO.test(text)) {
    return base({
      family: "pro",
      showVideo: true,
      showScore: true,
      showBreakdown: true,
      showMotion: true,
      includePro: true,
      pick: shotQuery ? "latest" : "latest",
      shotQuery,
      theme,
      window,
    });
  }

  if (window && (PERIOD_SUMMARY.test(text) || BEST.test(text) || WORST.test(text) || /\bshots?\b|\bgolpes?\b/i.test(text))) {
    const pick: ClipPick = WORST.test(text)
      ? "worst_score"
      : BEST.test(text) || PERIOD_SUMMARY.test(text)
        ? "best_score"
        : "latest";
    const technique = /\btechnique\b|\bt[eé]cnica\b/i.test(text) && BEST.test(text);
    return base({
      family: "window",
      needsLibrary: true,
      showVideo: true,
      showScore: true,
      showBreakdown: true,
      pick: technique ? "best_technique" : pick,
      shotQuery,
      theme,
      window,
    });
  }

  if (window && (TREND.test(text) || /\blast\s+(five|ten|\d+)\b/i.test(text))) {
    const rank = /\b(which\s+one|best\s+technique|mejor\s+t[eé]cnica)\b/i.test(text);
    return base({
      family: "window",
      needsLibrary: true,
      showVideo: rank,
      showScore: rank,
      showBreakdown: rank,
      pick: rank ? "best_technique" : "latest",
      shotQuery,
      theme,
      window,
    });
  }

  if (TREND.test(text) || (window && !BIO.test(text) && !MISTAKE.test(text))) {
    return base({
      family: "window",
      needsLibrary: true,
      showVideo: false,
      showScore: false,
      pick: "latest",
      shotQuery,
      theme,
      window: window ?? {
        since: daysAgo(90),
        until: null,
        label: L(locale, "last 90 days", "últimos 90 días"),
        limit: null,
      },
    });
  }

  if (DIALOGUE.test(text)) {
    return base({
      family: "dialogue",
      needsLibrary: true,
      showVideo: false,
      shotQuery,
      theme,
      window: window ?? {
        since: daysAgo(90),
        until: null,
        label: L(locale, "last 90 days", "últimos 90 días"),
        limit: null,
      },
    });
  }

  if (PATTERN.test(text)) {
    const example = /\b(why|inconsistent|a\s+veces)\b/i.test(text) && !!shotQuery;
    return base({
      family: "pattern",
      needsLibrary: true,
      showVideo: example,
      showScore: example,
      pick: "worst_score",
      shotQuery,
      theme,
      window: window ?? {
        since: daysAgo(90),
        until: null,
        label: L(locale, "last 90 days", "últimos 90 días"),
        limit: null,
      },
    });
  }

  if (BIO.test(text)) {
    return base({
      family: "biomechanics",
      showVideo: true,
      showScore: false,
      showBreakdown: false,
      showMotion: true,
      includePro: /\breference\b|\bpro\b/i.test(text),
      pick: "latest",
      shotQuery,
      theme,
    });
  }

  if (MISTAKE.test(text) || (shotQuery && /\bneeds?\s+work\b|\ba\s+mejorar\b/i.test(text))) {
    return base({
      family: shotQuery ? "shot" : "mistake",
      showVideo: true,
      showScore: true,
      showBreakdown: true,
      showMotion: !!theme,
      pick: "latest",
      shotQuery,
      theme,
    });
  }

  if (shotQuery) {
    return base({
      family: "shot",
      showVideo: true,
      showScore: true,
      showBreakdown: true,
      showMotion: !!theme,
      pick: "latest",
      shotQuery,
      theme,
    });
  }

  if (GREETING.test(text) && text.length < 40) {
    return base({ family: "dialogue", needsLibrary: false, showVideo: false });
  }

  return base({
    family: "clip",
    showVideo: true,
    showScore: true,
    showBreakdown: true,
    pick: "latest",
    theme,
  });
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}
