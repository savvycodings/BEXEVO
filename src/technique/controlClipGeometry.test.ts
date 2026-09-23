import test from "node:test";
import assert from "node:assert/strict";
import {
  alignedProLandmarksByImpact,
  blendLandmarks,
  controlCanvasSize,
  correctionCanvasSize,
  correctionFunLength,
  smoothLandmarkTrack,
  inferSwingSideFromLandmarks,
  retargetProToUser,
  userLandmarksForFrames,
  type NamedLandmarks,
} from "./openPoseVideo";
import { pickImpactAlignedProPoseFrame } from "./proTimeAlign";
import type { TrainPoseFrame } from "../db/schema";

/** Minimal torso + arms; hip mid at (hx, hy), shoulders one torso length above. */
function body(opts: {
  hx: number;
  hy: number;
  torso: number;
  leftWristDx?: number;
  rightWristDx?: number;
}): NamedLandmarks {
  const { hx, hy, torso } = opts;
  return {
    LEFT_HIP: { x: hx - 0.05, y: hy },
    RIGHT_HIP: { x: hx + 0.05, y: hy },
    LEFT_SHOULDER: { x: hx - 0.05, y: hy - torso },
    RIGHT_SHOULDER: { x: hx + 0.05, y: hy - torso },
    LEFT_WRIST: { x: hx + (opts.leftWristDx ?? -0.1), y: hy - torso * 0.5 },
    RIGHT_WRIST: { x: hx + (opts.rightWristDx ?? 0.1), y: hy - torso * 0.5 },
  };
}

test("retargetProToUser moves the pro onto the user's hips and scales to the user's torso", () => {
  const pro = body({ hx: 0.2, hy: 0.4, torso: 0.4 });
  const user = body({ hx: 0.7, hy: 0.8, torso: 0.2 });

  const out = retargetProToUser(pro, user);

  // Hip midpoint lands on the user's hip midpoint.
  const hipMidX = ((out.LEFT_HIP?.x ?? 0) + (out.RIGHT_HIP?.x ?? 0)) / 2;
  const hipMidY = ((out.LEFT_HIP?.y ?? 0) + (out.RIGHT_HIP?.y ?? 0)) / 2;
  assert.ok(Math.abs(hipMidX - 0.7) < 1e-6, `hip x ${hipMidX}`);
  assert.ok(Math.abs(hipMidY - 0.8) < 1e-6, `hip y ${hipMidY}`);

  // Pro torso was 2x the user's, so it is halved.
  const shoulderMidY = ((out.LEFT_SHOULDER?.y ?? 0) + (out.RIGHT_SHOULDER?.y ?? 0)) / 2;
  assert.ok(Math.abs(hipMidY - shoulderMidY - 0.2) < 1e-6, `torso ${hipMidY - shoulderMidY}`);
});

test("retargetProToUser mirrors about the user's hip x when handedness disagrees", () => {
  const pro = body({ hx: 0.3, hy: 0.5, torso: 0.3, rightWristDx: 0.2 });
  const user = body({ hx: 0.3, hy: 0.5, torso: 0.3 });

  const plain = retargetProToUser(pro, user, { mirror: false });
  const mirrored = retargetProToUser(pro, user, { mirror: true });

  assert.ok(Math.abs((plain.RIGHT_WRIST?.x ?? 0) - 0.5) < 1e-6);
  assert.ok(Math.abs((mirrored.RIGHT_WRIST?.x ?? 0) - 0.1) < 1e-6);
  // Vertical geometry is untouched by the mirror.
  assert.equal(mirrored.RIGHT_WRIST?.y, plain.RIGHT_WRIST?.y);
});

test("retargetProToUser returns the pro pose unchanged when the torso basis is missing", () => {
  const pro = body({ hx: 0.2, hy: 0.4, torso: 0.4 });
  const user: NamedLandmarks = { LEFT_WRIST: { x: 0.5, y: 0.5 } };
  assert.deepEqual(retargetProToUser(pro, user), pro);
});

test("blendLandmarks interpolates and honours the 0 and 1 endpoints", () => {
  const user: NamedLandmarks = { RIGHT_WRIST: { x: 0.2, y: 0.8 } };
  const pro: NamedLandmarks = { RIGHT_WRIST: { x: 0.6, y: 0.4 } };

  const mid = blendLandmarks(user, pro, 0.5);
  assert.ok(Math.abs((mid.RIGHT_WRIST?.x ?? 0) - 0.4) < 1e-9);
  assert.ok(Math.abs((mid.RIGHT_WRIST?.y ?? 0) - 0.6) < 1e-9);

  assert.deepEqual(blendLandmarks(user, pro, 0).RIGHT_WRIST?.x, 0.2);
  assert.deepEqual(blendLandmarks(user, pro, 1).RIGHT_WRIST?.x, 0.6);
});

test("blendLandmarks keeps a joint that only one side has", () => {
  const user: NamedLandmarks = { LEFT_WRIST: { x: 0.1, y: 0.1 } };
  const pro: NamedLandmarks = { RIGHT_WRIST: { x: 0.9, y: 0.9 } };
  const out = blendLandmarks(user, pro, 0.65);
  assert.equal(out.LEFT_WRIST?.x, 0.1);
  assert.equal(out.RIGHT_WRIST?.x, 0.9);
});

test("controlCanvasSize is square unless aspect fitting is explicitly enabled", () => {
  // Asserted against the resolver rather than a literal, so raising the render size for
  // quality does not silently fail this test.
  const cap = correctionCanvasSize();

  // Aspect fitting lands on sizes WAN decodes with its patch grid visible, so the clip
  // aspect is deliberately ignored by default even when we know it.
  assert.deepEqual(controlCanvasSize(1080, 1920), { width: cap, height: cap });
  assert.deepEqual(controlCanvasSize(1920, 1080), { width: cap, height: cap });
  assert.deepEqual(controlCanvasSize(null, null), { width: cap, height: cap });
});

test("controlCanvasSize aspect fitting stays on a multiple of 32 when enabled", () => {
  const prev = process.env.CORRECTION_CANVAS_ASPECT;
  process.env.CORRECTION_CANVAS_ASPECT = "1";
  try {
    const cap = correctionCanvasSize();

    // Within half a 32px step of the aspect-preserving ideal is all the rounding allows.
    const portrait = controlCanvasSize(1080, 1920);
    assert.equal(portrait.height, cap);
    assert.equal(portrait.width % 32, 0);
    assert.ok(Math.abs(portrait.width - (cap * 1080) / 1920) <= 16);

    const landscape = controlCanvasSize(1920, 1080);
    assert.equal(landscape.width, cap);
    assert.equal(landscape.height % 32, 0);
    assert.ok(Math.abs(landscape.height - (cap * 1080) / 1920) <= 16);

    // 32-alignment is what keeps the patch count even in both dimensions.
    assert.equal((portrait.width / 16) % 2, 0);
    assert.equal((landscape.height / 16) % 2, 0);

    assert.deepEqual(controlCanvasSize(null, null), { width: cap, height: cap });
  } finally {
    if (prev == null) delete process.env.CORRECTION_CANVAS_ASPECT;
    else process.env.CORRECTION_CANVAS_ASPECT = prev;
  }
});

test("correctionFunLength snaps to the 4n+1 lengths Fun Control accepts", () => {
  const prev = process.env.CORRECTION_FUN_LENGTH;
  try {
    for (const [set, want] of [["33", 33], ["17", 17], ["30", 29], ["48", 49]] as const) {
      process.env.CORRECTION_FUN_LENGTH = set;
      assert.equal(correctionFunLength(), want);
      assert.equal((correctionFunLength() - 1) % 4, 0);
    }
    delete process.env.CORRECTION_FUN_LENGTH;
    assert.equal(correctionFunLength(), 33);
    assert.equal((correctionFunLength() - 1) % 4, 0);
  } finally {
    if (prev == null) delete process.env.CORRECTION_FUN_LENGTH;
    else process.env.CORRECTION_FUN_LENGTH = prev;
  }
});

test("smoothLandmarkTrack damps a one-frame spike without moving a steady track", () => {
  const steady = [0.2, 0.3, 0.4, 0.5, 0.6].map((x) => ({ RIGHT_WRIST: { x, y: 0.5 } }));
  const smoothedSteady = smoothLandmarkTrack(steady, 1);
  // A constant-velocity track is unchanged by a centred average.
  assert.ok(Math.abs((smoothedSteady[2]!.RIGHT_WRIST?.x ?? 0) - 0.4) < 1e-9);

  const spiky = [0.2, 0.3, 0.9, 0.5, 0.6].map((x) => ({ RIGHT_WRIST: { x, y: 0.5 } }));
  const smoothedSpike = smoothLandmarkTrack(spiky, 1);
  const peak = smoothedSpike[2]!.RIGHT_WRIST?.x ?? 0;
  assert.ok(peak < 0.9 && peak > 0.5, `spike should be damped, got ${peak}`);

  // radius 0 is a passthrough.
  assert.equal(smoothLandmarkTrack(spiky, 0), spiky);
});

test("inferSwingSideFromLandmarks picks the arm with more reach", () => {
  const rightSwing = [body({ hx: 0.5, hy: 0.5, torso: 0.3, rightWristDx: 0.3, leftWristDx: -0.02 })];
  const leftSwing = [body({ hx: 0.5, hy: 0.5, torso: 0.3, rightWristDx: 0.02, leftWristDx: -0.3 })];
  assert.equal(inferSwingSideFromLandmarks(rightSwing), "RIGHT");
  assert.equal(inferSwingSideFromLandmarks(leftSwing), "LEFT");
  assert.equal(inferSwingSideFromLandmarks([{}]), null);
});

test("inferSwingSideFromLandmarks declines to call a side when the arms are level", () => {
  // Symmetric arms: mirroring on this would be a coin flip, so the answer must be null.
  const level = [body({ hx: 0.5, hy: 0.5, torso: 0.3, rightWristDx: 0.2, leftWristDx: -0.2 })];
  assert.equal(inferSwingSideFromLandmarks(level), null);

  // A real 11% reach gap (the observed pro margin) still resolves.
  const clear = [body({ hx: 0.5, hy: 0.5, torso: 0.3, rightWristDx: 0.2, leftWristDx: -0.26 })];
  assert.equal(inferSwingSideFromLandmarks(clear), "LEFT");
});

test("userLandmarksForFrames snaps to the nearest available pose row", () => {
  const rows = [
    { frame: 0, landmarks: { NOSE: { x: 0, y: 0 } } },
    { frame: 10, landmarks: { NOSE: { x: 0.1, y: 0.1 } } },
  ];
  const out = userLandmarksForFrames([0, 4, 9], rows);
  assert.equal(out.length, 3);
  assert.equal(out[0]?.NOSE?.x, 0);
  assert.equal(out[1]?.NOSE?.x, 0);
  assert.equal(out[2]?.NOSE?.x, 0.1);
});

test("pickImpactAlignedProPoseFrame matches phase by offset from contact, not clip position", () => {
  // Pro rows on the stride-5 grid, contact at pro frame 50.
  const proSeq: TrainPoseFrame[] = [];
  for (let f = 0; f <= 100; f += 5) {
    proSeq.push({ frame_idx: f, landmarks: {} });
  }

  const at = (userFrame: number) =>
    pickImpactAlignedProPoseFrame({
      userVideoFrameIndex: userFrame,
      userImpactFrame: 20,
      userFps: 30,
      proSeq,
      proImpactFrame: 50,
      proFps: 30,
    })?.frame_idx;

  assert.equal(at(20), 50); // contact maps to contact
  assert.equal(at(10), 40); // 10 frames before contact
  assert.equal(at(30), 60); // 10 frames after contact
  // Snaps to the nearest available row on the stride-5 grid.
  assert.equal(at(22), 50);
  assert.equal(at(23), 55);
});

test("alignedProLandmarksByImpact stays index-aligned with the requested frames", () => {
  // First row carries no landmarks: output must still be one entry per requested frame.
  const proSeq: TrainPoseFrame[] = [
    { frame_idx: 0, landmarks: {} as TrainPoseFrame["landmarks"] },
    { frame_idx: 5, landmarks: { NOSE: { x: 0.5, y: 0.2 } } },
    { frame_idx: 10, landmarks: { NOSE: { x: 0.6, y: 0.2 } } },
  ];
  const userFrameIndices = [0, 5, 10, 15];
  const out = alignedProLandmarksByImpact({
    userFrameIndices,
    userImpactFrame: 5,
    userFps: 30,
    proSeq,
    proImpactFrame: 5,
    proFps: 30,
  });
  assert.equal(out.length, userFrameIndices.length);
  // The empty leading row borrows the first resolved pose rather than dropping the frame.
  assert.equal(out[0]?.NOSE?.x, 0.5);
  assert.equal(out[1]?.NOSE?.x, 0.5);
  assert.equal(out[3]?.NOSE?.x, 0.6);
});

test("pickImpactAlignedProPoseFrame rescales the offset when fps differ", () => {
  const proSeq: TrainPoseFrame[] = [];
  for (let f = 0; f <= 200; f += 1) {
    proSeq.push({ frame_idx: f, landmarks: {} });
  }
  // 15 user frames before contact at 30fps = 500ms; at 60fps that is 30 pro frames.
  const picked = pickImpactAlignedProPoseFrame({
    userVideoFrameIndex: 15,
    userImpactFrame: 30,
    userFps: 30,
    proSeq,
    proImpactFrame: 100,
    proFps: 60,
  });
  assert.equal(picked?.frame_idx, 70);
});
