import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultPhysicalMetrics,
  normalizePhysicalMetricsOnAnalysis,
  parsePhysicalMetrics,
} from "./physicalMetrics";

test("parsePhysicalMetrics accepts valid LLM block", () => {
  const m = parsePhysicalMetrics({
    stability: 72,
    power: 65,
    agility: 80,
    reactions: 55,
    acceleration: 61,
  });
  assert.ok(m);
  assert.equal(m.stability, 72);
  assert.equal(m.power, 65);
  assert.equal(m.agility, 80);
  assert.equal(m.reactions, 55);
  assert.equal(m.acceleration, 61);
  assert.equal(m.source, "llm");
  assert.equal(m.version, "v1");
});

test("parsePhysicalMetrics clamps and rejects partial blocks", () => {
  assert.equal(parsePhysicalMetrics({ stability: 150, power: 1, agility: 2, reactions: 3 }) , null);
  const m = parsePhysicalMetrics({
    stability: 101,
    power: -5,
    agility: 50.7,
    reactions: 40,
    acceleration: 60,
  });
  assert.ok(m);
  assert.equal(m.stability, 100);
  assert.equal(m.power, 0);
  assert.equal(m.agility, 51);
});

test("normalizePhysicalMetricsOnAnalysis defaults when missing", () => {
  const ai: Record<string, unknown> = { score: 70 };
  const m = normalizePhysicalMetricsOnAnalysis(ai);
  assert.deepEqual(m, defaultPhysicalMetrics());
  assert.deepEqual(ai.physical_metrics, defaultPhysicalMetrics());
});
