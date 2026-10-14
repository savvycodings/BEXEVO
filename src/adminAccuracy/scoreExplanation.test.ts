import { test } from "node:test";
import assert from "node:assert/strict";
import { explainScore, unboostPillar } from "./scoreExplanation";
import { pillarDisplayBoostAmount } from "../technique/scoreCalibration";

test("unboostPillar inverts the per-pillar display boost", () => {
  for (const boost of [1, 7, 12]) {
    for (let pre = 0; pre <= 100; pre++) {
      const shown = Math.min(100, pre + pillarDisplayBoostAmount(pre, boost));
      if (shown < 100) assert.equal(unboostPillar(shown, boost), pre);
    }
  }
});

test("explainScore rebuilds the steps from stored ai_analysis", () => {
  const metrics = {
    pose_data: new Array(78).fill({}),
    impact_frame_resolved: 37,
    retrieval: { embedding_source: "mediapipe_v2", eval: { display_shot: "Forehand volley" } },
    ai_analysis: {
      score: 88,
      rating: "excellent",
      scoring_version: "v6.1.3",
      score_model_raw: 81,
      is_padel: true,
      breakdown: { technique: 90, outcome: 86, tactics: 89 },
      confidence: { score: 88, band: "reliable", pose_confidence: 90, tracking_stability: 85, visibility_quality: 92, uncertainty_plus_minus: 2 },
      calibration_trace: {
        pillar_blend: 81,
        score_display_boost: 7,
        score_display_boost_merit: 0.5855,
        score_display_boost_factors: { rawOverallNorm: 0.81, errorLoad: 0.75 },
        legacy_penalty_adjusted_audit: 64,
      },
      en: { strengths: ["a", "b"], technical_errors: ["x"], actionable_corrections: ["y", "z"] },
    },
  };
  const e = explainScore(metrics, { strokeLabel: "Forehand volley", distance: 0.12 })!;
  assert.deepEqual(e.pillarsRaw, { technique: 83, outcome: 79, tactics: 82 });
  assert.deepEqual(e.boost?.perPillar, { technique: 7, outcome: 7, tactics: 7 });
  assert.equal(e.pillarAverage, 81);
  assert.equal(e.final, 88);
  assert.equal(e.inputs.poseFrames, 78);
  assert.equal(e.inputs.topNeighbor?.distance, 0.12);
  assert.deepEqual(e.feedback.corrections, ["y", "z"]);
});

test("explainScore is null without a score", () => {
  assert.equal(explainScore({}, null), null);
});
