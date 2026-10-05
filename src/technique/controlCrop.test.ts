import test from "node:test";
import assert from "node:assert/strict";
import {
  boxToCanvas,
  frameToCanvas,
  framesToCanvas,
  pickControlCrop,
  type NamedLandmarks,
} from "./openPoseVideo";

function hips(x: number, y: number): NamedLandmarks {
  return {
    LEFT_HIP: { x: x - 0.02, y },
    RIGHT_HIP: { x: x + 0.02, y },
  };
}

const portrait = { srcW: 1080, srcH: 1920, canvasW: 768, canvasH: 768 };

test("pickControlCrop centres a square on the hips of a portrait clip", () => {
  const crop = pickControlCrop({ ...portrait, userFrames: [hips(0.5, 0.5)] });
  assert.deepEqual(crop, { x: 0, y: 420, w: 1080, h: 1080 });
});

test("pickControlCrop clamps a low player inside the frame", () => {
  const crop = pickControlCrop({
    ...portrait,
    userFrames: [hips(0.5, 0.85), hips(0.5, 0.86), hips(0.5, 0.84)],
  });
  assert.deepEqual(crop, { x: 0, y: 840, w: 1080, h: 1080 });
});

test("pickControlCrop falls back to the frame centre without hips", () => {
  const crop = pickControlCrop({ ...portrait, userFrames: [{}, {}] });
  assert.deepEqual(crop, { x: 0, y: 420, w: 1080, h: 1080 });
});

test("pickControlCrop centres horizontally on a landscape clip", () => {
  const crop = pickControlCrop({
    srcW: 1920,
    srcH: 1080,
    canvasW: 768,
    canvasH: 768,
    userFrames: [],
  });
  assert.deepEqual(crop, { x: 420, y: 0, w: 1080, h: 1080 });
});

test("frameToCanvas maps the crop centre and corners", () => {
  const crop = { x: 0, y: 420, w: 1080, h: 1080 };
  const centre = frameToCanvas({ x: 0.5, y: 0.5, visibility: 0.9 }, crop, 1080, 1920);
  assert.ok(Math.abs(centre.x - 0.5) < 1e-9 && Math.abs(centre.y - 0.5) < 1e-9);
  assert.equal(centre.visibility, 0.9);
  const tl = frameToCanvas({ x: 0, y: 420 / 1920 }, crop, 1080, 1920);
  const br = frameToCanvas({ x: 1, y: 1500 / 1920 }, crop, 1080, 1920);
  assert.ok(Math.abs(tl.x) < 1e-9 && Math.abs(tl.y) < 1e-9);
  assert.ok(Math.abs(br.x - 1) < 1e-9 && Math.abs(br.y - 1) < 1e-9);
});

test("framesToCanvas and boxToCanvas are the identity when the crop is the whole frame", () => {
  const crop = { x: 0, y: 0, w: 768, h: 768 };
  const frames: NamedLandmarks[] = [{ NOSE: { x: 0.3, y: 0.7, z: -0.1, visibility: 0.5 } }];
  const out = framesToCanvas(frames, crop, 768, 768);
  assert.ok(Math.abs(out[0]!.NOSE!.x - 0.3) < 1e-9);
  assert.ok(Math.abs(out[0]!.NOSE!.y - 0.7) < 1e-9);
  assert.equal(out[0]!.NOSE!.z, -0.1);
  const box = boxToCanvas([0.1, 0.2, 0.3, 0.4], crop, 768, 768);
  [0.1, 0.2, 0.3, 0.4].forEach((v, i) => assert.ok(Math.abs(box[i]! - v) < 1e-9));
});
