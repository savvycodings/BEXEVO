import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeBodyMeasurements, parseBodyMeasurements } from "./bodyMeasurements";

test("accepts singles and pairs in range and rounds to a tenth", () => {
  const r = parseBodyMeasurements({ shoulder: 46.04, arm: { left: 65, right: "64.96" }, waist: null });
  assert.deepEqual(r, { ok: true, value: { shoulder: 46, arm: { left: 65, right: 65 }, waist: null } });
});

test("rejects out-of-range values with the key in the message", () => {
  const r = parseBodyMeasurements({ calfCirc: { left: 10, right: 30 } });
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /calfCirc\.left/);
});

test("rejects unknown keys, empty bodies and non-objects", () => {
  assert.equal(parseBodyMeasurements({ shoulders: 40 }).ok, false);
  assert.equal(parseBodyMeasurements({}).ok, false);
  assert.equal(parseBodyMeasurements([1]).ok, false);
  assert.equal(parseBodyMeasurements({ arm: 60 }).ok, false);
  assert.equal(parseBodyMeasurements({ chest: "abc" }).ok, false);
});

test("merge keeps untouched keys and drops cleared ones", () => {
  const merged = mergeBodyMeasurements(
    { shoulder: 46, chest: 100, arm: { left: 65, right: 65 } },
    { chest: null, arm: { left: null, right: null }, hip: 40 }
  );
  assert.deepEqual(merged, { shoulder: 46, hip: 40 });
});
