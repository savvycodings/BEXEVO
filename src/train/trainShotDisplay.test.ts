import test from "node:test";
import assert from "node:assert/strict";
import {
  adminStrokeLabelKey,
  deriveHumanShotLabelFromMetrics,
  resolveCanonicalShotFromMetrics,
  RETRIEVAL_CONFIDENCE_THRESHOLD,
} from "./trainShotDisplay";

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

test("resolveCanonicalShotFromMetrics uses hypothesis when confidence >= threshold", () => {
  const r = resolveCanonicalShotFromMetrics({
    retrieval: {
      shot_hypothesis: {
        stroke_label: "Por Cuatro Smash",
        stroke_preset: "half_volley",
        confidence: RETRIEVAL_CONFIDENCE_THRESHOLD,
        category: "net_play",
      },
      neighbors: [],
    },
  });
  assert.equal(r.shotName, "Por Cuatro Smash");
  assert.equal(r.source, "retrieval_hypothesis");
  assert.equal(r.category, "net_play");
});

test("resolveCanonicalShotFromMetrics does not use stroke_preset for display", () => {
  const r = resolveCanonicalShotFromMetrics({
    retrieval: {
      shot_hypothesis: {
        stroke_label: "half_volley",
        stroke_preset: "half_volley",
        confidence: 0.9,
      },
      neighbors: [
        {
          stroke_label: "Forehand Half Volley",
          stroke_name: "Forehand Half Volley · Advanced",
        },
      ],
    },
  });
  assert.equal(r.shotName, "Forehand Half Volley");
  assert.equal(r.source, "neighbor");
});

test("deriveHumanShotLabelFromMetrics delegates to resolveCanonicalShotFromMetrics", () => {
  const label = deriveHumanShotLabelFromMetrics({
    retrieval: {
      shot_hypothesis: {
        stroke_label: "Drop Shot forehand",
        confidence: 0.5,
      },
      neighbors: [],
    },
  });
  assert.equal(label, "Drop Shot forehand");
});

test("resolveCanonicalShotFromMetrics low confidence uses top neighbor label not category pillar", () => {
  const r = resolveCanonicalShotFromMetrics({
    retrieval: {
      shot_hypothesis: {
        stroke_label: "Forehand drive · Save & return",
        confidence: 0.04,
        category: "save_return",
      },
      neighbor_distance_gap: 0.005,
      neighbors: [
        {
          stroke_label: "Forehand drive · Save & return",
          distance: 0.106,
          category: "save_return",
          stroke_preset: "forehand_drive",
        },
        {
          stroke_label: "Bandeja 1",
          distance: 0.112,
          category: "overhead",
          stroke_preset: "bandeja",
        },
      ],
    },
  });
  assert.equal(r.source, "neighbor");
  assert.equal(r.shotName, "Forehand drive · Save & return");
});

test("resolveCanonicalShotFromMetrics category fallback only when top label unusable", () => {
  const r = resolveCanonicalShotFromMetrics({
    retrieval: {
      shot_hypothesis: { stroke_label: "half_volley", confidence: 0.02, category: "net_play" },
      neighbor_distance_gap: 0.008,
      neighbors: [
        {
          stroke_label: "half_volley",
          distance: 0.01,
          category: "net_play",
          stroke_preset: "half_volley",
        },
        {
          stroke_label: "Forehand Return",
          distance: 0.018,
          category: "save_return",
          stroke_preset: "forehand_return_with_lob",
        },
      ],
    },
  });
  assert.equal(r.source, "low_confidence_fallback");
  assert.equal(r.shotName, "Net Play");
});

test("resolveCanonicalShotFromMetrics uses rerank top bandeja over Save Return fallback", () => {
  const r = resolveCanonicalShotFromMetrics({
    retrieval: {
      shot_hypothesis: {
        stroke_label: "Flat Serve",
        confidence: 0,
        category: "save_return",
      },
      neighbor_distance_gap: 0,
      rerank: { applied: true, supports_overhead: true },
      neighbors: [
        {
          stroke_label: "Bandeja 1",
          stroke_preset: "bandeja",
          category: "overhead",
          distance: 0.112,
        },
        {
          stroke_label: "Flat Serve",
          stroke_preset: "forehand_drive",
          category: "save_return",
          distance: 0.156,
        },
      ],
    },
  });
  assert.equal(r.shotName, "Bandeja 1");
  assert.equal(r.source, "rerank_neighbor");
  assert.equal(r.category, "overhead");
});

test("deriveHumanShotLabelFromMetrics uses neighbor when hypothesis confidence low", () => {
  const label = deriveHumanShotLabelFromMetrics({
    retrieval: {
      shot_hypothesis: { stroke_preset: "half_volley", confidence: 0.1 },
      neighbors: [
        {
          stroke_name: "Forehand Half Volley · Advanced",
          stroke_preset: "half_volley",
          stroke_label: "Forehand Half Volley",
        },
      ],
    },
  });
  assert.equal(label, "Forehand Half Volley");
});
