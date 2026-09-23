import test from "node:test";
import assert from "node:assert/strict";
import { drawOpenPoseRgb, type NamedLandmarks } from "./openPoseVideo";

const SIZE = 768;
const BLACK = [0, 0, 0];

/** Upright, arms out, spaced so each sampled pixel touches exactly one limb or joint. */
function pose(hidden: string[] = []): NamedLandmarks {
  const lm: NamedLandmarks = {
    NOSE: { x: 0.5, y: 0.2 },
    RIGHT_EYE: { x: 0.48, y: 0.18 },
    LEFT_EYE: { x: 0.52, y: 0.18 },
    RIGHT_EAR: { x: 0.46, y: 0.19 },
    LEFT_EAR: { x: 0.54, y: 0.19 },
    RIGHT_SHOULDER: { x: 0.4, y: 0.3 },
    LEFT_SHOULDER: { x: 0.6, y: 0.3 },
    RIGHT_ELBOW: { x: 0.3, y: 0.4 },
    LEFT_ELBOW: { x: 0.7, y: 0.4 },
    RIGHT_WRIST: { x: 0.25, y: 0.5 },
    LEFT_WRIST: { x: 0.75, y: 0.5 },
    RIGHT_HIP: { x: 0.45, y: 0.6 },
    LEFT_HIP: { x: 0.55, y: 0.6 },
    RIGHT_KNEE: { x: 0.45, y: 0.75 },
    LEFT_KNEE: { x: 0.55, y: 0.75 },
    RIGHT_ANKLE: { x: 0.45, y: 0.9 },
    LEFT_ANKLE: { x: 0.55, y: 0.9 },
  };
  for (const name of hidden) lm[name] = { ...lm[name]!, visibility: 0.1 };
  return lm;
}

function pixelAt(buf: Buffer, x: number, y: number): number[] {
  const px = Math.round(x * SIZE);
  const py = Math.round(y * SIZE);
  const i = (py * SIZE + px) * 3;
  return [buf[i]!, buf[i + 1]!, buf[i + 2]!];
}

test("drawOpenPoseRgb draws the right upper arm as OpenPose limb 2 at 0.6", () => {
  const buf = drawOpenPoseRgb(pose(), SIZE, SIZE);
  // Midpoint of RIGHT_SHOULDER (0.4,0.3) -> RIGHT_ELBOW (0.3,0.4); limb 2 color [255,170,0] * 0.6.
  assert.deepEqual(pixelAt(buf, 0.35, 0.35), [153, 102, 0]);
});

test("drawOpenPoseRgb draws a neck joint at the shoulder midpoint in joint color 1", () => {
  const buf = drawOpenPoseRgb(pose(), SIZE, SIZE);
  assert.deepEqual(pixelAt(buf, 0.5, 0.3), [255, 85, 0]);
});

test("drawOpenPoseRgb no longer draws the shoulder-to-hip torso box", () => {
  const buf = drawOpenPoseRgb(pose(), SIZE, SIZE);
  // Midpoint of RIGHT_SHOULDER (0.4,0.3) -> RIGHT_HIP (0.45,0.6), a bone only the old layout had.
  assert.deepEqual(pixelAt(buf, 0.425, 0.45), BLACK);
});

test("drawOpenPoseRgb omits a hidden wrist's forearm but keeps the upper arm", () => {
  const buf = drawOpenPoseRgb(pose(["RIGHT_WRIST"]), SIZE, SIZE);
  // Forearm midpoint RIGHT_ELBOW (0.3,0.4) -> RIGHT_WRIST (0.25,0.5).
  assert.deepEqual(pixelAt(buf, 0.275, 0.45), BLACK);
  assert.deepEqual(pixelAt(buf, 0.35, 0.35), [153, 102, 0]);
});

/** Ball and racket placed well clear of the skeleton. */
const OVERLAY = {
  ball: { cx: Math.round(0.9 * SIZE), cy: Math.round(0.1 * SIZE), r: 10 },
  racket: { cx: Math.round(0.1 * SIZE), cy: Math.round(0.9 * SIZE), w: 40, h: 40 },
};

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const prev = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("drawOpenPoseRgb draws no ball or racket marker by default", () => {
  withEnv({ CORRECTION_DRAW_BALL: undefined, CORRECTION_DRAW_RACKET_BOX: undefined }, () => {
    const buf = drawOpenPoseRgb(pose(), SIZE, SIZE, OVERLAY);
    assert.deepEqual(pixelAt(buf, 0.9, 0.1), BLACK);
    assert.deepEqual(pixelAt(buf, 0.1, 0.9), BLACK);
  });
});

test("drawOpenPoseRgb draws the ball marker only when CORRECTION_DRAW_BALL is on", () => {
  withEnv({ CORRECTION_DRAW_BALL: "true", CORRECTION_DRAW_RACKET_BOX: undefined }, () => {
    const buf = drawOpenPoseRgb(pose(), SIZE, SIZE, OVERLAY);
    assert.deepEqual(pixelAt(buf, 0.9, 0.1), [255, 220, 0]);
    assert.deepEqual(pixelAt(buf, 0.1, 0.9), BLACK);
  });
});

test("drawOpenPoseRgb drops the neck and its limbs when a shoulder is hidden", () => {
  const buf = drawOpenPoseRgb(pose(["LEFT_SHOULDER"]), SIZE, SIZE);
  assert.deepEqual(pixelAt(buf, 0.5, 0.3), BLACK);
  // Neck (0.5,0.3) -> NOSE (0.5,0.2) midpoint.
  assert.deepEqual(pixelAt(buf, 0.5, 0.25), BLACK);
});
