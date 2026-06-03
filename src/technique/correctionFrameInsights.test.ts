import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCorrectionFrameInsight,
  orderFrameInsights,
} from "./correctionFrameInsights";
import type { FrameLandmarks } from "./correctionPrompt";

function pt(x: number, y: number) {
  return { x, y };
}

function baseLandmarks(offset = 0): FrameLandmarks {
  const o = offset;
  return {
    NOSE: pt(0.5, 0.2),
    LEFT_SHOULDER: pt(0.4 + o, 0.35),
    RIGHT_SHOULDER: pt(0.6 + o, 0.35),
    LEFT_ELBOW: pt(0.35 + o, 0.45),
    RIGHT_ELBOW: pt(0.65 + o, 0.45),
    LEFT_WRIST: pt(0.3 + o, 0.55),
    RIGHT_WRIST: pt(0.7 + o, 0.55),
    LEFT_HIP: pt(0.42, 0.55),
    RIGHT_HIP: pt(0.58, 0.55),
    LEFT_KNEE: pt(0.43, 0.72),
    RIGHT_KNEE: pt(0.57, 0.72),
    LEFT_ANKLE: pt(0.44, 0.88),
    RIGHT_ANKLE: pt(0.56, 0.88),
  };
}

test("buildCorrectionFrameInsight summary mentions focus when pro gap exists", () => {
  const user = baseLandmarks(0.08);
  const pro = baseLandmarks(0);
  const insight = buildCorrectionFrameInsight({
    frame: 42,
    imageIndex: 1,
    userLandmarks: user,
    proLandmarks: pro,
    frameDeltas: [
      {
        landmark: "RIGHT_WRIST",
        axis: "x",
        direction: "decrease",
        magnitude: "moderate",
        reason: "test",
      },
    ],
    shotName: "Forehand Half Volley",
    dominantHand: "right-handed",
    impactPoseSequence: [
      { phase: "impact", frame: 42, landmarks: user },
    ],
  });
  assert.equal(insight.label, "Image 1");
  assert.equal(insight.phase, "impact");
  assert.ok(insight.summary.includes("contact moment"));
  assert.ok(insight.focus_joints.length > 0);
  assert.ok(insight.stats.pro_match >= 0 && insight.stats.pro_match <= 100);
  assert.ok(insight.stats.adjustment_need > 0);
});

test("orderFrameInsights renumbers labels by frame order", () => {
  const ordered = orderFrameInsights(
    [
      {
        frame: 90,
        label: "Image 9",
        summary: "a",
        focus_joints: [],
        stats: { pro_match: 1, adjustment_need: 2, stability: 3, power_line: 4 },
      },
      {
        frame: 10,
        label: "Image 1",
        summary: "b",
        focus_joints: [],
        stats: { pro_match: 5, adjustment_need: 6, stability: 7, power_line: 8 },
      },
    ],
    [10, 90]
  );
  assert.equal(ordered[0]?.label, "Image 1");
  assert.equal(ordered[0]?.frame, 10);
  assert.equal(ordered[1]?.label, "Image 2");
  assert.equal(ordered[1]?.frame, 90);
});
