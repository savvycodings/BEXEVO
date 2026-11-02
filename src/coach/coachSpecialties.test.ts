import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSpecialties, visibleSpecialties } from "./coachSpecialties";

test("sorts into catalog order", () => {
  assert.deepEqual(normalizeSpecialties(["matchplay", "technique", "tactics"]), {
    ok: true,
    specialties: ["technique", "tactics", "matchplay"],
  });
});

test("drops duplicates", () => {
  assert.deepEqual(normalizeSpecialties(["fitness", "fitness", "mental"]), {
    ok: true,
    specialties: ["fitness", "mental"],
  });
});

test("rejects six distinct keys", () => {
  const r = normalizeSpecialties(["technique", "tactics", "matchplay", "fitness", "mental", "juniors"]);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error, "too_many");
});

test("five keys with duplicates is fine", () => {
  const r = normalizeSpecialties(["competition", "technique", "tactics", "matchplay", "fitness", "technique"]);
  assert.deepEqual(r, { ok: true, specialties: ["technique", "tactics", "matchplay", "fitness", "competition"] });
});

test("rejects an unknown key", () => {
  const r = normalizeSpecialties(["technique", "volleys"]);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error, "unknown_key");
});

test("rejects a non-array", () => {
  assert.equal(normalizeSpecialties("technique").ok, false);
  assert.equal(normalizeSpecialties(undefined).ok, false);
});

test("an empty list clears", () => {
  assert.deepEqual(normalizeSpecialties([]), { ok: true, specialties: [] });
});

test("only coaches show their stored list", () => {
  assert.deepEqual(visibleSpecialties("coach", ["technique"]), ["technique"]);
  assert.deepEqual(visibleSpecialties("student", ["technique"]), []);
  assert.deepEqual(visibleSpecialties("coach", null), []);
});
