import test from "node:test";
import assert from "node:assert/strict";
import {
  buildWanFunControlCoachingPrompt,
  buildWanFunControlNegativePrompt,
  buildWanFunControlPrompt,
} from "./comfyVideo";

const BALL_CONTACT = /contact|ball continuity|exactly ONE padel ball/i;

const coaching = buildWanFunControlCoachingPrompt("forehand volley", "right-handed", {
  diagnosis: "Elbow collapses early and the shoulders open before the hitting point.",
  recommendations: ["Keep the racket head above the wrist through the stroke."],
  jointMoves: ["RIGHT_ELBOW: current (0.41,0.52) -> target (0.44,0.47)"],
  timing: { prepToImpactMs: 420, impactToFollowMs: 180 },
  angleTargets: ["shoulder 96 -> 118"],
});

test("generic Fun Control prompt asks for the swing with no ball and the racket kept in hand", () => {
  const p = buildWanFunControlPrompt("forehand volley", "right-handed");
  assert.match(p, /No ball in the scene/);
  assert.match(p, /same hand as in the start frame/);
  assert.doesNotMatch(p, BALL_CONTACT);
  assert.match(p, /exact same player from the start frame/);
  assert.match(p, /Camera remains completely locked/);
});

test("coaching Fun Control prompt keeps its coaching sections and drops ball contact", () => {
  assert.match(coaching, /No ball in the scene/);
  assert.match(coaching, /same hand as in the reference frame/);
  assert.doesNotMatch(coaching, BALL_CONTACT);
  assert.match(coaching, /COACHING INTENT/);
  assert.match(coaching, /RIGHT_ELBOW: current \(0\.41,0\.52\) -> target \(0\.44,0\.47\)/);
  assert.match(coaching, /MOTION TIMING/);
});

test("Fun Control negative prompt suppresses the ball and a wandering racket, not softness", () => {
  const n = buildWanFunControlNegativePrompt();
  for (const term of [
    "ball",
    "racket switching hands",
    "floating racket",
    "ghosting",
    "changed face",
    "camera movement",
  ]) {
    assert.ok(n.includes(term), `missing "${term}"`);
  }
  assert.doesNotMatch(n, /blurry|mushy|low detail/i);
});
