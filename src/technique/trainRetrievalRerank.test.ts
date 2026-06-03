import test from "node:test";
import assert from "node:assert/strict";
import type { TrainNeighborCandidate } from "./trainRetrievalHygiene";
import {
  rerankTrainNeighbors,
  effectiveNeighborDistance,
  isServeLikeSaveReturn,
  shouldApplyBandejaRerank,
  BANDEJA_DISTANCE_BONUS,
  SAVE_RETURN_SERVE_PENALTY,
} from "./trainRetrievalRerank";

function row(
  partial: Partial<TrainNeighborCandidate> &
    Pick<TrainNeighborCandidate, "stroke_label" | "stroke_preset" | "distance">
): TrainNeighborCandidate {
  return {
    train_sample_id: partial.train_sample_id ?? "s1",
    train_video_id: partial.train_video_id ?? "v1",
    stroke_name: partial.stroke_name ?? partial.stroke_label,
    stroke_label: partial.stroke_label,
    category: partial.category ?? "save_return",
    stroke_preset: partial.stroke_preset,
    skill_level: partial.skill_level ?? "advanced",
    distance: partial.distance,
    extraction_meta: null,
  };
}

test("bandeja wins when overhead pose and flat serve was raw #1", () => {
  const rows = [
    row({
      stroke_label: "Flat Serve",
      stroke_preset: "forehand_drive",
      category: "save_return",
      distance: 0.106,
    }),
    row({
      stroke_label: "Bandeja 1",
      stroke_preset: "bandeja",
      category: "overhead",
      distance: 0.162,
    }),
  ];
  const poseData = overheadPoseFrames();
  const { neighbors, rerank } = rerankTrainNeighbors(rows, { pose_data: poseData });
  assert.equal(rerank.applied, true);
  assert.equal(rerank.supports_overhead, true);
  assert.equal(neighbors[0]!.stroke_label, "Bandeja 1");
  assert.ok(neighbors[0]!.distance < neighbors[1]!.distance);
});

test("no rerank when bandeja is far and no overhead pose", () => {
  const rows = [
    row({
      stroke_label: "Flat Serve",
      stroke_preset: "forehand_drive",
      distance: 0.1,
    }),
    row({
      stroke_label: "Bandeja 1",
      stroke_preset: "bandeja",
      category: "overhead",
      distance: 0.3,
    }),
  ];
  const { neighbors, rerank } = rerankTrainNeighbors(rows, { pose_data: [] });
  assert.equal(rerank.applied, false);
  assert.equal(neighbors[0]!.stroke_label, "Flat Serve");
});

test("contention gate applies bandeja bonus without overhead pose", () => {
  const rows = [
    row({
      stroke_label: "Flat Serve",
      stroke_preset: "forehand_drive",
      distance: 0.106,
    }),
    row({
      stroke_label: "Bandeja 1",
      stroke_preset: "bandeja",
      category: "overhead",
      distance: 0.162,
    }),
  ];
  const gate = shouldApplyBandejaRerank(rows, false);
  assert.equal(gate.bandejaContention, true);
  assert.equal(gate.apply, true);

  const effServe = effectiveNeighborDistance(rows[0]!, {
    apply: true,
    supportsOverhead: false,
  });
  const effBandeja = effectiveNeighborDistance(rows[1]!, {
    apply: true,
    supportsOverhead: false,
  });
  assert.ok(effBandeja < effServe);
});

test("serve penalty does not affect forehand return", () => {
  assert.equal(
    isServeLikeSaveReturn(
      row({
        stroke_label: "Forehand Return",
        stroke_preset: "forehand_return",
        category: "save_return",
        distance: 0.1,
      })
    ),
    false
  );
  const d = effectiveNeighborDistance(
    row({
      stroke_label: "Forehand Return",
      stroke_preset: "forehand_return",
      distance: 0.12,
    }),
    { apply: true, supportsOverhead: true }
  );
  assert.equal(d, 0.12);
});

test("serve-like labels include flat serve and slice serve", () => {
  assert.equal(isServeLikeSaveReturn(row({ stroke_label: "Flat Serve", stroke_preset: "forehand_drive", distance: 0.1 })), true);
  assert.equal(
    isServeLikeSaveReturn(
      row({
        stroke_label: "Slice Serve",
        stroke_preset: "backhand_drive_with_wall",
        distance: 0.1,
      })
    ),
    true
  );
});

/** Minimal pose frames with wrists above shoulders (overhead). */
function overheadPoseFrames(): Array<{
  frame: number;
  landmarks: Record<string, { x: number; y: number }>;
}> {
  const mk = (wristY: number) => ({
    LEFT_SHOULDER: { x: 0.4, y: 0.5 },
    RIGHT_SHOULDER: { x: 0.6, y: 0.5 },
    LEFT_WRIST: { x: 0.45, y: wristY },
    RIGHT_WRIST: { x: 0.55, y: wristY },
    LEFT_ELBOW: { x: 0.43, y: 0.45 },
    RIGHT_ELBOW: { x: 0.57, y: 0.45 },
    NOSE: { x: 0.5, y: 0.35 },
  });
  return [
    { frame: 0, landmarks: mk(0.2) },
    { frame: 1, landmarks: mk(0.22) },
    { frame: 2, landmarks: mk(0.18) },
  ];
}

test("constants match plan defaults", () => {
  assert.equal(BANDEJA_DISTANCE_BONUS, 0.05);
  assert.equal(SAVE_RETURN_SERVE_PENALTY, 0.05);
});
