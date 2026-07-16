import test from "node:test";
import assert from "node:assert/strict";
import { resolveImpactFrameIndex } from "./resolveImpactFrame";

const TOTAL_FRAMES = 160;
const VIDEO_MS = 3000;

test("full clip + contacts 0-24 uses yolo median not clip end", () => {
  const r = resolveImpactFrameIndex({
    clip: { startMs: 0, endMs: 3000 },
    totalFrames: TOTAL_FRAMES,
    videoDurationMs: VIDEO_MS,
    contactFrames: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 19, 20, 21, 22, 23, 24],
  });
  assert.equal(r.source, "yolo_median");
  assert.ok(r.impactFrameIndex < 30, `expected early contact frame, got ${r.impactFrameIndex}`);
  assert.notEqual(r.impactFrameIndex, 159);
});

test("narrow mid-clip + contacts outside clip uses clip_center", () => {
  const r = resolveImpactFrameIndex({
    clip: { startMs: 838, endMs: 1732 },
    totalFrames: TOTAL_FRAMES,
    videoDurationMs: VIDEO_MS,
    contactFrames: [0, 1, 2, 3, 4, 5, 10, 15, 20, 24],
  });
  assert.equal(r.source, "clip_center");
  const fps = TOTAL_FRAMES / (VIDEO_MS / 1000);
  const centerFrame = Math.round(((838 + 1732) / 2 / 1000) * fps);
  assert.ok(Math.abs(r.impactFrameIndex - centerFrame) <= 2);
  assert.notEqual(r.impactFrameIndex, 92);
});

test("no contacts + narrow clip uses clip_end (UI marks hit at endMs)", () => {
  const r = resolveImpactFrameIndex({
    clip: { startMs: 861, endMs: 2243 },
    totalFrames: 89,
    videoDurationMs: 3000,
    contactFrames: [],
  });
  assert.equal(r.source, "clip_end");
  const fps = 89 / (3000 / 1000);
  assert.equal(r.impactFrameIndex, Math.round((2243 / 1000) * fps));
});

test("no contacts falls back to clip_end when clip spans most of video", () => {
  const r = resolveImpactFrameIndex({
    clip: { startMs: 200, endMs: 2900 },
    totalFrames: TOTAL_FRAMES,
    videoDurationMs: VIDEO_MS,
    contactFrames: [],
  });
  assert.equal(r.source, "clip_end");
  const fps = TOTAL_FRAMES / (VIDEO_MS / 1000);
  assert.equal(r.impactFrameIndex, Math.round((2900 / 1000) * fps));
});

test("contacts inside narrow clip use yolo_median", () => {
  const r = resolveImpactFrameIndex({
    clip: { startMs: 800, endMs: 1800 },
    totalFrames: TOTAL_FRAMES,
    videoDurationMs: VIDEO_MS,
    contactFrames: [50, 52, 55, 58, 60],
  });
  assert.equal(r.source, "yolo_median");
  assert.equal(r.impactFrameIndex, 55);
});
