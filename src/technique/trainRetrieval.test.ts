import test from "node:test";
import assert from "node:assert/strict";
import {
  buildShotHypothesis,
  type ShotHypothesisNeighbor,
} from "./shotHypothesis";

function neighbor(
  partial: Partial<ShotHypothesisNeighbor> & Pick<ShotHypothesisNeighbor, "stroke_label" | "stroke_preset">
): ShotHypothesisNeighbor {
  return {
    stroke_label: partial.stroke_label,
    stroke_preset: partial.stroke_preset,
    category: partial.category ?? "net_play",
    skill_level: partial.skill_level ?? "Advanced",
    distance: partial.distance ?? 0.1,
  };
}

test("buildShotHypothesis uses label vote only — preset disagreement does not change stroke_label", () => {
  const hyp = buildShotHypothesis([
    neighbor({
      stroke_label: "Por Cuatro Smash",
      stroke_preset: "half_volley",
      category: "net_play",
      distance: 0.12,
    }),
    neighbor({
      stroke_label: "Por Cuatro Smash",
      stroke_preset: "forehand_lob",
      category: "net_play",
      distance: 0.14,
    }),
    neighbor({
      stroke_label: "Half Volley",
      stroke_preset: "half_volley",
      category: "net_play",
      distance: 0.2,
    }),
  ]);
  assert.equal(hyp.stroke_label, "Por Cuatro Smash");
  assert.equal(hyp.category, "net_play");
  assert.ok(hyp.stroke_preset);
});

test("buildShotHypothesis category and skill_level from winning label cluster", () => {
  const hyp = buildShotHypothesis([
    neighbor({
      stroke_label: "Forehand Half Volley",
      stroke_preset: "back_wall_forehand",
      category: "defence_glass",
      skill_level: "Intermediate",
      distance: 0.11,
    }),
    neighbor({
      stroke_label: "Forehand Half Volley",
      stroke_preset: "half_volley",
      category: "defence_glass",
      skill_level: "Advanced",
      distance: 0.13,
    }),
  ]);
  assert.equal(hyp.stroke_label, "Forehand Half Volley");
  assert.equal(hyp.category, "defence_glass");
  assert.equal(hyp.skill_level, "Intermediate");
});
