import test from "node:test";
import assert from "node:assert/strict";
import {
  alignedProLandmarksByImpact,
  blendLandmarks,
  coachedControlLandmarkFrames,
  controlCanvasSize,
  correctionCanvasSize,
  correctionFunLength,
  smoothLandmarkTrack,
  inferSwingSideFromLandmarks,
  fillJointGaps,
  blendArmsByAngle,
  restoreLimbLengths,
  inferFacing,
  proOrientationPlan,
  rejectBodySizeOutliers,
  retargetProToUser,
  userLandmarksForFrames,
  windowRetargetScale,
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

test("retargetProToUser mirrors about the user's hip x, swapping sides, for the other arm", () => {
  const pro = body({ hx: 0.3, hy: 0.5, torso: 0.3, rightWristDx: 0.2 });
  const user = body({ hx: 0.3, hy: 0.5, torso: 0.3 });

  const plain = retargetProToUser(pro, user);
  const mirrored = retargetProToUser(pro, user, { flipX: true, swapSides: true });

  assert.ok(Math.abs((plain.RIGHT_WRIST?.x ?? 0) - 0.5) < 1e-6);
  // Coordinates flip about the hip and sides swap, as in a mirror: the right-arm reach is
  // now a left arm.
  assert.ok(Math.abs((mirrored.LEFT_WRIST?.x ?? 0) - 0.1) < 1e-6);
  assert.ok(Math.abs((mirrored.RIGHT_WRIST?.x ?? 0) - 0.4) < 1e-6);
  assert.equal(mirrored.LEFT_WRIST?.y, plain.RIGHT_WRIST?.y);
});

test("coachedControlLandmarkFrames blends a mirrored pro's swinging arm into the user's", () => {
  // User swings with the left arm (reach 0.2), pro with the right (reach 0.3).
  const user = body({ hx: 0.5, hy: 0.5, torso: 0.3, leftWristDx: -0.2, rightWristDx: 0.05 });
  const pro = body({ hx: 0.5, hy: 0.5, torso: 0.3, leftWristDx: -0.05, rightWristDx: 0.3 });

  const [out] = coachedControlLandmarkFrames({
    userFrames: [user],
    proFrames: [pro],
    flipX: true,
    swapSides: true,
    blend: 0.5,
  });

  // The pro's right-arm reach (x 0.8) mirrors to x 0.2 as LEFT_WRIST, so the user's swinging
  // left wrist (0.3) moves halfway toward it. The free arm pairs with the pro's free arm, which
  // mirrors onto the user's own right wrist (0.55) and so does not move.
  assert.ok(Math.abs((out?.LEFT_WRIST?.x ?? 0) - 0.25) < 1e-6, `left ${out?.LEFT_WRIST?.x}`);
  assert.ok(Math.abs((out?.RIGHT_WRIST?.x ?? 0) - 0.55) < 1e-6, `right ${out?.RIGHT_WRIST?.x}`);
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

/** Pro pose with ankles below the hips; `torso` alone shrinks when the trunk foreshortens. */
function proWithLegs(torso: number): NamedLandmarks {
  const lm = body({ hx: 0.5, hy: 0.5, torso });
  lm.LEFT_ANKLE = { x: 0.45, y: 0.9 };
  lm.RIGHT_ANKLE = { x: 0.55, y: 0.9 };
  return lm;
}

test("coachedControlLandmarkFrames keeps the pro size constant when one torso foreshortens", () => {
  const user = body({ hx: 0.5, hy: 0.6, torso: 0.2 });
  const proFrames = [proWithLegs(0.4), proWithLegs(0.4), proWithLegs(0.34), proWithLegs(0.4), proWithLegs(0.4)];
  const out = coachedControlLandmarkFrames({
    userFrames: proFrames.map(() => user),
    proFrames,
    blend: 1,
  });
  const legSpan = (lm: NamedLandmarks) => (lm.LEFT_ANKLE?.y ?? 0) - (lm.LEFT_HIP?.y ?? 0);
  for (const i of [1, 2, 3]) {
    assert.ok(Math.abs(legSpan(out[i]!) - legSpan(out[0]!)) < 1e-9, `frame ${i} leg ${legSpan(out[i]!)}`);
  }
  // Median pro torso is 0.4, user 0.2, so legs (0.4 long on the pro) come out at 0.2.
  assert.ok(Math.abs(legSpan(out[2]!) - 0.2) < 1e-9);
});

test("windowRetargetScale is null without a torso on both sides", () => {
  assert.equal(windowRetargetScale([{}], [proWithLegs(0.4)]), null);
  assert.ok(Math.abs((windowRetargetScale([body({ hx: 0.5, hy: 0.5, torso: 0.1 })], [proWithLegs(0.4)]) ?? 0) - 0.25) < 1e-9);
});

/** The same pose shrunk about a new hip point, like a tracker that jumped to a smaller background figure. */
function shrunk(lm: NamedLandmarks, k: number, hx: number, hy: number): NamedLandmarks {
  const out: NamedLandmarks = {};
  const ox = ((lm.LEFT_HIP?.x ?? 0) + (lm.RIGHT_HIP?.x ?? 0)) / 2;
  const oy = ((lm.LEFT_HIP?.y ?? 0) + (lm.RIGHT_HIP?.y ?? 0)) / 2;
  for (const [name, p] of Object.entries(lm)) {
    if (p) out[name] = { x: hx + (p.x - ox) * k, y: hy + (p.y - oy) * k };
  }
  return out;
}

test("rejectBodySizeOutliers rebuilds a frame where the whole body shrinks", () => {
  const frames = [0.50, 0.52, 0.54, 0.56, 0.58].map((hx) => body({ hx, hy: 0.6, torso: 0.2 }));
  frames[2] = shrunk(frames[2]!, 0.6, 0.15, 0.4);
  const { frames: out, replaced } = rejectBodySizeOutliers(frames, { tolerance: 0.2 });
  assert.deepEqual(replaced, [2]);
  // Halfway between its neighbours: hips back at x 0.54, torso back to 0.2.
  const hipX = ((out[2]!.LEFT_HIP?.x ?? 0) + (out[2]!.RIGHT_HIP?.x ?? 0)) / 2;
  assert.ok(Math.abs(hipX - 0.54) < 1e-9, `hip x ${hipX}`);
  assert.ok(Math.abs((out[2]!.LEFT_HIP!.y - out[2]!.LEFT_SHOULDER!.y) - 0.2) < 1e-9);
  assert.equal(out[1], frames[1]);
});

test("rejectBodySizeOutliers keeps a frame where only the torso foreshortens", () => {
  const frames = [0.2, 0.2, 0.17, 0.2, 0.2].map((torso) => body({ hx: 0.5, hy: 0.6, torso }));
  const res = rejectBodySizeOutliers(frames, { tolerance: 0.2 });
  assert.deepEqual(res.replaced, []);
  assert.equal(res.frames, frames);
});

test("rejectBodySizeOutliers copies the nearest good frame at the ends", () => {
  const frames = [0, 1, 2, 3].map(() => body({ hx: 0.5, hy: 0.6, torso: 0.2 }));
  frames[3] = shrunk(frames[3]!, 0.55, 0.2, 0.3);
  const { frames: out, replaced } = rejectBodySizeOutliers(frames, { tolerance: 0.2 });
  assert.deepEqual(replaced, [3]);
  assert.equal(out[3], frames[2]);
});

test("rejectBodySizeOutliers keeps a player who grows steadily toward the camera", () => {
  // Closing on the net: torso grows 0.15 -> 0.25 over the window, well past 20% of its median.
  const frames = Array.from({ length: 21 }, (_, i) =>
    body({ hx: 0.5, hy: 0.6, torso: 0.15 + (0.1 * i) / 20 })
  );
  const res = rejectBodySizeOutliers(frames, { tolerance: 0.2 });
  assert.deepEqual(res.replaced, []);
});

test("rejectBodySizeOutliers still catches a two-frame jump inside steady growth", () => {
  const frames = Array.from({ length: 21 }, (_, i) =>
    body({ hx: 0.5, hy: 0.6, torso: 0.15 + (0.1 * i) / 20 })
  );
  frames[10] = shrunk(frames[10]!, 0.6, 0.15, 0.4);
  frames[11] = shrunk(frames[11]!, 0.6, 0.15, 0.4);
  const res = rejectBodySizeOutliers(frames, { tolerance: 0.2 });
  assert.deepEqual(res.replaced, [10, 11]);
});

test("inferSwingSideFromLandmarks ignores frames where one wrist is hidden", () => {
  // Left arm reaches further whenever both are seen, but is occluded on most frames.
  const both = body({ hx: 0.5, hy: 0.5, torso: 0.3, leftWristDx: -0.3, rightWristDx: 0.1 });
  const leftHidden: NamedLandmarks = {
    ...both,
    LEFT_WRIST: { ...both.LEFT_WRIST!, visibility: 0.05 },
  };
  const frames = [both, both, leftHidden, leftHidden, leftHidden, leftHidden, leftHidden];
  assert.equal(inferSwingSideFromLandmarks(frames), "LEFT");
});

test("fillJointGaps interpolates a short occlusion and holds at the ends", () => {
  const at = (x: number | null): NamedLandmarks =>
    x == null ? { LEFT_HIP: { x: 0.5, y: 0.5 } } : { LEFT_HIP: { x: 0.5, y: 0.5 }, LEFT_WRIST: { x, y: 0.4 } };
  const { frames, filled } = fillJointGaps([at(null), at(0.2), at(null), at(null), at(0.5), at(null)]);
  assert.equal(filled, 4);
  assert.equal(frames[0]!.LEFT_WRIST?.x, 0.2);
  assert.ok(Math.abs((frames[2]!.LEFT_WRIST?.x ?? 0) - 0.3) < 1e-9);
  assert.ok(Math.abs((frames[3]!.LEFT_WRIST?.x ?? 0) - 0.4) < 1e-9);
  assert.equal(frames[5]!.LEFT_WRIST?.x, 0.5);
});

test("fillJointGaps leaves a joint alone when it is barely seen", () => {
  const frames: NamedLandmarks[] = Array.from({ length: 10 }, (_, i) => ({
    LEFT_HIP: { x: 0.5, y: 0.5 },
    ...(i === 0 ? { LEFT_ANKLE: { x: 0.5, y: 0.9 } } : {}),
  }));
  const res = fillJointGaps(frames);
  assert.equal(res.filled, 0);
  assert.equal(res.frames[5]!.LEFT_ANKLE, undefined);
});

test("retargetProToUser turns a pro filmed from behind without renaming joints", () => {
  const pro = body({ hx: 0.3, hy: 0.5, torso: 0.3, rightWristDx: 0.2 });
  const user = body({ hx: 0.3, hy: 0.5, torso: 0.3 });
  const turned = retargetProToUser(pro, user, { flipX: true });
  // The right wrist stays the right wrist; only its side of the image changes.
  assert.ok(Math.abs((turned.RIGHT_WRIST?.x ?? 0) - 0.1) < 1e-6);
  // Facing flips with it: hips now read left-on-the-right.
  assert.ok((turned.LEFT_HIP?.x ?? 0) > (turned.RIGHT_HIP?.x ?? 0));
});

test("proOrientationPlan separates the swinging arm from the camera side", () => {
  const plan = (userSide: "LEFT" | "RIGHT" | null, proSide: "LEFT" | "RIGHT" | null, uf: "FRONT" | "BACK" | null, pf: "FRONT" | "BACK" | null) =>
    proOrientationPlan({ userSide, proSide, userFacing: uf, proFacing: pf });
  // Same arm, same facing: leave the pro alone.
  assert.deepEqual(plan("RIGHT", "RIGHT", "FRONT", "FRONT"), { swapSides: false, flipX: false });
  // Other arm, same facing: a true mirror image.
  assert.deepEqual(plan("RIGHT", "LEFT", "FRONT", "FRONT"), { swapSides: true, flipX: true });
  // Same arm, filmed from the other side: turn round, keep names.
  assert.deepEqual(plan("RIGHT", "RIGHT", "FRONT", "BACK"), { swapSides: false, flipX: true });
  // Both: swapping names alone puts the racket arm right and keeps the facing.
  assert.deepEqual(plan("LEFT", "RIGHT", "FRONT", "BACK"), { swapSides: true, flipX: false });
  // Unknown facing counts as matching.
  assert.deepEqual(plan("RIGHT", "LEFT", "FRONT", null), { swapSides: true, flipX: true });
});

test("inferFacing reads front from left-on-the-right and declines side-on windows", () => {
  const front = Array.from({ length: 6 }, () => body({ hx: 0.5, hy: 0.5, torso: 0.3 }));
  // body() puts LEFT_ at hx - 0.05, i.e. the left side on the image's left: facing away.
  assert.equal(inferFacing(front), "BACK");
  const turned = front.map((lm) => retargetProToUser(lm, lm, { flipX: true }));
  assert.equal(inferFacing(turned), "FRONT");
  const sideOn: NamedLandmarks[] = Array.from({ length: 6 }, () => ({
    LEFT_SHOULDER: { x: 0.5, y: 0.3 },
    RIGHT_SHOULDER: { x: 0.501, y: 0.3 },
    LEFT_HIP: { x: 0.5, y: 0.6 },
    RIGHT_HIP: { x: 0.502, y: 0.6 },
  }));
  assert.equal(inferFacing(sideOn), null);
});

test("restoreLimbLengths lengthens a collapsed forearm along its direction and carries the hand", () => {
  const arm = (wx: number, wy: number): NamedLandmarks => ({
    LEFT_SHOULDER: { x: 0.5, y: 0.3 },
    LEFT_ELBOW: { x: 0.5, y: 0.4 },
    LEFT_WRIST: { x: wx, y: wy },
    LEFT_INDEX: { x: wx, y: wy + 0.02 },
  });
  // Athlete's forearm is 0.1 long on every frame.
  const reference = Array.from({ length: 5 }, () => arm(0.5, 0.5));
  // Blended frame: forearm collapsed to 0.03, pointing straight down.
  const [out] = restoreLimbLengths([arm(0.5, 0.43)], reference);
  assert.ok(Math.abs((out!.LEFT_WRIST!.y - 0.4) - 0.075) < 1e-9, `wrist y ${out!.LEFT_WRIST!.y}`);
  assert.equal(out!.LEFT_WRIST!.x, 0.5);
  // The hand moves with the wrist.
  assert.ok(Math.abs(out!.LEFT_INDEX!.y - (out!.LEFT_WRIST!.y + 0.02)) < 1e-9);
});

test("restoreLimbLengths keeps ordinary foreshortening", () => {
  const arm: NamedLandmarks = {
    LEFT_SHOULDER: { x: 0.5, y: 0.3 },
    LEFT_ELBOW: { x: 0.5, y: 0.4 },
    LEFT_WRIST: { x: 0.5, y: 0.48 },
  };
  const reference: NamedLandmarks[] = Array.from({ length: 5 }, () => ({ ...arm, LEFT_WRIST: { x: 0.5, y: 0.5 } }));
  // 0.08 of a 0.1 forearm is 80%, above the 75% floor: untouched.
  assert.deepEqual(restoreLimbLengths([arm], reference)[0], arm);
});

test("blendArmsByAngle bends the elbow between the athlete's and the pro's, never straighter", () => {
  // Athlete: nearly straight arm hanging down, bent slightly outward. Pro: elbow bent 70 degrees
  // the other way on screen. A signed blend would pass through straight.
  const deg = Math.PI / 180;
  const arm = (bend: number): NamedLandmarks => {
    const s = { x: 0.5, y: 0.3 };
    const e = { x: 0.5, y: 0.4 };
    const ang = Math.PI / 2 + bend * deg;
    return { LEFT_SHOULDER: s, LEFT_ELBOW: e, LEFT_WRIST: { x: e.x + Math.cos(ang) * 0.1, y: e.y + Math.sin(ang) * 0.1 } };
  };
  const user = arm(14);
  const pro = arm(-70);
  const out = blendArmsByAngle(user, user, pro, { racketSide: "RIGHT", blend: 0.4, freeArmBlend: 0.4 });
  const e = out.LEFT_ELBOW!;
  const w = out.LEFT_WRIST!;
  const bend = Math.abs(Math.atan2(w.y - e.y, w.x - e.x) - Math.PI / 2) / deg;
  // 14 + (70 - 14) * 0.4 = 36.4 degrees of bend, toward the pro's side.
  assert.ok(Math.abs(bend - 36.4) < 1e-6, `bend ${bend}`);
  assert.ok(w.x > e.x, "bends toward the pro's side (pro wrist is at +x)");
  // Forearm keeps the athlete's length.
  assert.ok(Math.abs(Math.hypot(w.x - e.x, w.y - e.y) - 0.1) < 1e-9);
});
