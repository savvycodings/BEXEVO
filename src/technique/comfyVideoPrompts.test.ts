import test from "node:test";
import assert from "node:assert/strict";
import {
  buildWanFunControlCoachingPrompt,
  buildWanFunControlNegativePrompt,
  buildWanFunControlPrompt,
  buildWanI2vPrompt,
} from "./comfyVideo";

const coaching = buildWanFunControlCoachingPrompt("forehand volley", "right-handed", {
  diagnosis: "Elbow collapses early and the shoulders open before the hitting point.",
  recommendations: ["Keep the racket head above the wrist through the stroke."],
  jointMoves: ["RIGHT_ELBOW: current (0.41,0.52) -> target (0.44,0.47)"],
  timing: { prepToImpactMs: 420, impactToFollowMs: 180 },
  angleTargets: ["shoulder 96 -> 118"],
});

test("generic Fun Control prompt asks for one ball and contact with it", () => {
  const p = buildWanFunControlPrompt("forehand volley", "right-handed");
  assert.match(p, /exactly ONE padel ball/);
  assert.match(p, /Ball continuity/);
  assert.match(p, /racket contact with that exact same ball/);
  assert.match(p, /start frame/);
  assert.match(p, /Camera remains completely locked/);
});

test("coaching Fun Control prompt keeps its coaching sections and the ball", () => {
  assert.match(coaching, /exactly ONE padel ball/);
  assert.match(coaching, /reference frame/);
  assert.match(coaching, /racket contact with that exact same ball/);
  assert.match(coaching, /COACHING INTENT/);
  assert.match(coaching, /RIGHT_ELBOW: current \(0\.41,0\.52\) -> target \(0\.44,0\.47\)/);
  assert.match(coaching, /Preparation to contact took about 420 ms/);
  assert.match(coaching, /stopping at the ball/);
});

test("prompts spell out a padel racket and only keep a ball the frame already shows", () => {
  for (const p of [
    buildWanFunControlPrompt("forehand volley", "right-handed"),
    coaching,
    buildWanI2vPrompt("forehand volley", "right-handed"),
  ]) {
    assert.match(p, /padel racket/);
    assert.match(p, /no strings/);
    assert.match(p, /no ball appears/);
  }
});

test("Fun Control negative prompt rejects a second ball, not softness", () => {
  const n = buildWanFunControlNegativePrompt();
  for (const term of [
    "extra ball",
    "duplicate ball",
    "incorrect ball contact",
    "changed face",
    "camera movement",
    "tennis racket",
    "racket strings",
    "elongated arms",
  ]) {
    assert.ok(n.includes(term), `missing "${term}"`);
  }
  assert.doesNotMatch(n, /blurry|mushy|low detail/i);
  assert.doesNotMatch(n, /^ball,/);
});
