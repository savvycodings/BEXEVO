import test from "node:test";
import assert from "node:assert/strict";
import { adminStrokeLabelKey, deriveHumanShotLabelFromMetrics } from "./trainShotDisplay";

test("adminStrokeLabelKey prefers strokeLabel column", () => {
  assert.equal(
    adminStrokeLabelKey("Drop Shot forehand", "Contrapared boast · Advanced"),
    "Drop Shot forehand"
  );
});

test("adminStrokeLabelKey strips level from strokeName when label missing", () => {
  assert.equal(
    adminStrokeLabelKey(null, "Forehand Half Volley · Advanced"),
    "Forehand Half Volley"
  );
});

test("deriveHumanShotLabelFromMetrics uses neighbor stroke_name before preset", () => {
  const label = deriveHumanShotLabelFromMetrics({
    retrieval: {
      shot_hypothesis: { stroke_preset: "half_volley" },
      neighbors: [
        {
          stroke_name: "Forehand Half Volley · Advanced",
          stroke_preset: "half_volley",
        },
      ],
    },
  });
  assert.equal(label, "Forehand Half Volley");
});

test("deriveHumanShotLabelFromMetrics ignores preset-like stroke_label on hypothesis", () => {
  const label = deriveHumanShotLabelFromMetrics({
    retrieval: {
      shot_hypothesis: { stroke_label: "half_volley", stroke_preset: "half_volley" },
      neighbors: [
        {
          stroke_label: "Forehand Half Volley",
          stroke_name: "Forehand Half Volley · Advanced",
        },
      ],
    },
  });
  assert.equal(label, "Forehand Half Volley");
});
