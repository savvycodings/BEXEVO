import test from "node:test";
import assert from "node:assert/strict";
import {
  filterTrainNeighborsForRetrieval,
  isExcludedTrainNeighbor,
  type TrainNeighborCandidate,
} from "./trainRetrievalHygiene";

function row(
  partial: Partial<TrainNeighborCandidate> & Pick<TrainNeighborCandidate, "stroke_label" | "stroke_preset">
): TrainNeighborCandidate {
  return {
    train_sample_id: "s1",
    train_video_id: "v1",
    stroke_name: `${partial.stroke_label} · Advanced`,
    stroke_label: partial.stroke_label,
    category: partial.category ?? "overhead",
    stroke_preset: partial.stroke_preset,
    skill_level: "advanced",
    distance: partial.distance ?? 0.1,
    extraction_meta: partial.extraction_meta ?? null,
  };
}

test("excludes Por Cuatro Smash on forehand_lob preset", () => {
  assert.ok(
    isExcludedTrainNeighbor(
      row({ stroke_label: "Por Cuatro Smash", stroke_preset: "forehand_lob" })
    )
  );
});

test("filter keeps valid neighbors and drops mislabeled", () => {
  const filtered = filterTrainNeighborsForRetrieval([
    row({ stroke_label: "Por Cuatro Smash", stroke_preset: "forehand_lob", distance: 0.05 }),
    row({ stroke_label: "Forehand Lob", stroke_preset: "forehand_lob", distance: 0.1 }),
  ]);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]!.stroke_label, "Forehand Lob");
});
