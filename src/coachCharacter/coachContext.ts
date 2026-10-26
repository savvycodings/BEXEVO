import { and, desc, eq } from "drizzle-orm";
import { db, techniqueAnalysis, techniqueVideo } from "../db";
import type { TechniqueAnalysisMetrics } from "../db/schema";
import {
  buildSideReadings,
  computeSideMobilityAngles,
  midClipFrameIndex,
  nearestPoseRowByFrame,
  reconcileHeadAngles,
  type LandmarkPt,
} from "../technique/bodyMobilityAngles";
import { pickAlignedProPoseFrame } from "../technique/proTimeAlign";
import { getTrainSamplePoseSequence } from "../technique/trainRetrieval";
import {
  readUserDeclaredShot,
  resolveCanonicalShotFromMetrics,
  stripTrainClipIndexSuffix,
} from "../train/trainShotDisplay";
import {
  buildHistoryNotes,
  detectHistoryIntent,
  extractHistoryShotQuery,
  extractScoreGoal,
  extractTheme,
  historyShotMatches,
  parseHistoryWindow,
  toHistorySession,
  wantsHistoryContext,
  type CoachHistoryFacts,
} from "./coachHistory";
import { enrichMeasuredMotionWithDerived } from "./coachMotionMath";
import { planAnswer, type AnswerPlan, type CoachWindow } from "./coachAnswerPlan";

export type CoachLocale = "en" | "es";
export type { CoachHistoryFacts } from "./coachHistory";

export type CoachProReference = {
  /** Display name of the matched library clip (speak of this as the professional reference). */
  label: string;
  skillLevel: string | null;
  /** Cosine distance to that clip — lower = closer overall body motion. */
  distance: number | null;
  trainSampleId: string | null;
};

export type CoachAnalysisFacts = {
  analysisId: string;
  /**
   * Why this clip was chosen.
   * `selected` is the shot they opened. `latest` is the newest upload.
   * Window picks and named shots must not be labeled as the latest upload.
   */
  source: "selected" | "latest" | "compare_current" | "compare_prior" | "best_in_window" | "worst_in_window" | "matching_shot";
  shotName: string | null;
  /** Server-relative (`/technique/video/:id`) or absolute URL of the submitted clip. */
  videoUrl: string | null;
  score: number | null;
  rating: string | null;
  breakdown: { technique: number | null; outcome: number | null; tactics: number | null };
  focusArea: string | null;
  strengths: string[];
  corrections: string[];
  /** Coaching narrative from the analysis (pose/vision grounded text — not invented by Joy). */
  technicalErrors: string[];
  observations: string[];
  diagnosis: string | null;
  /** Only non-null measured biomechanics lines from biomechanics_summary. */
  measuredMotion: string[];
  /** True when pose metrics are reliable enough to cite degrees/ms/speeds. */
  citeOk: boolean;
  /** Top pro-library neighbor — treat as the professional / perfect reference for this shot. */
  proReference: CoachProReference | null;
  /** You-vs-pro joint compare lines (degrees + match%) when pose align worked. */
  vsProJoints: string[];
  createdAt: string;
};

export type CoachDayFacts = {
  count: number;
  averageScore: number | null;
  bestScore: number | null;
  sessions: Array<{ analysisId: string; score: number | null; focusArea: string | null; createdAt: string }>;
};

export type CoachCompareFacts = {
  shotQuery: string;
  priorLabel: string;
  current: CoachAnalysisFacts | null;
  prior: CoachAnalysisFacts | null;
  /** What is missing for a real two-shot compare. */
  missing: "none" | "current" | "prior" | "both";
};

/** The clip and the score the question actually asked for. The trace follows this, not the newest upload. */
export type CoachFocus = {
  showVideo: boolean;
  showScore: boolean;
  showBreakdown: boolean;
  showMotion: boolean;
  windowLabel: string | null;
  windowCount: number | null;
  windowAverage: number | null;
  windowBest: number | null;
  theme: string | null;
  analysis: CoachAnalysisFacts | null;
};

/** What the coach looked at before answering; rendered as the thinking trace in the app. */
export type CoachContext = {
  kind: "analysis" | "day" | "compare" | "history" | "none";
  analysis: CoachAnalysisFacts | null;
  day: CoachDayFacts | null;
  compare: CoachCompareFacts | null;
  history: CoachHistoryFacts | null;
  focus: CoachFocus | null;
};

const DAY_INTENT = /\b(today|todays|today's|day|daily|sessions?|hoy|d[ií]a|sesi[oó]n(es)?)\b/i;
/** Require a real compare cue — avoid matching casual words like "mejor" alone. */
const COMPARE_INTENT =
  /\b(compare|comparison|vs\.?|versus|against|diferencia|compar(a|ar|aci[oó]n)|which\s+of\s+these\s+two|these\s+two\s+shots?|what\s+changed\s+between|between\s+these\s+(two\s+)?videos?)\b/i;
/** Pairwise compare of two clips without a dated "X ago" (latest two matching / overall). */
const PAIRWISE_LATEST_INTENT =
  /\b(which\s+of\s+these\s+two|these\s+two\s+shots?|which\s+(one|shot)\s+is\s+better|what\s+changed\s+between|between\s+these\s+(two\s+)?(videos?|shots?|clips?))\b/i;
const MAX_COMPARE_SCAN = 400;
/** Accept a past bandeja within this many days of the requested date. */
const PRIOR_SLACK_MS = 4 * 24 * 60 * 60 * 1000;

const SHOT_ALIASES: Array<{ query: string; patterns: RegExp[] }> = [
  { query: "bandeja", patterns: [/\bbandeja\b/i] },
  { query: "vibora", patterns: [/\bv[ií]bora\b/i, /\bvibora\b/i] },
  { query: "smash", patterns: [/\bsmash\b/i, /\bremate\b/i] },
  { query: "forehand volley", patterns: [/\bforehand\s+volley\b/i, /\bvolley\s+de\s+derecha\b/i] },
  { query: "backhand volley", patterns: [/\bbackhand\s+volley\b/i, /\bvolley\s+de\s+rev[eé]s\b/i] },
  { query: "volley", patterns: [/\bvolley\b/i, /\bvolea\b/i] },
  { query: "serve", patterns: [/\bserve\b/i, /\bsaque\b/i] },
  { query: "lob", patterns: [/\blob\b/i, /\bglobo\b/i] },
  { query: "bajada", patterns: [/\bbajada\b/i] },
  { query: "chiquita", patterns: [/\bchiquita\b/i] },
];

/** Player wants to compare against the pro-library reference clip (perfect-shot standard). */
const PRO_COMPARE_INTENT =
  /\b(professional|pro\s+player|pro\s+level|pro\s+reference|professional\s+(player|reference|technique|level|example)|reference\s+(technique|player|clip|video|shot|example)|the\s+reference|jugador\s+profesional|referencia(\s+profesional)?|nivel\s+profesional|like\s+a\s+pro|closer\s+to\s+(the\s+)?(pro|professional))\b/i;

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
  una: 1,
  un: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
};

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null;
}

function stringList(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .map((s) => s.replace(/\[\[|\]\]/g, "").trim())
    .slice(0, max);
}

function oneText(v: unknown, maxChars = 420): string | null {
  if (typeof v !== "string") return null;
  const t = v.replace(/\[\[|\]\]/g, "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length > maxChars ? `${t.slice(0, maxChars - 1)}…` : t;
}

/** Pull only non-null measured fields — never invent placeholders. */
function measuredMotionLines(metrics: TechniqueAnalysisMetrics | null | undefined): {
  lines: string[];
  citeOk: boolean;
} {
  const bio = (metrics as Record<string, unknown> | null | undefined)?.biomechanics_summary as
    | Record<string, unknown>
    | null
    | undefined;
  if (!bio || typeof bio !== "object") return { lines: [], citeOk: false };
  const quality = bio.quality as { cite_ok?: unknown } | undefined;
  const citeOk = quality?.cite_ok === true;
  const timing = (bio.timing ?? {}) as Record<string, unknown>;
  const angles = (bio.angles_deg_proxy ?? {}) as Record<string, unknown>;
  const speeds = (bio.speeds_body ?? {}) as Record<string, unknown>;
  const contact = (bio.contact ?? {}) as Record<string, unknown>;
  const lines: string[] = [];
  const push = (label: string, v: unknown, unit = "") => {
    if (typeof v === "number" && Number.isFinite(v)) lines.push(`${label}: ${v}${unit}`);
  };
  push("prep_to_impact_ms", timing.prep_to_impact_ms, " ms");
  push("impact_to_follow_ms", timing.impact_to_follow_ms, " ms");
  push("impact_frame", timing.impact_frame);
  push("elbow_impact_deg", angles.elbow_impact_deg, "°");
  push("elbow_prep_deg", angles.elbow_prep_deg, "°");
  push("elbow_delta_deg", angles.elbow_delta_deg, "°");
  push("knee_impact_deg", angles.knee_impact_deg, "°");
  push("torso_sep_delta_deg", angles.torso_sep_delta_deg, "°");
  push("shoulder_hip_sep_impact_deg", angles.shoulder_hip_sep_impact_deg, "°");
  push("shoulder_hip_sep_prep_deg", angles.shoulder_hip_sep_prep_deg, "°");
  push("wrist_peak_body_per_s", speeds.wrist_peak_body_per_s, " body-lengths/s");
  push("wrist_path_prep_to_impact_body", speeds.wrist_path_prep_to_impact_body, " body-lengths");
  push("contact_window_ms", contact.contact_window_ms, " ms");
  if (typeof contact.ball_height_vs_hip === "string" && contact.ball_height_vs_hip !== "unknown") {
    lines.push(`ball_height_vs_hip: ${contact.ball_height_vs_hip}`);
  }
  if (typeof contact.yolo_contact_count === "number" && contact.yolo_contact_count > 0) {
    lines.push(`yolo_contact_count: ${contact.yolo_contact_count}`);
  }
  // When stored speeds/impact are null, derive proxies from pose + YOLO contacts.
  const enriched = enrichMeasuredMotionWithDerived(
    lines,
    metrics as Record<string, unknown> | null | undefined
  );
  return { lines: enriched, citeOk };
}

type AnalysisRow = {
  id: string;
  metrics: TechniqueAnalysisMetrics | null;
  createdAt: Date;
  videoUrl?: string | null;
};

function extractProReference(metrics: TechniqueAnalysisMetrics | null | undefined): CoachProReference | null {
  const retrieval = (metrics as Record<string, unknown> | null | undefined)?.retrieval as
    | {
        neighbors?: Array<{
          train_sample_id?: string;
          stroke_label?: string;
          stroke_name?: string;
          stroke_preset?: string;
          skill_level?: string;
          distance?: number;
        }>;
      }
    | undefined;
  const top = retrieval?.neighbors?.[0];
  if (!top) return null;
  const label =
    (typeof top.stroke_label === "string" && top.stroke_label.trim()) ||
    (typeof top.stroke_name === "string" && top.stroke_name.trim()) ||
    (typeof top.stroke_preset === "string" && top.stroke_preset.replace(/_/g, " ").trim()) ||
    "";
  if (!label) return null;
  return {
    label,
    skillLevel: typeof top.skill_level === "string" ? top.skill_level : null,
    distance: typeof top.distance === "number" && Number.isFinite(top.distance) ? top.distance : null,
    trainSampleId: typeof top.train_sample_id === "string" ? top.train_sample_id : null,
  };
}

/** You-vs-pro joint readings (same source as /body-mobility). */
async function computeVsProJoints(metrics: TechniqueAnalysisMetrics | null | undefined): Promise<string[]> {
  const m = metrics as Record<string, unknown> | null | undefined;
  if (!m) return [];
  const poseRaw = m.pose_data;
  const poseRows = Array.isArray(poseRaw)
    ? (poseRaw as Array<{ frame: number; landmarks?: Record<string, LandmarkPt | undefined> }>)
    : [];
  if (!poseRows.length) return [];

  const maxPoseFrame = Math.max(...poseRows.map((p) => (typeof p.frame === "number" ? p.frame : 0)));
  const totalFrames =
    typeof m.total_frames === "number" && m.total_frames > 0 ? m.total_frames : maxPoseFrame + 1;
  const midFrame = midClipFrameIndex(totalFrames);
  const userRow = nearestPoseRowByFrame(poseRows, midFrame);
  const userLm = (userRow?.landmarks ?? null) as Record<string, LandmarkPt | undefined> | null;

  const retrieval = m.retrieval as
    | { neighbors?: Array<{ train_sample_id?: string; stroke_label?: string }> }
    | undefined;
  const topId = retrieval?.neighbors?.[0]?.train_sample_id;
  if (!topId || typeof topId !== "string") return [];

  const proSeq = await getTrainSamplePoseSequence(topId);
  if (!proSeq?.length) return [];

  const userFrameIdx = typeof userRow?.frame === "number" ? userRow.frame : midFrame;
  const proFrame = pickAlignedProPoseFrame(userFrameIdx, totalFrames, proSeq);
  const idealLm = (proFrame?.landmarks ?? null) as Record<string, LandmarkPt | undefined> | null;
  if (!idealLm) return [];

  const youLeftRaw = computeSideMobilityAngles(userLm, "LEFT");
  const youRightRaw = computeSideMobilityAngles(userLm, "RIGHT");
  const youHead = reconcileHeadAngles(youLeftRaw, youRightRaw);
  const idealLeftRaw = computeSideMobilityAngles(idealLm, "LEFT");
  const idealRightRaw = computeSideMobilityAngles(idealLm, "RIGHT");
  const idealHead = reconcileHeadAngles(idealLeftRaw, idealRightRaw);

  const left = buildSideReadings(youHead.left, idealHead.left);
  const right = buildSideReadings(youHead.right, idealHead.right);
  const lines: string[] = [];
  for (const [side, readings] of [
    ["LEFT", left],
    ["RIGHT", right],
  ] as const) {
    for (const joint of ["shoulder", "wrist", "knee", "head"] as const) {
      const r = readings[joint];
      if (r.you == null || r.ideal == null || r.matchPct == null) continue;
      lines.push(
        `${side.toLowerCase()} ${joint}: you ${r.you}° / pro ${r.ideal}° (match ${r.matchPct}%${r.status ? `, ${r.status}` : ""})`
      );
    }
  }
  // Prefer high-match (already close to pro) and low-match (biggest gaps) for coaching.
  const ranked = lines
    .map((line) => {
      const mPct = line.match(/match (\d+)%/);
      return { line, pct: mPct ? Number(mPct[1]) : 0 };
    })
    .sort((a, b) => b.pct - a.pct);
  if (ranked.length <= 6) return ranked.map((x) => x.line);
  const top = ranked.slice(0, 3).map((x) => x.line);
  const topSet = new Set(top);
  const gaps = ranked
    .slice()
    .reverse()
    .filter((x) => !topSet.has(x.line))
    .slice(0, 3)
    .map((x) => x.line);
  return [...top, ...gaps];
}

async function analysisFacts(
  row: AnalysisRow,
  locale: CoachLocale,
  source: CoachAnalysisFacts["source"],
  opts?: { includeProJoints?: boolean }
): Promise<CoachAnalysisFacts> {
  const { id, metrics, createdAt } = row;
  const ai = metrics?.ai_analysis ?? null;
  const loc = ((ai?.[locale] ?? ai?.en ?? {}) as Record<string, unknown>) || {};
  const shot = resolveCanonicalShotFromMetrics(metrics as Record<string, unknown> | null);
  const motion = measuredMotionLines(metrics);
  const proReference = extractProReference(metrics);
  const vsProJoints = opts?.includeProJoints ? await computeVsProJoints(metrics) : [];
  return {
    analysisId: id,
    source,
    shotName: shot.source === "fallback" ? null : shot.shotName,
    videoUrl: row.videoUrl ?? null,
    score: num(ai?.score),
    rating: typeof ai?.rating === "string" ? ai.rating : null,
    breakdown: {
      technique: num(ai?.breakdown?.technique ?? ai?.technique_score),
      outcome: num(ai?.breakdown?.outcome ?? ai?.outcome_score),
      tactics: num(ai?.breakdown?.tactics ?? ai?.tactics_score),
    },
    focusArea: typeof ai?.primary_train_category === "string" ? ai.primary_train_category : null,
    strengths: stringList(loc.strengths, 4),
    corrections: stringList(loc.actionable_corrections, 4),
    technicalErrors: stringList(loc.technical_errors, 4),
    observations: stringList(loc.observations, 3),
    diagnosis: oneText(loc.diagnosis),
    measuredMotion: motion.lines,
    citeOk: motion.citeOk,
    proReference,
    vsProJoints,
    createdAt: createdAt.toISOString(),
  };
}

export function wantsDayContext(message: string): boolean {
  return DAY_INTENT.test(message);
}

export function wantsCompareContext(message: string): boolean {
  return COMPARE_INTENT.test(message);
}

export function wantsProCompareContext(message: string): boolean {
  return PRO_COMPARE_INTENT.test(message);
}

function parseAmount(raw: string): number | null {
  const t = raw.trim().toLowerCase();
  if (/^\d+$/.test(t)) return Number(t);
  return WORD_NUM[t] ?? null;
}

/** Relative past date from phrases like "three weeks ago" / "hace 3 semanas". */
export function parseRelativePast(message: string): { target: Date; label: string } | null {
  const en = message.match(
    /\b(a|an|one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(day|days|week|weeks|month|months)\s+ago\b/i
  );
  if (en) {
    const n = parseAmount(en[1]!);
    const unit = en[2]!.toLowerCase();
    if (n != null && n > 0) {
      const target = new Date();
      if (unit.startsWith("day")) target.setDate(target.getDate() - n);
      else if (unit.startsWith("week")) target.setDate(target.getDate() - n * 7);
      else target.setMonth(target.getMonth() - n);
      const label =
        n === 1
          ? `about 1 ${unit.replace(/s$/, "")} ago`
          : `about ${n} ${unit.replace(/s$/, "")}s ago`;
      return { target, label };
    }
  }
  const es = message.match(
    /\bhace\s+(una?|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|\d+)\s+(d[ií]as?|semanas?|meses?)\b/i
  );
  if (es) {
    const n = parseAmount(es[1]!);
    const unit = es[2]!.toLowerCase();
    if (n != null && n > 0) {
      const target = new Date();
      if (unit.startsWith("d")) target.setDate(target.getDate() - n);
      else if (unit.startsWith("sem")) target.setDate(target.getDate() - n * 7);
      else target.setMonth(target.getMonth() - n);
      return { target, label: `hace ${n} ${unit}` };
    }
  }
  return null;
}

export function extractShotQuery(message: string): string | null {
  for (const alias of SHOT_ALIASES) {
    if (alias.patterns.some((p) => p.test(message))) return alias.query;
  }
  const my = message.match(
    /\b(?:my|mi)\s+([a-zA-ZáéíóúñÁÉÍÓÚÑ][a-zA-ZáéíóúñÁÉÍÓÚÑ\s-]{1,40}?)\s+(?:today|hoy|from|de|con|vs|versus|against|compar)/i
  );
  if (my?.[1]) {
    const q = my[1].trim().toLowerCase();
    // Themes / progress phrases are not shot types — avoid filtering history to zero.
    if (
      /^(footwork|elbow|technique|preparation|racket preparation|balance|timing|progress|history|weakness)$/i.test(
        q
      )
    ) {
      return null;
    }
    if (/\b(becomes|consistent|consistency|progress|history|weakness|goal|toward|end)\b/i.test(q)) {
      return null;
    }
    if (q.split(/\s+/).filter(Boolean).length > 3) return null;
    return q;
  }
  return null;
}

function normalizeShotToken(raw: string): string {
  return stripTrainClipIndexSuffix(raw)
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function shotMatchesQuery(metrics: TechniqueAnalysisMetrics | null | undefined, query: string): boolean {
  const q = normalizeShotToken(query);
  if (!q) return false;
  const declared = readUserDeclaredShot(metrics as Record<string, unknown> | null);
  const candidates: string[] = [];
  if (declared?.shotLabel) candidates.push(declared.shotLabel);
  if (declared?.strokePreset) candidates.push(declared.strokePreset.replace(/_/g, " "));
  const canonical = resolveCanonicalShotFromMetrics(metrics as Record<string, unknown> | null);
  if (canonical.source !== "fallback" && canonical.shotName) candidates.push(canonical.shotName);
  return candidates.some((c) => {
    const n = normalizeShotToken(c);
    return n === q || n.includes(q) || q.includes(n);
  });
}

function emptyContext(): CoachContext {
  return { kind: "none", analysis: null, day: null, compare: null, history: null, focus: null };
}

async function loadAnalysis(userId: string, analysisId: string | null): Promise<AnalysisRow | null> {
  const [row] = await db
    .select({
      id: techniqueAnalysis.id,
      metrics: techniqueAnalysis.metrics,
      createdAt: techniqueAnalysis.createdAt,
      videoUrl: techniqueVideo.secureUrl,
    })
    .from(techniqueAnalysis)
    .leftJoin(techniqueVideo, eq(techniqueVideo.id, techniqueAnalysis.techniqueVideoId))
    .where(
      analysisId
        ? and(eq(techniqueAnalysis.id, analysisId), eq(techniqueAnalysis.userId, userId))
        : and(eq(techniqueAnalysis.userId, userId), eq(techniqueAnalysis.status, "completed"))
    )
    .orderBy(desc(techniqueAnalysis.createdAt))
    .limit(1);
  return row ?? null;
}

async function loadRecentCompleted(userId: string, limit: number): Promise<AnalysisRow[]> {
  return db
    .select({
      id: techniqueAnalysis.id,
      metrics: techniqueAnalysis.metrics,
      createdAt: techniqueAnalysis.createdAt,
      videoUrl: techniqueVideo.secureUrl,
    })
    .from(techniqueAnalysis)
    .leftJoin(techniqueVideo, eq(techniqueVideo.id, techniqueAnalysis.techniqueVideoId))
    .where(and(eq(techniqueAnalysis.userId, userId), eq(techniqueAnalysis.status, "completed")))
    .orderBy(desc(techniqueAnalysis.createdAt))
    .limit(limit);
}

function pickNearest(rows: AnalysisRow[], targetMs: number, slackMs: number): AnalysisRow | null {
  let best: AnalysisRow | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    const dist = Math.abs(row.createdAt.getTime() - targetMs);
    if (dist <= slackMs && dist < bestDist) {
      best = row;
      bestDist = dist;
    }
  }
  return best;
}

function pickCurrentForShot(rows: AnalysisRow[], shotQuery: string, preferToday: boolean): AnalysisRow | null {
  const matched = rows.filter((r) => shotMatchesQuery(r.metrics, shotQuery));
  if (!matched.length) return null;
  if (preferToday) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const today = matched.find((r) => r.createdAt.getTime() >= start.getTime());
    if (today) return today;
  }
  return matched[0] ?? null;
}

async function buildCompareContext(
  userId: string,
  opts: { message: string; locale: CoachLocale }
): Promise<CoachContext | null> {
  if (!wantsCompareContext(opts.message)) return null;
  const shotQuery = extractShotQuery(opts.message);
  const past = parseRelativePast(opts.message);
  const pairwiseLatest = PAIRWISE_LATEST_INTENT.test(opts.message);
  if (!past && !pairwiseLatest) return null;
  // Dated compare still needs a shot name; pairwise "these two" can use latest two overall.
  if (past && !shotQuery) return null;

  const rows = await loadRecentCompleted(userId, MAX_COMPARE_SCAN);
  const preferToday = /\b(today|hoy|todays|today's)\b/i.test(opts.message);

  let currentRow: AnalysisRow | null = null;
  let priorRow: AnalysisRow | null = null;
  let priorLabel = past?.label ?? "the previous matching upload";

  if (past && shotQuery) {
    currentRow = pickCurrentForShot(rows, shotQuery, preferToday);
    const matched = rows.filter((r) => shotMatchesQuery(r.metrics, shotQuery));
    const priorPool = currentRow ? matched.filter((r) => r.id !== currentRow!.id) : matched;
    priorRow = pickNearest(priorPool, past.target.getTime(), PRIOR_SLACK_MS);
  } else if (pairwiseLatest) {
    const pool = shotQuery ? rows.filter((r) => shotMatchesQuery(r.metrics, shotQuery)) : rows;
    currentRow = pool[0] ?? null;
    priorRow = pool[1] ?? null;
    priorLabel = "the previous upload";
    if (!shotQuery) {
      // keep compare.shotQuery informative for the prompt
    }
  }

  const current = currentRow
    ? await analysisFacts(currentRow, opts.locale, "compare_current", { includeProJoints: false })
    : null;
  const prior = priorRow
    ? await analysisFacts(priorRow, opts.locale, "compare_prior", { includeProJoints: false })
    : null;

  let missing: CoachCompareFacts["missing"] = "none";
  if (!current && !prior) missing = "both";
  else if (!current) missing = "current";
  else if (!prior) missing = "prior";

  return {
    kind: "compare",
    analysis: current,
    day: null,
    focus: null,
    compare: {
      shotQuery: shotQuery ?? current?.shotName ?? "shot",
      priorLabel,
      current,
      prior,
      missing,
    },
    history: null,
  };
}

async function buildHistoryContext(
  userId: string,
  opts: { message: string; locale: CoachLocale }
): Promise<CoachContext | null> {
  if (!wantsHistoryContext(opts.message)) return null;
  // Pairwise "X ago" compares stay on the compare path.
  if (wantsCompareContext(opts.message) && extractShotQuery(opts.message) && parseRelativePast(opts.message)) {
    return null;
  }

  const aliasShot = extractHistoryShotQuery(opts.message);
  const looseShot = extractShotQuery(opts.message);
  const theme = extractTheme(opts.message);
  const window = parseHistoryWindow(opts.message);
  const intent = detectHistoryIntent(opts.message);
  const scoreGoal = extractScoreGoal(opts.message);
  // Catalog-wide intents must not be filtered by accidental free-text "shot" extracts.
  let shotQuery: string | null = aliasShot ?? looseShot;
  if (
    intent === "consistency" ||
    intent === "theme_compare" ||
    intent === "catalog" ||
    intent === "weakness"
  ) {
    shotQuery = aliasShot;
  }
  if (intent === "consistency") shotQuery = null;
  const rows = await loadRecentCompleted(userId, MAX_COMPARE_SCAN);

  let matched = shotQuery ? rows.filter((r) => historyShotMatches(r.metrics, shotQuery)) : rows;
  // Lifetime / catalog questions: do not clamp to a short window.
  const lifetime =
    intent === "first_vs_last" ||
    intent === "best_shot_type" ||
    intent === "catalog" ||
    intent === "goal" ||
    intent === "weakness" ||
    intent === "theme_compare" ||
    intent === "consistency" ||
    /since you started/i.test(window.label);
  if (window.since && !lifetime) {
    const t0 = window.since.getTime();
    matched = matched.filter((r) => r.createdAt.getTime() >= t0);
  }
  if (lifetime) {
    matched = shotQuery ? rows.filter((r) => historyShotMatches(r.metrics, shotQuery)) : rows;
  }

  if (window.limit != null) {
    matched = matched.slice(0, window.limit);
  }

  // Catalog/goal/weakness need more rows to cover the shot library; keep prompt via digest notes.
  const cap =
    intent === "catalog" || intent === "goal" || intent === "weakness" || intent === "consistency"
      ? 48
      : intent === "mistakes" || intent === "theme_compare"
        ? 32
        : 24;
  const capped = matched.slice(0, cap);
  const sessions = await Promise.all(
    capped.map(async (r) =>
      toHistorySession(r, opts.locale, await analysisFacts(r, opts.locale, "latest"))
    )
  );
  const notes = buildHistoryNotes(intent, sessions, shotQuery, theme, window.label, {
    scoreFrom: scoreGoal.from,
    scoreTo: scoreGoal.to,
  });

  return {
    kind: "history",
    analysis: sessions[0] ?? null,
    day: null,
    focus: null,
    compare: null,
    history: {
      intent,
      windowLabel: window.label,
      shotQuery,
      theme,
      sessions,
      notes,
    },
  };
}

function rowScore(row: AnalysisRow): number | null {
  const ai = (row.metrics as { ai_analysis?: { score?: unknown } } | null)?.ai_analysis;
  return typeof ai?.score === "number" && Number.isFinite(ai.score) ? ai.score : null;
}

function rowTechnique(row: AnalysisRow): number | null {
  const ai = (row.metrics as {
    ai_analysis?: { technique_score?: unknown; breakdown?: { technique?: unknown } };
  } | null)?.ai_analysis;
  const raw = ai?.breakdown?.technique ?? ai?.technique_score;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function rowInWindow(row: AnalysisRow, window: CoachWindow): boolean {
  const t = row.createdAt.getTime();
  if (window.since && t < window.since.getTime()) return false;
  if (window.until && t >= window.until.getTime()) return false;
  return true;
}

function pickFeaturedRow(rows: AnalysisRow[], pick: AnswerPlan["pick"]): AnalysisRow | null {
  if (!rows.length) return null;
  if (pick === "latest") return rows[0] ?? null;
  const value = pick === "best_technique" ? rowTechnique : rowScore;
  let chosen = rows[0]!;
  let best = value(chosen);
  for (const row of rows) {
    const v = value(row);
    if (v == null) continue;
    if (best == null || (pick === "worst_score" ? v < best : v > best)) {
      chosen = row;
      best = v;
    }
  }
  return chosen;
}

function featuredSource(plan: AnswerPlan): CoachAnalysisFacts["source"] {
  if (plan.pick === "best_score" || plan.pick === "best_technique") return "best_in_window";
  if (plan.pick === "worst_score") return "worst_in_window";
  if (plan.shotQuery) return "matching_shot";
  return "latest";
}

function libraryIntent(plan: AnswerPlan, message: string): CoachHistoryFacts["intent"] {
  if (plan.family === "pattern") return "consistency";
  if (plan.family === "dialogue") return "goal";
  if (plan.pick === "best_score" || plan.pick === "best_technique" || plan.pick === "worst_score") return "rank";
  return detectHistoryIntent(message);
}

/** Library questions stay inside the asked window and shot. They never borrow a newer clip from outside it. */
async function buildLibraryContext(
  userId: string,
  opts: { message: string; locale: CoachLocale },
  plan: AnswerPlan
): Promise<CoachContext> {
  const window = plan.window!;
  let rows = await loadRecentCompleted(userId, MAX_COMPARE_SCAN);
  if (plan.shotQuery) rows = rows.filter((r) => historyShotMatches(r.metrics, plan.shotQuery!));
  if (window.since || window.until) rows = rows.filter((r) => rowInWindow(r, window));
  if (window.limit != null) rows = rows.slice(0, window.limit);

  const scores = rows.map(rowScore).filter((s): s is number => s != null);
  const average = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
  const best = scores.length ? Math.max(...scores) : null;
  const featuredRow = pickFeaturedRow(rows, plan.pick);
  const featured = featuredRow
    ? await analysisFacts(featuredRow, opts.locale, featuredSource(plan), { includeProJoints: plan.includePro })
    : null;

  const sessions = await Promise.all(
    rows.slice(0, 12).map(async (r) => toHistorySession(r, opts.locale, await analysisFacts(r, opts.locale, "latest")))
  );
  const notes = buildHistoryNotes(libraryIntent(plan, opts.message), sessions, plan.shotQuery, plan.theme, window.label);
  if (average != null) {
    notes.unshift(`${window.label}: ${rows.length} shots, average ${average}/100, best ${best}/100.`);
  }
  if (!rows.length) {
    notes.unshift(
      `No completed analyses in ${window.label}${plan.shotQuery ? ` for "${plan.shotQuery}"` : ""}. Do not substitute a clip from outside this range.`
    );
  } else if (featured && plan.showVideo) {
    notes.unshift(
      `Featured clip (${plan.pick.replace(/_/g, " ")}) in ${window.label}: ` +
        `${featured.shotName ?? "shot"} on ${featured.createdAt.slice(0, 10)}` +
        `${featured.score != null ? `, score ${featured.score}/100` : ""}. ` +
        `This is not "their latest shot" unless that date is also the newest upload.`
    );
  }
  if (!plan.showVideo) {
    notes.unshift("No video is attached. Answer in spoken coaching from these notes. Do not pretend you are playing their latest clip.");
  }

  return {
    kind: "history",
    analysis: null,
    day: null,
    compare: null,
    history: {
      intent: libraryIntent(plan, opts.message),
      windowLabel: window.label,
      shotQuery: plan.shotQuery,
      theme: plan.theme,
      sessions,
      notes,
    },
    focus: {
      showVideo: plan.showVideo && !!featured?.videoUrl,
      showScore: plan.showScore && featured?.score != null,
      showBreakdown: plan.showBreakdown && !!featured,
      showMotion: plan.showMotion && !!featured,
      windowLabel: window.label,
      windowCount: rows.length,
      windowAverage: average,
      windowBest: best,
      theme: plan.theme,
      analysis: featured,
    },
  };
}

/** One clip: the named shot, the open analysis, or the latest upload. A named shot that is missing is not replaced. */
async function buildSingleClipContext(
  userId: string,
  opts: { analysisId?: string; message: string; locale: CoachLocale },
  plan: AnswerPlan
): Promise<CoachContext> {
  const analysisId = opts.analysisId?.trim() || null;
  let row: AnalysisRow | null = null;
  let source: CoachAnalysisFacts["source"] = "latest";
  if (plan.shotQuery) {
    const recent = await loadRecentCompleted(userId, MAX_COMPARE_SCAN);
    row = recent.find((r) => historyShotMatches(r.metrics, plan.shotQuery!)) ?? null;
    source = "matching_shot";
  } else if (analysisId) {
    row = await loadAnalysis(userId, analysisId);
    source = "selected";
  } else if (plan.family !== "dialogue") {
    row = await loadAnalysis(userId, null);
    source = "latest";
  }
  const analysis = row
    ? await analysisFacts(row, opts.locale, source, { includeProJoints: plan.includePro || source === "selected" })
    : null;
  return {
    kind: analysis ? "analysis" : "none",
    analysis,
    day: null,
    compare: null,
    history: null,
    focus: {
      showVideo: plan.showVideo && !!analysis?.videoUrl,
      showScore: plan.showScore && analysis?.score != null,
      showBreakdown: plan.showBreakdown && !!analysis,
      showMotion: plan.showMotion && !!analysis,
      windowLabel: null,
      windowCount: null,
      windowAverage: null,
      windowBest: null,
      theme: plan.theme,
      analysis,
    },
  };
}

/**
 * Chooses evidence from the question. A week, a named shot, a joint measurement,
 * and a training-plan question do not all receive the newest upload.
 */
export async function buildCoachContext(
  userId: string,
  opts: { analysisId?: string; message: string; locale: CoachLocale }
): Promise<CoachContext> {
  const plan = planAnswer(opts.message, opts.locale === "es" ? "es" : "en");
  if (plan.family === "compare") {
    const compare = await buildCompareContext(userId, opts);
    if (compare) return compare;
  }
  if (plan.needsLibrary && plan.window) {
    return buildLibraryContext(userId, opts, plan);
  }
  return buildSingleClipContext(userId, opts, plan);
}

function clipHeading(a: CoachAnalysisFacts): string {
  switch (a.source) {
    case "selected":
      return "Shot the player has open";
    case "best_in_window":
      return "Best shot inside the asked time window";
    case "worst_in_window":
      return "Weakest shot inside the asked time window";
    case "matching_shot":
      return "Shot that matches what they asked about";
    case "compare_current":
      return "More recent shot in the comparison";
    case "compare_prior":
      return "Older shot in the comparison";
    default:
      return "Player's most recent shot";
  }
}

function pushAnalysisLines(lines: string[], a: CoachAnalysisFacts, heading: string) {
  const shot = a.shotName ? ` (${a.shotName})` : "";
  lines.push(`${heading}${shot}, taken ${a.createdAt.slice(0, 10)}:`);
  if (a.score != null) lines.push(`- Overall score: ${a.score}/100${a.rating ? ` (${a.rating})` : ""}.`);
  const b = a.breakdown;
  const parts = [
    b.technique != null ? `technique ${b.technique}` : null,
    b.outcome != null ? `outcome ${b.outcome}` : null,
    b.tactics != null ? `tactics ${b.tactics}` : null,
  ].filter(Boolean);
  if (parts.length) lines.push(`- Breakdown: ${parts.join(", ")}.`);
  if (a.focusArea) lines.push(`- Main area to train: ${a.focusArea}.`);
  if (a.strengths.length) lines.push(`- Did well: ${a.strengths.join(" | ")}`);
  if (a.technicalErrors.length) lines.push(`- Technique issues: ${a.technicalErrors.join(" | ")}`);
  if (a.corrections.length) lines.push(`- To fix: ${a.corrections.join(" | ")}`);
  if (a.observations.length) lines.push(`- Observations: ${a.observations.join(" | ")}`);
  if (a.diagnosis) lines.push(`- Diagnosis (coaching narrative): ${a.diagnosis}`);
  if (a.measuredMotion.length) {
    lines.push(`- Measured motion (cite_ok=${a.citeOk}): ${a.measuredMotion.join("; ")}`);
  } else {
    lines.push(
      "- Measured motion: no joint-angle / prep-to-impact / wrist-speed figures listed for this clip. Do not invent degrees, ms, or speeds. If asked for them, say we do not have that measurement for this clip — never criticize the analysis or tracking."
    );
  }
  if (!a.citeOk) {
    lines.push(
      "- Evidence rule: cite_ok is false. Treat diagnosis numbers as unverified — only repeat a degree, ms, distance, or speed if it appears under Measured motion above. If Measured motion lacks what they asked, say we do not have that measurement for this clip (neutral; never say tracking is imprecise/bad)."
    );
  }
  lines.push(
    "- NEVER invent measurements, angles, distances, racket speeds, or historical improvements. NEVER speak negatively about Xevo tracking, training data, or analysis quality — missing figure = we do not have it here, then coach from notes."
  );
  if (a.proReference) {
    const skill = a.proReference.skillLevel ? ` (${a.proReference.skillLevel})` : "";
    const dist =
      a.proReference.distance != null
        ? ` — retrieval distance ${a.proReference.distance.toFixed(3)} (lower = closer overall body motion)`
        : "";
    lines.push(
      `- Professional reference (perfect-shot standard for this clip): "${a.proReference.label}"${skill}${dist}. Speak of this as the professional player / pro example — it is the matched reference video from the pro library.`
    );
  } else {
    lines.push(
      "- Professional reference: none matched for this analysis. Do not invent a pro player comparison."
    );
  }
  if (a.vsProJoints.length) {
    lines.push(`- You vs professional reference joints: ${a.vsProJoints.join(" | ")}`);
  }
}

export function contextPrompt(ctx: CoachContext): string | null {
  const lines: string[] = [];
  const focus = ctx.focus;
  if (focus?.windowLabel) {
    lines.push(
      `Time window "${focus.windowLabel}": ${focus.windowCount ?? 0} shots` +
        (focus.windowAverage != null ? `, average ${focus.windowAverage}/100, best ${focus.windowBest}/100.` : ".") +
        " Use these window figures for period questions. Do not replace them with a clip from outside the window."
    );
  }
  if (focus && !focus.showVideo) {
    lines.push(
      "No video is attached to this answer. Do not say you are showing their latest shot. Coach out loud from the notes."
    );
  }
  const hist = ctx.history;
  if (hist && ctx.kind === "history") {
    lines.push(
      `History recall (${hist.intent}) over ${hist.windowLabel}` +
        (hist.shotQuery ? ` for "${hist.shotQuery}"` : "") +
        (hist.theme ? ` focusing on ${hist.theme}` : "") +
        "."
    );
    for (const note of hist.notes) lines.push(`- ${note}`);
    const preview = hist.sessions.slice(0, 8);
    if (preview.length) {
      lines.push("Session digest (newest first):");
      for (const s of preview) {
        lines.push(
          `- ${s.createdAt.slice(0, 10)} ${s.shotName ?? "shot"} score=${s.score ?? "n/a"} tech=${s.breakdown.technique ?? "n/a"}` +
            (s.prepToImpactMs != null ? ` prepMs=${s.prepToImpactMs}` : "")
        );
      }
    }
    lines.push(
      "Answer from this recall only. If a metric like racket-prep speed or elbow angle is not in the notes, say evidence is limited — do not invent it."
    );
    if (
      hist.intent === "catalog" ||
      hist.intent === "goal" ||
      hist.intent === "weakness" ||
      hist.intent === "theme_compare" ||
      hist.intent === "consistency"
    ) {
      lines.push(
        "Catalog rules: use the shot-family digest and persistent mistakes/fixes above. For worst-shot or next-goal questions, name the low-scoring family and prescribe only listed fixes. For footwork vs upper-body, compare from the theme notes only — no invented improvement rates. For end-of-training consistency, use the same-day early-vs-late score notes only."
      );
    }
  }

  const cmp = ctx.compare;
  if (cmp && ctx.kind === "compare") {
    lines.push(
      `The player asked to compare their "${cmp.shotQuery}" shot between a recent session and ${cmp.priorLabel}.`
    );
    if (cmp.missing === "both") {
      lines.push(
        `No completed "${cmp.shotQuery}" analyses were found for this player. Say that honestly and invite them to upload one. Do not invent scores.`
      );
    } else if (cmp.missing === "current") {
      lines.push(
        `No recent/today "${cmp.shotQuery}" was found. Tell them that and only discuss the older shot if one exists — do not invent a second shot.`
      );
    } else if (cmp.missing === "prior") {
      lines.push(
        `A "${cmp.shotQuery}" was found for the recent side, but none near ${cmp.priorLabel} (±4 days). Say you could not find that older clip. Coach from the recent one only. Use the real date below — do not call it "today" unless the date is actually today.`
      );
    } else {
      lines.push(
        "Compare the two analyses below: scores, strengths, and corrections. Be specific about what improved or worsened. Do not invent numbers. Use the real dates given."
      );
    }
    if (cmp.current) {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      const isToday = new Date(cmp.current.createdAt).getTime() >= start.getTime();
      pushAnalysisLines(
        lines,
        cmp.current,
        isToday ? "TODAY / MORE RECENT shot" : "MOST RECENT matching shot (not from today)"
      );
    }
    if (cmp.prior) pushAnalysisLines(lines, cmp.prior, `OLDER shot (${cmp.priorLabel})`);
  }

  const a = ctx.analysis;
  const featured = focus?.analysis && ctx.kind !== "analysis" ? focus.analysis : null;
  if (featured && focus?.showVideo) {
    pushAnalysisLines(lines, featured, clipHeading(featured));
  }
  if (a && ctx.kind === "analysis") {
    pushAnalysisLines(lines, a, clipHeading(a));
    lines.push(
      "For biomechanics questions (elbow, torso, wrist, contact, weight transfer, racket face, racket speed): answer from Technique issues / Observations / Diagnosis / Measured motion only. Prefer derived wrist_peak_* and estimated_contact_* lines when present (you may say estimate). If Measured motion lacks the number, say we do not have that measurement for this clip — never blame tracking or training data — then coach from qualitative notes. Never invent degrees, distances, or timings."
    );
    lines.push(
      "Special cases: (1) racket speed — use wrist_peak_*_derived when listed. (2) contact moment — use estimated_contact_frame / yolo frames when listed. (3) 'elbow improved by N degrees' — only if Measured motion has elbows on both clips; else we cannot verify that number from these notes. (4) knee dangerous — use knee_angle line if present; no medical diagnosis. (5) smash hit the glass — we do not have glass-outcome data for this clip; coach from smash notes if any. Tone: never put down the product."
    );
    if (focus?.showMotion && !focus.showScore) {
      lines.push(
        "This is a measurement question. Lead with the measured motion for the body part they asked about. Do not open with the overall score. If that number is not under Measured motion, say we do not have that measurement for this clip."
      );
    }
    if (a.proReference) {
      lines.push(
        `When the player asks about a professional / reference / pro player: the professional standard IS "${a.proReference.label}" above (the matched reference video). Compare the player to that clip using Technique issues, strengths, corrections, and You vs professional reference joints. Call it the professional reference or pro example — do not invent a famous player name. Only cite joint degrees/match% listed under You vs professional reference joints. If joints are missing, compare qualitatively from the notes and say joint-by-joint numbers are limited.`
      );
    }
  }
  const d = ctx.day;
  if (d) {
    lines.push(
      `Today the player completed ${d.count} analyzed shot${d.count === 1 ? "" : "s"}` +
        (d.averageScore != null ? `, average score ${d.averageScore}/100, best ${d.bestScore}/100.` : ".")
    );
    const areas = [...new Set(d.sessions.map((s) => s.focusArea).filter(Boolean))];
    if (areas.length) lines.push(`- Areas flagged today: ${areas.join(", ")}.`);
  }
  if (lines.length) {
    lines.push("The player hears this reply spoken aloud. Always answer in spoken sentences, including when no clip is attached.");
  }
  return lines.length ? lines.join("\n") : null;
}

export { emptyContext };
