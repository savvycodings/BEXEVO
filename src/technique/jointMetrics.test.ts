import test from "node:test";
import assert from "node:assert/strict";
import { buildContactJointReadings, buildJointReading, contactJointAngles, nearestByFrame } from "./jointMetrics";

// Right arm: shoulder straight above the hip, elbow out to the side, wrist up -> 90° at the elbow.
const bentArm = {
  RIGHT_SHOULDER: { x: 0.5, y: 0.4 },
  RIGHT_ELBOW: { x: 0.6, y: 0.4 },
  RIGHT_WRIST: { x: 0.6, y: 0.3 },
  RIGHT_INDEX: { x: 0.6, y: 0.25 },
  RIGHT_HIP: { x: 0.5, y: 0.6 },
  LEFT_HIP: { x: 0.45, y: 0.6 },
  LEFT_SHOULDER: { x: 0.45, y: 0.4 },
  RIGHT_KNEE: { x: 0.5, y: 0.75 },
  RIGHT_ANKLE: { x: 0.5, y: 0.9 },
};

test("contactJointAngles measures the racket-side hinges and trunk lean", () => {
  const a = contactJointAngles(bentArm, "RIGHT");
  assert.equal(a.elbow, 90);
  assert.equal(a.shoulder, 90);
  assert.equal(a.wrist, 180);
  assert.equal(a.knee, 180);
  assert.equal(a.torso, 0);
});

test("low-visibility landmarks give no angle", () => {
  const a = contactJointAngles({ ...bentArm, RIGHT_ELBOW: { x: 0.6, y: 0.4, visibility: 0.2 } }, "RIGHT");
  assert.equal(a.elbow, null);
  assert.equal(a.shoulder, null);
});

test("an elbow 12° under the pro is a flexed warning with a pro-centred ideal range", () => {
  const r = buildJointReading("elbow", 98, 110);
  assert.deepEqual(r, {
    you: 98,
    pro: 110,
    idealMin: 102,
    idealMax: 118,
    deltaDeg: -12,
    status: "warn",
    direction: "more_flexed",
    messageKey: "joints.elbow.more_flexed",
  });
});

test("within tolerance is a match; past twice the tolerance is bad", () => {
  assert.equal(buildJointReading("knee", 150, 155).direction, "match");
  assert.equal(buildJointReading("knee", 130, 155).status, "bad");
  assert.equal(buildJointReading("torso", 20, 5).direction, "leaning_more");
  assert.equal(buildJointReading("shoulder", 140, 165).direction, "arm_lower");
});

test("the ideal range stays inside 0..180", () => {
  const torso = buildJointReading("torso", 34, 3);
  assert.equal(torso.idealMin, 0);
  assert.equal(torso.idealMax, 9);
  assert.equal(buildJointReading("wrist", 170, 175).idealMax, 180);
});

test("missing pro keeps the player's angle without a verdict", () => {
  const r = buildContactJointReadings(bentArm, null, "RIGHT").elbow;
  assert.equal(r.you, 90);
  assert.equal(r.pro, null);
  assert.equal(r.status, null);
});

test("nearestByFrame picks the closest row", () => {
  const rows = [{ f: 10 }, { f: 20 }, { f: 31 }];
  assert.equal(nearestByFrame(rows, 27, (r) => r.f)?.f, 31);
});
