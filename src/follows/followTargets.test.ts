import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTarget } from "./followTargets";

test("country codes are returned uppercase", () => {
  assert.deepEqual(normalizeTarget("country", "es"), {
    ok: true,
    target: { targetType: "country", targetId: "ES" },
  });
  assert.deepEqual(normalizeTarget("country", "AR"), {
    ok: true,
    target: { targetType: "country", targetId: "AR" },
  });
});

test("country names and non-letter codes are rejected", () => {
  assert.deepEqual(normalizeTarget("country", "Spain"), { ok: false, error: "bad_target_id" });
  assert.deepEqual(normalizeTarget("country", "E1"), { ok: false, error: "bad_target_id" });
  assert.deepEqual(normalizeTarget("country", ""), { ok: false, error: "bad_target_id" });
});

test("unknown target types are rejected", () => {
  assert.deepEqual(normalizeTarget("club", "abc"), { ok: false, error: "bad_target_type" });
  assert.deepEqual(normalizeTarget("player", "abc"), { ok: false, error: "bad_target_type" });
  assert.deepEqual(normalizeTarget(undefined, "abc"), { ok: false, error: "bad_target_type" });
});

test("coach ids must be non-empty", () => {
  assert.deepEqual(normalizeTarget("coach", ""), { ok: false, error: "bad_target_id" });
  assert.deepEqual(normalizeTarget("coach", "   "), { ok: false, error: "bad_target_id" });
  assert.deepEqual(normalizeTarget("coach", "user_123"), {
    ok: true,
    target: { targetType: "coach", targetId: "user_123" },
  });
});
