import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeRacket, parseRacket } from "./racket";

test("accepts the design's racket and normalises values", () => {
  const r = parseRacket({ brand: " Adidas ", model: "Metalbone  3.4 2025", weightG: "360", balanceCm: 26.54, lengthMm: 455, grip: "L3", swingweight: 325, surface: "Carbon 12K" });
  assert.deepEqual(r, { ok: true, value: { brand: "Adidas", model: "Metalbone 3.4 2025", weightG: 360, balanceCm: 26.5, lengthMm: 455, grip: "L3", swingweight: 325, surface: "Carbon 12K" } });
});

test("rejects out-of-range numbers, wrong types and unknown keys", () => {
  assert.equal(parseRacket({ weightG: 36 }).ok, false);
  assert.equal(parseRacket({ brand: 5 }).ok, false);
  assert.equal(parseRacket({ colour: "red" }).ok, false);
  assert.equal(parseRacket({}).ok, false);
  assert.equal(parseRacket({ model: "x".repeat(81) }).ok, false);
});

test("null and empty clear on merge", () => {
  const p = parseRacket({ brand: "", weightG: null, model: "Vertex 04" });
  assert.ok(p.ok);
  assert.deepEqual(mergeRacket({ brand: "Bullpadel", weightG: 365, grip: "L2" }, p.value), { grip: "L2", model: "Vertex 04" });
});
