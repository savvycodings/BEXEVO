import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeUserClips } from "./techniqueClipLimits";

test("sanitizeUserClips caps clip length at 3s", () => {
  const out = sanitizeUserClips([{ startMs: 0, endMs: 8000 }], 10000);
  assert.equal(out?.length, 1);
  assert.equal(out![0]!.endMs - out![0]!.startMs, 3000);
  assert.equal(out![0]!.endMs, 8000);
  assert.equal(out![0]!.startMs, 5000);
});

test("sanitizeUserClips pins end to video duration", () => {
  const out = sanitizeUserClips([{ startMs: 7000, endMs: 12000 }], 10000);
  assert.equal(out![0]!.endMs, 10000);
  assert.equal(out![0]!.startMs, 7000);
});
