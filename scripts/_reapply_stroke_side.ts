/**
 * Re-apply current strokeSide tie-break onto stored analysis metrics (no re-embed).
 * Updates Neon metrics.retrieval.shot_hypothesis + stroke_side* + eval snapshot.
 *
 * Usage: npx tsx scripts/_reapply_stroke_side.ts [id ...]
 */
import "dotenv/config";
import pg from "pg";
import {
  computeStrokeSideSignal,
  applyStrokeSideTieBreak,
  strokeSideFramesFromMetrics,
  profileHandToDominant,
} from "../src/technique/strokeSide";
import { attachEvalToMetrics } from "../src/adminAccuracy/evalSnapshot";
import { selectShotLabel } from "../src/technique/shotHypothesis";
import type { TechniqueRetrievalResult } from "../src/db/schema";

const DEFAULT_IDS = [
  "9bd5eb32-3146-433e-9b09-f45a0f473631",
  "5108f549-111e-48f3-b4fa-001eccec7bbc",
];

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 20000,
});

function rebuildPreStrokeHyp(
  m: Record<string, any>
): TechniqueRetrievalResult["shot_hypothesis"] | null {
  const r = m.retrieval || {};
  const neighbors = r.neighbors || [];
  const tb = m.stroke_side_tiebreak || {};

  // Prefer reconstructing the ensemble vote from neighbors when possible.
  if (Array.isArray(neighbors) && neighbors.length > 0) {
    const fromVote = selectShotLabel(
      neighbors.map((n: any) => ({
        stroke_label: n.stroke_label,
        stroke_preset: n.stroke_preset,
        category: n.category,
        skill_level: n.skill_level,
        distance: n.distance,
        train_sample_id: n.train_sample_id,
        sourceWeight: n.sourceWeight,
      }))
    );
    if (fromVote) return fromVote;
  }

  if (tb.applied) {
    const pose = r.pose_hypothesis;
    const mesh = r.mesh_hypothesis;
    if (
      pose?.stroke_label &&
      mesh?.stroke_label &&
      pose.stroke_label === mesh.stroke_label
    ) {
      return { ...pose };
    }
    const top = neighbors[0];
    if (top) {
      return {
        stroke_label: top.stroke_label,
        stroke_preset: top.stroke_preset,
        category: top.category,
        skill_level: top.skill_level,
        confidence: r.shot_hypothesis?.confidence ?? 0,
      };
    }
  }

  return r.shot_hypothesis ? { ...r.shot_hypothesis } : null;
}

async function reapplyOne(id: string) {
  const { rows } = await pool.query(
    `SELECT ta.id, ta.metrics, ta."userId", up."dominantHand"
     FROM technique_analysis ta
     LEFT JOIN user_profile up ON up."userId" = ta."userId"
     WHERE ta.id = $1`,
    [id]
  );
  if (!rows[0]) {
    return { id, error: "not_found" };
  }

  const m = { ...(rows[0].metrics as Record<string, any>) };
  const r = { ...(m.retrieval || {}) } as TechniqueRetrievalResult;
  const impactFrame =
    typeof m.impact_frame_resolved === "number" ? m.impact_frame_resolved : null;
  const impactSource =
    typeof m.impact_frame_source === "string" ? m.impact_frame_source : null;
  const dominantHand = profileHandToDominant(rows[0].dominantHand);
  const signal = computeStrokeSideSignal(
    strokeSideFramesFromMetrics(m, impactFrame),
    {
      dominantHand,
      dominantHandSource: dominantHand ? "profile" : null,
      impactFrame,
    }
  );

  const preHyp = rebuildPreStrokeHyp(m);
  const preRetrieval: TechniqueRetrievalResult = {
    ...r,
    shot_hypothesis: preHyp,
    neighbors: r.neighbors || [],
  };

  const tie = applyStrokeSideTieBreak(preRetrieval, signal, {
    impactFrameSource: impactSource,
  });

  const nextMetrics = attachEvalToMetrics({
    ...m,
    stroke_side: signal,
    stroke_side_tiebreak: { applied: tie.applied, note: tie.note },
    retrieval: tie.retrieval,
  });

  await pool.query(`UPDATE technique_analysis SET metrics = $2::jsonb WHERE id = $1`, [
    id,
    JSON.stringify(nextMetrics),
  ]);

  return {
    id,
    before: r.shot_hypothesis?.stroke_label ?? null,
    pre_hyp: preHyp?.stroke_label ?? null,
    after: tie.retrieval.shot_hypothesis?.stroke_label ?? null,
    signal: {
      side: signal.side,
      score: Number(signal.score.toFixed(4)),
      offset: signal.prep_offset,
      confident: signal.confident,
    },
    tiebreak: { applied: tie.applied, note: tie.note },
    impact_src: impactSource,
    display_shot:
      (nextMetrics as any)?.retrieval?.eval?.display_shot ??
      tie.retrieval.shot_hypothesis?.stroke_label,
  };
}

async function main() {
  const ids = process.argv.slice(2).filter(Boolean);
  const targets = ids.length ? ids : DEFAULT_IDS;
  const results = [];
  for (const id of targets) {
    results.push(await reapplyOne(id));
  }
  console.log(JSON.stringify(results, null, 2));
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
