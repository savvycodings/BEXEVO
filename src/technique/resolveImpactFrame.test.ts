import test from "node:test";
import assert from "node:assert/strict";
import { contactRuns, resolveImpactFrameIndex } from "./resolveImpactFrame";

const TOTAL_FRAMES = 160;
const VIDEO_MS = 3000;

test("full clip + contacts 0-24 uses yolo cluster not clip end", () => {
  const r = resolveImpactFrameIndex({
    clip: { startMs: 0, endMs: 3000 },
    totalFrames: TOTAL_FRAMES,
    videoDurationMs: VIDEO_MS,
    contactFrames: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 19, 20, 21, 22, 23, 24],
  });
  assert.equal(r.source, "yolo_cluster");
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

test("contacts inside narrow clip use yolo_cluster", () => {
  const r = resolveImpactFrameIndex({
    clip: { startMs: 800, endMs: 1800 },
    totalFrames: TOTAL_FRAMES,
    videoDurationMs: VIDEO_MS,
    contactFrames: [50, 52, 55, 58, 60],
  });
  assert.equal(r.source, "yolo_cluster");
  assert.equal(r.impactFrameIndex, 55);
});

/** a10 / cb230cdc: ball seen beside the racket in the backswing, real hit around 42-45. */
const A10_CONTACTS = [0, 1, 2, 3, 4, 5, 10, 13, 14, 15, 16, 17, 18, 29, 30, 31, 32, 33, 34, 40, 41, 42, 43, 44, 45];

function poseWithWristPeak(totalFrames: number, peakFrame: number) {
  const out: Array<{ frame: number; landmarks: Record<string, { x: number; y: number }> }> = [];
  let x = 0.3;
  for (let f = 0; f < totalFrames; f++) {
    x += Math.abs(f - peakFrame) <= 1 ? 0.06 : 0.005;
    out.push({ frame: f, landmarks: { RIGHT_WRIST: { x, y: 0.5 }, LEFT_WRIST: { x: 0.6, y: 0.5 } } });
  }
  return out;
}

test("contactRuns splits on gaps above 3 frames", () => {
  assert.deepEqual(contactRuns(A10_CONTACTS).map((r) => [r[0], r[r.length - 1]]), [
    [0, 5],
    [10, 18],
    [29, 34],
    [40, 45],
  ]);
});

test("user-marked contact wins over YOLO", () => {
  const r = resolveImpactFrameIndex({
    clip: { startMs: 0, endMs: 3000 },
    totalFrames: 90,
    videoDurationMs: 3000,
    contactFrames: A10_CONTACTS,
    userContactMs: 1450,
  });
  assert.equal(r.source, "user_marked");
  assert.equal(r.impactFrameIndex, Math.round(1.45 * 30));
  assert.equal(r.impactMs, 1450);
});

test("user-marked contact outside the video is ignored", () => {
  const r = resolveImpactFrameIndex({
    clip: { startMs: 0, endMs: 3000 },
    totalFrames: 90,
    videoDurationMs: 3000,
    contactFrames: A10_CONTACTS,
    userContactMs: 9000,
  });
  assert.equal(r.source, "yolo_cluster");
});

test("a10 contacts without pose pick the last run, not the median", () => {
  const r = resolveImpactFrameIndex({
    clip: { startMs: 0, endMs: 3000 },
    totalFrames: 90,
    videoDurationMs: 3000,
    contactFrames: A10_CONTACTS,
  });
  assert.equal(r.source, "yolo_cluster");
  assert.ok(r.impactFrameIndex >= 42 && r.impactFrameIndex <= 45, `got ${r.impactFrameIndex}`);
});

test("a10 contacts with a wrist speed peak pick the run at the peak", () => {
  const r = resolveImpactFrameIndex({
    clip: { startMs: 0, endMs: 3000 },
    totalFrames: 90,
    videoDurationMs: 3000,
    contactFrames: A10_CONTACTS,
    poseData: poseWithWristPeak(90, 43),
  });
  assert.equal(r.impactFrameIndex, 43);
});

test("wrist peak between runs snaps into the nearest run", () => {
  const r = resolveImpactFrameIndex({
    clip: { startMs: 0, endMs: 3000 },
    totalFrames: 90,
    videoDurationMs: 3000,
    contactFrames: A10_CONTACTS,
    poseData: poseWithWristPeak(90, 37),
  });
  assert.equal(r.impactFrameIndex, 40);
});
