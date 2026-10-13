import { and, desc, eq, gte } from "drizzle-orm";
import { db, techniqueAnalysis, techniqueVideo } from "../db";
import type { TechniqueAnalysisMetrics } from "../db/schema";
import { resolveCanonicalShotFromMetrics } from "../train/trainShotDisplay";

export type CoachLocale = "en" | "es";

export type CoachAnalysisFacts = {
  analysisId: string;
  /** `selected`: the shot the player opened the coach from; `latest`: their most recent shot. */
  source: "selected" | "latest";
  shotName: string | null;
  /** Server-relative (`/technique/video/:id`) or absolute URL of the submitted clip. */
  videoUrl: string | null;
  score: number | null;
  rating: string | null;
  breakdown: { technique: number | null; outcome: number | null; tactics: number | null };
  focusArea: string | null;
  strengths: string[];
  corrections: string[];
  createdAt: string;
};

export type CoachDayFacts = {
  count: number;
  averageScore: number | null;
  bestScore: number | null;
  sessions: Array<{ analysisId: string; score: number | null; focusArea: string | null; createdAt: string }>;
};

/** What the coach looked at before answering; rendered as the thinking trace in the app. */
export type CoachContext = {
  kind: "analysis" | "day" | "none";
  analysis: CoachAnalysisFacts | null;
  day: CoachDayFacts | null;
};

const DAY_INTENT = /\b(today|todays|today's|day|daily|sessions?|hoy|d[ií]a|sesi[oó]n(es)?)\b/i;
const MAX_DAY_SESSIONS = 8;

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

type AnalysisRow = {
  id: string;
  metrics: TechniqueAnalysisMetrics | null;
  createdAt: Date;
  videoUrl?: string | null;
};

function analysisFacts(row: AnalysisRow, locale: CoachLocale, source: CoachAnalysisFacts["source"]): CoachAnalysisFacts {
  const { id, metrics, createdAt } = row;
  const ai = metrics?.ai_analysis ?? null;
  const loc = ((ai?.[locale] ?? ai?.en ?? {}) as Record<string, unknown>) || {};
  const shot = resolveCanonicalShotFromMetrics(metrics as Record<string, unknown> | null);
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
    strengths: stringList(loc.strengths, 2),
    corrections: stringList(loc.actionable_corrections, 2),
    createdAt: createdAt.toISOString(),
  };
}

export function wantsDayContext(message: string): boolean {
  return DAY_INTENT.test(message);
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

/**
 * With an `analysisId` the coach talks about that shot. Without one (opened from the tab bar)
 * it falls back to the player's latest completed shot, unless the question is about the day.
 */
export async function buildCoachContext(
  userId: string,
  opts: { analysisId?: string; message: string; locale: CoachLocale }
): Promise<CoachContext> {
  const analysisId = opts.analysisId?.trim() || null;
  const dayIntent = wantsDayContext(opts.message);
  let analysis: CoachAnalysisFacts | null = null;
  if (analysisId || !dayIntent) {
    const row = await loadAnalysis(userId, analysisId);
    if (row) analysis = analysisFacts(row, opts.locale, analysisId ? "selected" : "latest");
  }

  if (!dayIntent) {
    return { kind: analysis ? "analysis" : "none", analysis, day: null };
  }

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const rows = await db
    .select({
      id: techniqueAnalysis.id,
      metrics: techniqueAnalysis.metrics,
      createdAt: techniqueAnalysis.createdAt,
    })
    .from(techniqueAnalysis)
    .where(
      and(
        eq(techniqueAnalysis.userId, userId),
        eq(techniqueAnalysis.status, "completed"),
        gte(techniqueAnalysis.createdAt, startOfDay)
      )
    )
    .orderBy(desc(techniqueAnalysis.createdAt))
    .limit(MAX_DAY_SESSIONS);

  const sessions = rows.map((r) => {
    const f = analysisFacts(r, opts.locale, "latest");
    return { analysisId: f.analysisId, score: f.score, focusArea: f.focusArea, createdAt: f.createdAt };
  });
  const scores = sessions.map((s) => s.score).filter((s): s is number => s != null);
  const day: CoachDayFacts = {
    count: sessions.length,
    averageScore: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
    bestScore: scores.length ? Math.max(...scores) : null,
    sessions,
  };
  return { kind: day.count > 0 ? "day" : analysis ? "analysis" : "none", analysis, day: day.count > 0 ? day : null };
}

export function contextPrompt(ctx: CoachContext): string | null {
  const lines: string[] = [];
  const a = ctx.analysis;
  if (a) {
    const shot = a.shotName ? ` (${a.shotName})` : "";
    lines.push(
      a.source === "selected"
        ? `Analysis of the shot the player just submitted${shot}:`
        : `Analysis of the player's most recent shot${shot}, taken ${a.createdAt.slice(0, 10)}:`
    );
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
    if (a.corrections.length) lines.push(`- To fix: ${a.corrections.join(" | ")}`);
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
  return lines.length ? lines.join("\n") : null;
}
