import test from "node:test";
import assert from "node:assert/strict";
import {
  attachHands,
  handPointName,
  cleanBallTrack,
  controlOverlaysForWindow,
  meetBallAtContact,
  racketOutlineAngles,
  racketSideFromBoxes,
  drawOpenPoseRgb,
  type NamedLandmarks,
  type NormBox,
  type PoseYoloRow,
} from "./openPoseVideo";

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

test("drawOpenPoseRgb draws the right upper arm in the previous limb color", () => {
  const buf = drawOpenPoseRgb(pose(), SIZE, SIZE);
  // Midpoint of RIGHT_SHOULDER (0.4,0.3) -> RIGHT_ELBOW (0.3,0.4); color [0,255,85].
  assert.deepEqual(pixelAt(buf, 0.35, 0.35), [0, 255, 85]);
});

test("drawOpenPoseRgb draws the shoulder line at the shoulder midpoint", () => {
  const buf = drawOpenPoseRgb(pose(), SIZE, SIZE);
  assert.deepEqual(pixelAt(buf, 0.5, 0.3), [255, 0, 0]);
});

test("drawOpenPoseRgb draws the shoulder-to-hip bone", () => {
  const buf = drawOpenPoseRgb(pose(), SIZE, SIZE);
  // Midpoint of RIGHT_SHOULDER (0.4,0.3) -> RIGHT_HIP (0.45,0.6); color [255,170,0].
  assert.deepEqual(pixelAt(buf, 0.425, 0.45), [255, 170, 0]);
});

test("drawOpenPoseRgb omits a hidden wrist's forearm but keeps the upper arm", () => {
  const buf = drawOpenPoseRgb(pose(["RIGHT_WRIST"]), SIZE, SIZE);
  // Forearm midpoint RIGHT_ELBOW (0.3,0.4) -> RIGHT_WRIST (0.25,0.5).
  assert.deepEqual(pixelAt(buf, 0.275, 0.45), BLACK);
  assert.deepEqual(pixelAt(buf, 0.35, 0.35), [0, 255, 85]);
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

test("drawOpenPoseRgb paints the ball marker and leaves the racket box off by default", () => {
  withEnv({ CORRECTION_DRAW_RACKET_BOX: undefined }, () => {
    const buf = drawOpenPoseRgb(pose(), SIZE, SIZE, OVERLAY);
    assert.deepEqual(pixelAt(buf, 0.9, 0.1), [255, 220, 0]);
    assert.deepEqual(pixelAt(buf, 0.1, 0.9), BLACK);
  });
});

test("drawOpenPoseRgb drops the shoulder line when a shoulder is hidden", () => {
  const buf = drawOpenPoseRgb(pose(["LEFT_SHOULDER"]), SIZE, SIZE);
  assert.deepEqual(pixelAt(buf, 0.5, 0.3), BLACK);
  // LEFT_SHOULDER -> NOSE midpoint, also missing without that shoulder.
  assert.deepEqual(pixelAt(buf, 0.55, 0.25), BLACK);
});

const GREY = [160, 160, 160];
/** Racket pointing straight right from (0.2, 0.9), well clear of the skeleton: 200px long. */
const OUTLINE = {
  racketOutline: { x: Math.round(0.2 * SIZE), y: Math.round(0.9 * SIZE), angle: 0, length: 200 },
};

test("drawOpenPoseRgb leaves the racket outline off by default", () => {
  withEnv({ CORRECTION_DRAW_RACKET_OUTLINE: undefined }, () => {
    const buf = drawOpenPoseRgb(pose(), SIZE, SIZE, OUTLINE);
    // Handle midpoint: 0.33 * 200 / 2 = 33px right of the grip.
    assert.deepEqual(pixelAt(buf, (OUTLINE.racketOutline.x + 33) / SIZE, 0.9), BLACK);
  });
});

test("drawOpenPoseRgb strokes a handle and an unfilled head when the outline is on", () => {
  withEnv({ CORRECTION_DRAW_RACKET_OUTLINE: "true" }, () => {
    const buf = drawOpenPoseRgb(pose(), SIZE, SIZE, OUTLINE);
    const x0 = OUTLINE.racketOutline.x;
    // Handle: 66px long, from the grip.
    assert.deepEqual(pixelAt(buf, (x0 + 33) / SIZE, 0.9), GREY);
    // Head: centre 66 + 67 = 133px out, semi-axes 67 along and 57 across.
    assert.deepEqual(pixelAt(buf, (x0 + 133) / SIZE, 0.9), BLACK, "head is not filled");
    assert.deepEqual(pixelAt(buf, (x0 + 200) / SIZE, 0.9), GREY, "far tip of the rim");
    assert.deepEqual(pixelAt(buf, (x0 + 133) / SIZE, (OUTLINE.racketOutline.y - 57) / SIZE), GREY, "rim edge");
  });
});

test("controlOverlaysForWindow points the racket along the forearm, sized from YOLO", () => {
  // Right forearm along +x: elbow (0.3, 0.5) -> wrist (0.4, 0.5) is 76.8px on a 768 canvas.
  const lm: NamedLandmarks = { RIGHT_ELBOW: { x: 0.3, y: 0.5 }, RIGHT_WRIST: { x: 0.4, y: 0.5 } };
  const [o] = controlOverlaysForWindow({
    userFrameIndices: [0],
    poseRows: [{ frame: 0, racket_bbox: [0.4, 0.45, 0.58, 0.55] }],
    controlLandmarks: [lm],
    handedness: "right",
  });
  assert.ok(o?.racketOutline, "outline present");
  assert.equal(o.racketOutline.x, Math.round(0.4 * SIZE));
  assert.ok(Math.abs(o.racketOutline.angle) < 1e-9, `angle ${o.racketOutline.angle}`);
  // Box long side 0.18 * 768 = 138px, inside 1.2..2.6 forearms (92..200px).
  assert.ok(Math.abs(o.racketOutline.length - 0.18 * SIZE) < 1e-6, `length ${o.racketOutline.length}`);
});

test("controlOverlaysForWindow falls back to forearm length and caps a stray YOLO box", () => {
  const lm: NamedLandmarks = { RIGHT_ELBOW: { x: 0.3, y: 0.5 }, RIGHT_WRIST: { x: 0.4, y: 0.5 } };
  // Joints snap to whole pixels: 307 - 230.
  const forearm = Math.round(0.4 * SIZE) - Math.round(0.3 * SIZE);
  const [noBox] = controlOverlaysForWindow({
    userFrameIndices: [0], poseRows: [], controlLandmarks: [lm], handedness: "right",
  });
  assert.ok(Math.abs((noBox?.racketOutline?.length ?? 0) - forearm * 1.8) < 1e-6);
  const [huge] = controlOverlaysForWindow({
    userFrameIndices: [0],
    poseRows: [{ frame: 0, racket_bbox: [0, 0, 0.9, 0.9] }],
    controlLandmarks: [lm],
    handedness: "right",
  });
  assert.ok(Math.abs((huge?.racketOutline?.length ?? 0) - forearm * 2.6) < 1e-6);
});

/** 0.02-wide ball box centred on (x, y). */
function ballAt(frame: number, x: number, y: number, conf = 0.5): PoseYoloRow {
  const box: NormBox = [x - 0.01, y - 0.01, x + 0.01, y + 0.01];
  return { frame, ball_bbox: box, ball_conf: conf };
}

/** Real ball crossing left at 0.05 of the frame per frame (1.5 widths/s at 30fps). */
const FLIGHT = [10, 11, 12, 13, 14, 15].map((f, i) => ballAt(f, 0.7 - 0.05 * i, 0.5));

test("cleanBallTrack drops a reflection that sits in one spot", () => {
  const glare = [8, 11, 13, 16, 20].map((f) => ballAt(f, 0.17, 0.4, 0.12));
  const track = cleanBallTrack([...FLIGHT, ...glare], { fps: 30 });
  assert.deepEqual(track.map((d) => d.frame), [10, 11, 12, 13, 14, 15]);
});

test("cleanBallTrack drops a one-frame jump no ball could make", () => {
  const rows = [...FLIGHT.slice(0, 3), ballAt(13, 0.99, 0.58), ...FLIGHT.slice(4)];
  const track = cleanBallTrack(rows, { fps: 30 });
  assert.deepEqual(track.map((d) => d.frame), [10, 11, 12, 14, 15]);
});

test("cleanBallTrack keeps one track when two unrelated ones exist", () => {
  // A weaker, separate pair far away in time and space.
  const stray = [ballAt(40, 0.1, 0.8, 0.15), ballAt(41, 0.12, 0.8, 0.15)];
  const track = cleanBallTrack([...FLIGHT, ...stray], { fps: 30 });
  assert.deepEqual(track.map((d) => d.frame), [10, 11, 12, 13, 14, 15]);
});

test("controlOverlaysForWindow draws the ball only inside its track", () => {
  const overlays = controlOverlaysForWindow({
    userFrameIndices: [5, 12, 13, 20],
    poseRows: FLIGHT,
    controlLandmarks: [{}, {}, {}, {}],
    handedness: "right",
    fps: 30,
  });
  assert.equal(overlays[0]?.ball, undefined, "before the first detection");
  assert.equal(overlays[1]?.ball?.cx, Math.round(0.6 * SIZE));
  assert.ok(overlays[2]?.ball, "inside the track");
  assert.equal(overlays[3]?.ball, undefined, "after the last detection");
});

test("racketOutlineAngles points from wrist to racket box, filling and holding gaps", () => {
  const w = { x: 100, y: 100 };
  // Racket 60px out at 180 degrees (across the body), then 90 degrees; frame 1 has no box.
  const angles = racketOutlineAngles({
    centres: [{ x: 40, y: 100 }, null, { x: 100, y: 160 }, null],
    wrists: [w, w, w, w],
    length: 100,
  });
  assert.ok(angles);
  // Unwrapped from pi toward pi/2 + 2pi would be wrong; the short way is pi -> pi/2.
  const raw = [Math.PI, (3 * Math.PI) / 4, Math.PI / 2, Math.PI / 2];
  const smoothed = raw.map((_, i) => {
    const near = raw.slice(Math.max(0, i - 1), i + 2);
    return near.reduce((a, b) => a + b, 0) / near.length;
  });
  angles!.forEach((a, i) => assert.ok(Math.abs(a - smoothed[i]!) < 1e-9, `frame ${i}: ${a}`));
});

test("racketOutlineAngles ignores boxes too far from the wrist to be held", () => {
  const w = { x: 100, y: 100 };
  assert.equal(
    racketOutlineAngles({ centres: [{ x: 400, y: 100 }], wrists: [w], length: 100 }),
    null
  );
});

test("controlOverlaysForWindow angles the racket from footage, not the forearm", () => {
  // Forearm points +x, but the racket box sits up and to the left of the wrist (laid-back volley).
  const lm: NamedLandmarks = {
    RIGHT_ELBOW: { x: 0.3, y: 0.5 },
    RIGHT_WRIST: { x: 0.4, y: 0.5 },
    LEFT_WRIST: { x: 0.6, y: 0.7 },
  };
  const rows: PoseYoloRow[] = [0, 1, 2].map((frame) => ({
    frame,
    racket_bbox: [0.3, 0.36, 0.36, 0.44] as NormBox,
  }));
  const overlays = controlOverlaysForWindow({
    userFrameIndices: [0, 1, 2],
    poseRows: rows,
    controlLandmarks: [lm, lm, lm],
    userLandmarks: [lm, lm, lm],
    handedness: "right",
  });
  const a = overlays[1]?.racketOutline?.angle ?? 0;
  // Box centre (0.33, 0.40) from wrist (0.4, 0.5): up and left, between -90 and -180 degrees.
  assert.ok(a < -Math.PI / 2 && a > -Math.PI, `angle ${a}`);
});

test("controlOverlaysForWindow takes the racket hand from where the boxes sit", () => {
  // Profile says right-handed, but every racket box sits beside LEFT_WRIST.
  const lm: NamedLandmarks = {
    LEFT_ELBOW: { x: 0.6, y: 0.5 },
    LEFT_WRIST: { x: 0.7, y: 0.5 },
    RIGHT_ELBOW: { x: 0.4, y: 0.5 },
    RIGHT_WRIST: { x: 0.3, y: 0.5 },
  };
  const rows: PoseYoloRow[] = [0, 1, 2].map((frame) => ({
    frame,
    racket_bbox: [0.74, 0.46, 0.8, 0.54] as NormBox,
  }));
  const [o] = controlOverlaysForWindow({
    userFrameIndices: [0, 1, 2],
    poseRows: rows,
    controlLandmarks: [lm, lm, lm],
    userLandmarks: [lm, lm, lm],
    handedness: "right",
  });
  assert.equal(o?.racketOutline?.x, Math.round(0.7 * SIZE));
});

test("meetBallAtContact moves the whole ball track onto the racket head at contact", () => {
  // Racket pointing right from (100, 100), 300px long: head centre 0.665 * 300 = 199.5px out.
  const racketOutline = { x: 100, y: 100, angle: 0, length: 300 };
  const out = meetBallAtContact(
    [
      { racketOutline, ball: { cx: 500, cy: 400, r: 5 } },
      { racketOutline, ball: { cx: 450, cy: 420, r: 5 } },
      { racketOutline },
    ],
    1
  );
  // Contact frame lands on the head centre (300, 100); the other frame keeps its offset to it.
  assert.deepEqual([out[1]?.ball?.cx, out[1]?.ball?.cy], [300, 100]);
  assert.deepEqual([out[0]?.ball?.cx, out[0]?.ball?.cy], [350, 80]);
  assert.equal(out[2]?.ball, undefined);
});

test("meetBallAtContact drops a ball that is nowhere near contact", () => {
  const racketOutline = { x: 100, y: 100, angle: 0, length: 300 };
  const overlays = [
    { racketOutline, ball: { cx: 500, cy: 400, r: 5 } },
    { racketOutline },
    { racketOutline },
    { racketOutline },
    { racketOutline },
  ];
  // Contact at index 4: the only ball is 4 frames away, beyond the 2-frame search.
  assert.ok(meetBallAtContact(overlays, 4).every((o) => !o.ball));
});

test("cleanBallTrack prefers the ball that reaches contact over a brighter one elsewhere", () => {
  // Bright flight early in the clip, dimmer one through contact at frame 40.
  const early = [10, 11, 12, 13, 14].map((f, i) => ballAt(f, 0.2 + 0.05 * i, 0.3, 0.9));
  const atContact = [38, 39, 41].map((f, i) => ballAt(f, 0.6 - 0.04 * i, 0.5, 0.2));
  const rows = [...early, ...atContact];
  assert.deepEqual(cleanBallTrack(rows, { fps: 30 }).map((d) => d.frame), [10, 11, 12, 13, 14]);
  assert.deepEqual(cleanBallTrack(rows, { fps: 30, contactFrame: 40 }).map((d) => d.frame), [38, 39, 41]);
});

test("racketSideFromBoxes ignores ready-position frames and votes near contact", () => {
  const lm = (lx: number, rx: number): NamedLandmarks => ({
    LEFT_WRIST: { x: lx, y: 0.5 },
    RIGHT_WRIST: { x: rx, y: 0.5 },
  });
  // Ready position: hands together, box between them, slightly nearer the free (left) hand.
  const ready = Array.from({ length: 6 }, () => lm(0.5, 0.52));
  const readyBoxes = ready.map(() => ({ x: 0.505, y: 0.45 }));
  // Backswing: free hand guides the racket, box by the left wrist.
  const back = Array.from({ length: 4 }, () => lm(0.4, 0.6));
  const backBoxes = back.map(() => ({ x: 0.38, y: 0.45 }));
  // Contact: hands apart, box by the right wrist.
  const hit = Array.from({ length: 3 }, () => lm(0.6, 0.3));
  const hitBoxes = hit.map(() => ({ x: 0.27, y: 0.45 }));
  const frames = [...ready, ...back, ...hit];
  const boxes = [...readyBoxes, ...backBoxes, ...hitBoxes];
  // Whole clip: ready frames abstain (not clear-cut), backswing outvotes contact 4-3: split.
  assert.equal(racketSideFromBoxes(frames, boxes), null);
  assert.equal(racketSideFromBoxes(frames, boxes, 1, { index: 11, radius: 1 }), "RIGHT");
});

/** Right forearm along +x from (0.3, 0.5) to (0.4, 0.5), with a 21-point hand fanned past the wrist. */
function armWithHand(): NamedLandmarks {
  const lm: NamedLandmarks = {
    RIGHT_ELBOW: { x: 0.3, y: 0.5 },
    RIGHT_WRIST: { x: 0.4, y: 0.5 },
  };
  for (let i = 0; i < 21; i++) {
    lm[handPointName("RIGHT", i)] = { x: 0.4 + (i === 0 ? 0 : 0.02 + 0.001 * i), y: 0.5 + 0.001 * (i % 5), visibility: 0.9 };
  }
  return lm;
}

test("attachHands turns the athlete's hand with the corrected forearm", () => {
  const user = armWithHand();
  // Corrected forearm points straight down from the same elbow, same length.
  const corrected: NamedLandmarks = {
    RIGHT_ELBOW: { x: 0.3, y: 0.5 },
    RIGHT_WRIST: { x: 0.3, y: 0.6 },
  };
  const [out] = attachHands([corrected], [user]);
  const tip = out![handPointName("RIGHT", 8)]!;
  // 0.028 beyond the wrist along the arm becomes 0.028 below the corrected wrist.
  assert.ok(Math.abs(tip.y - (0.6 + 0.028)) < 1e-3, `tip y ${tip.y}`);
  assert.ok(Math.abs(tip.x - 0.3) < 1e-2, `tip x ${tip.x}`);
  assert.deepEqual([out![handPointName("RIGHT", 0)]!.x, out![handPointName("RIGHT", 0)]!.y], [0.3, 0.6]);
});

test("drawOpenPoseRgb draws a full hand in place of the wrist-to-index stub", () => {
  const lm = armWithHand();
  lm.RIGHT_INDEX = { x: 0.4, y: 0.4 };
  const buf = drawOpenPoseRgb(lm, SIZE, SIZE);
  // The stub would run from the wrist (0.4, 0.5) up to (0.4, 0.4): its midpoint stays black.
  assert.deepEqual(pixelAt(buf, 0.4, 0.45), BLACK);
});
