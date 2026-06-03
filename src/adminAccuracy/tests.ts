import { pool } from "../db";
import {
  ACCURACY_PASS_PERCENT,
  MIN_TRAIN_SAMPLES_PER_LABEL,
  RECENT_ANALYSIS_DAYS,
  RECENT_ANALYSIS_LIMIT,
} from "./constants";
import {
  canonicalDisplayShot,
  correctionMatchesDisplay,
  correctionShotName,
  displayMatchesSuggestion,
  hasYoloContacts,
  hypothesisMatchesTopNeighbor,
  impactFrameSource,
  retrievalFromMetrics,
  shotHypothesis,
  topNeighbor,
} from "./metricsHelpers";
import { countCompletedInLastDays, fetchRecentCompletedAnalyses } from "./recentAnalyses";
import { buildTestRun, type TestRunResult } from "./scoring";
import {
  NEIGHBOR_DISTANCE_GAP_MIN,
  RETRIEVAL_CONFIDENCE_THRESHOLD,
} from "../train/trainShotDisplay";

export type AccuracyTestDefinition = {
  id: string;
  title: string;
  description: string;
  /** Maps to investigation scripts in server/scripts/ */
  scriptHint?: string;
};

export const ACCURACY_TEST_CATALOG: AccuracyTestDefinition[] = [
  {
    id: "recent_uploads",
    title: "Recent uploads",
    description: "At least one completed user analysis in the last 14 days.",
    scriptHint: "_recent_submissions.mjs",
  },
  {
    id: "embedding_ready",
    title: "Pose embed OK",
    description: "Recent analyses produced a v2 retrieval embedding.",
  },
  {
    id: "library_match",
    title: "Library neighbor",
    description: "k-NN returned a pro-library neighbor for recent uploads.",
  },
  {
    id: "hypothesis_vs_neighbor",
    title: "Hyp = #1 neighbor",
    description: "Shot hypothesis label matches the closest train clip label.",
    scriptHint: "_dist_to_forehand_lob.mjs",
  },
  {
    id: "display_vs_suggestion",
    title: "UI shot match",
    description: "Canonical display shot matches hypothesis or top neighbor.",
    scriptHint: "_curl_recent_two.mjs",
  },
  {
    id: "correction_vs_display",
    title: "Correction shot",
    description: "Correction card shot name matches what we display.",
  },
  {
    id: "impact_yolo",
    title: "YOLO impact",
    description: "Impact frame uses YOLO (not legacy clip_end) when contacts exist.",
  },
  {
    id: "train_coverage",
    title: "Train coverage",
    description: "Pro labels have at least 2 v2 embeddings (thin-library guard).",
    scriptHint: "audit_retrieval_coverage.mjs",
  },
  {
    id: "confidence_healthy",
    title: "Conf / gap OK",
    description: "Strong vote or clear neighbor distance gap (not ambiguous).",
  },
];

const catalogById = new Map(ACCURACY_TEST_CATALOG.map((t) => [t.id, t]));

export function getAccuracyTest(id: string): AccuracyTestDefinition | undefined {
  return catalogById.get(id);
}

export async function runAccuracyTest(testId: string): Promise<TestRunResult> {
  switch (testId) {
    case "recent_uploads":
      return runRecentUploads();
    case "embedding_ready":
      return runEmbeddingReady();
    case "library_match":
      return runLibraryMatch();
    case "hypothesis_vs_neighbor":
      return runHypothesisVsNeighbor();
    case "display_vs_suggestion":
      return runDisplayVsSuggestion();
    case "correction_vs_display":
      return runCorrectionVsDisplay();
    case "impact_yolo":
      return runImpactYolo();
    case "train_coverage":
      return runTrainCoverage();
    case "confidence_healthy":
      return runConfidenceHealthy();
    default:
      throw new Error(`Unknown test: ${testId}`);
  }
}

async function runRecentUploads(): Promise<TestRunResult> {
  const n = await countCompletedInLastDays(RECENT_ANALYSIS_DAYS);
  const scorePercent = n > 0 ? 100 : 0;
  return {
    scorePercent,
    passed: scorePercent >= ACCURACY_PASS_PERCENT,
    summary: n > 0 ? `${n} completed in ${RECENT_ANALYSIS_DAYS}d` : "No recent completed analyses",
    detail: { count: n, days: RECENT_ANALYSIS_DAYS },
  };
}

async function runEmbeddingReady(): Promise<TestRunResult> {
  const rows = await fetchRecentCompletedAnalyses(RECENT_ANALYSIS_LIMIT);
  let ok = 0;
  const samples: { id: string; ok: boolean }[] = [];
  for (const row of rows) {
    const r = retrievalFromMetrics(row.metrics);
    const good = r?.query_embedding_ok === true;
    if (good) ok += 1;
    samples.push({ id: row.id, ok: good });
  }
  return buildTestRun(ok, rows.length, "No completed analyses", {
    samples: samples.slice(0, 8),
  });
}

async function runLibraryMatch(): Promise<TestRunResult> {
  const rows = await fetchRecentCompletedAnalyses(RECENT_ANALYSIS_LIMIT);
  let ok = 0;
  const samples: { id: string; neighbor: string | null; distance: number | null }[] = [];
  for (const row of rows) {
    const n = topNeighbor(row.metrics);
    const has = !!n && typeof n.stroke_label === "string";
    if (has) ok += 1;
    samples.push({
      id: row.id,
      neighbor: has ? String(n.stroke_label) : null,
      distance: typeof n?.distance === "number" ? n.distance : null,
    });
  }
  return buildTestRun(ok, rows.length, "No completed analyses", {
    samples: samples.slice(0, 8),
  });
}

async function runHypothesisVsNeighbor(): Promise<TestRunResult> {
  const rows = await fetchRecentCompletedAnalyses(RECENT_ANALYSIS_LIMIT);
  let ok = 0;
  let eligible = 0;
  const samples: {
    id: string;
    hypothesis: string | null;
    neighbor: string | null;
    match: boolean;
  }[] = [];
  for (const row of rows) {
    const n = topNeighbor(row.metrics);
    if (!n) continue;
    eligible += 1;
    const hyp = shotHypothesis(row.metrics);
    const hypLabel = typeof hyp?.stroke_label === "string" ? hyp.stroke_label : null;
    const neighborLabel =
      typeof n.stroke_label === "string" ? n.stroke_label : null;
    const match = hypothesisMatchesTopNeighbor(row.metrics);
    if (match) ok += 1;
    samples.push({ id: row.id, hypothesis: hypLabel, neighbor: neighborLabel, match });
  }
  return buildTestRun(ok, eligible, "No analyses with neighbors", {
    samples: samples.slice(0, 8),
  });
}

async function runDisplayVsSuggestion(): Promise<TestRunResult> {
  const rows = await fetchRecentCompletedAnalyses(RECENT_ANALYSIS_LIMIT);
  let ok = 0;
  const samples: { id: string; display: string; match: boolean }[] = [];
  for (const row of rows) {
    const match = displayMatchesSuggestion(row.metrics);
    if (match) ok += 1;
    samples.push({
      id: row.id,
      display: canonicalDisplayShot(row.metrics),
      match,
    });
  }
  return buildTestRun(ok, rows.length, "No completed analyses", {
    samples: samples.slice(0, 8),
  });
}

async function runCorrectionVsDisplay(): Promise<TestRunResult> {
  const rows = await fetchRecentCompletedAnalyses(RECENT_ANALYSIS_LIMIT);
  let ok = 0;
  let eligible = 0;
  const samples: { id: string; correction: string; display: string; match: boolean }[] = [];
  for (const row of rows) {
    const corr = correctionShotName(row.metrics);
    if (!corr) continue;
    eligible += 1;
    const match = correctionMatchesDisplay(row.metrics);
    if (match) ok += 1;
    samples.push({
      id: row.id,
      correction: corr,
      display: canonicalDisplayShot(row.metrics),
      match,
    });
  }
  return buildTestRun(ok, eligible, "No analyses with correction shot", {
    samples: samples.slice(0, 8),
  });
}

async function runImpactYolo(): Promise<TestRunResult> {
  const rows = await fetchRecentCompletedAnalyses(RECENT_ANALYSIS_LIMIT);
  let ok = 0;
  let eligible = 0;
  const samples: { id: string; source: string | null; yolo: boolean }[] = [];
  for (const row of rows) {
    if (!hasYoloContacts(row.metrics)) continue;
    eligible += 1;
    const src = impactFrameSource(row.metrics);
    const modern = src === "yolo_median" || src === "yolo_global_median" || src === "clip_center";
    if (modern) ok += 1;
    samples.push({ id: row.id, source: src, yolo: modern });
  }
  return buildTestRun(ok, eligible, "No analyses with YOLO contacts", {
    samples: samples.slice(0, 8),
  });
}

async function runTrainCoverage(): Promise<TestRunResult> {
  const { rows } = await pool.query<{ stroke_label: string; n: number }>(`
    SELECT
      COALESCE(NULLIF(TRIM(tv."strokeLabel"), ''), tv."strokeName") AS stroke_label,
      COUNT(*)::int AS n
    FROM train_sample_embedding tse
    INNER JOIN train_sample ts ON ts.id = tse."trainSampleId"
    INNER JOIN train_video tv ON tv.id = ts."trainVideoId"
    WHERE ts.status = 'completed' AND tse."specVersion" = 'v2'
    GROUP BY 1
  `);
  const total = rows.length;
  const ok = rows.filter((r) => r.n >= MIN_TRAIN_SAMPLES_PER_LABEL).length;
  const thin = rows
    .filter((r) => r.n < MIN_TRAIN_SAMPLES_PER_LABEL)
    .sort((a, b) => a.n - b.n)
    .slice(0, 12)
    .map((r) => ({ label: r.stroke_label, n: r.n }));
  return buildTestRun(ok, total, "No indexed train labels", {
    minSamples: MIN_TRAIN_SAMPLES_PER_LABEL,
    thin,
  });
}

async function runConfidenceHealthy(): Promise<TestRunResult> {
  const rows = await fetchRecentCompletedAnalyses(RECENT_ANALYSIS_LIMIT);
  let ok = 0;
  const samples: { id: string; confidence: number; gap: number | null; healthy: boolean }[] = [];
  for (const row of rows) {
    const hyp = shotHypothesis(row.metrics);
    const conf = typeof hyp?.confidence === "number" ? hyp.confidence : 0;
    const retrieval = retrievalFromMetrics(row.metrics);
    const storedGap = retrieval?.neighbor_distance_gap;
    let gap: number | null =
      typeof storedGap === "number" && Number.isFinite(storedGap) ? storedGap : null;
    const neighbors = Array.isArray(retrieval?.neighbors) ? retrieval.neighbors : [];
    if (
      gap == null &&
      neighbors.length >= 2 &&
      typeof neighbors[0]?.distance === "number" &&
      typeof neighbors[1]?.distance === "number"
    ) {
      gap = (neighbors[1].distance as number) - (neighbors[0].distance as number);
    }
    const ambiguous =
      conf < RETRIEVAL_CONFIDENCE_THRESHOLD &&
      gap != null &&
      gap < NEIGHBOR_DISTANCE_GAP_MIN;
    const healthy =
      !ambiguous &&
      (conf >= RETRIEVAL_CONFIDENCE_THRESHOLD ||
        (gap != null && gap >= NEIGHBOR_DISTANCE_GAP_MIN));
    if (healthy) ok += 1;
    samples.push({ id: row.id, confidence: conf, gap, healthy });
  }
  return buildTestRun(ok, rows.length, "No completed analyses", {
    samples: samples.slice(0, 8),
  });
}

export async function runAllAccuracyTests(): Promise<
  { testId: string; result: TestRunResult }[]
> {
  const out: { testId: string; result: TestRunResult }[] = [];
  for (const t of ACCURACY_TEST_CATALOG) {
    out.push({ testId: t.id, result: await runAccuracyTest(t.id) });
  }
  return out;
}
