// `../gamification/stats` imports `../db`, which throws at module load without DATABASE_URL.
import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import { shotCardFields } from "./activityShotFields";

test("shotCardFields returns stability/power/agility only", () => {
  const f = shotCardFields({
    ai_analysis: {
      physical_metrics: { stability: 82, power: 71, agility: 64, reactions: 70, acceleration: 60 },
    },
  });
  assert.deepEqual(f.physicalMetrics, { stability: 82, power: 71, agility: 64 });
});

test("shotCardFields returns null metrics when missing or invalid", () => {
  assert.equal(shotCardFields({ ai_analysis: {} }).physicalMetrics, null);
  assert.equal(
    shotCardFields({ ai_analysis: { physical_metrics: { stability: "x" } } }).physicalMetrics,
    null
  );
  assert.equal(shotCardFields(null).physicalMetrics, null);
});

test("shotCardFields reads the category from the AI analysis", () => {
  assert.equal(
    shotCardFields({ ai_analysis: { primary_train_category: "net_play" } }).category,
    "net_play"
  );
});

test("shotCardFields returns null category when none resolves", () => {
  assert.equal(shotCardFields({ ai_analysis: { primary_train_category: "bogus" } }).category, null);
  assert.equal(shotCardFields(undefined).category, null);
});
