import assert from "node:assert/strict";
import test from "node:test";
import { planAnswer } from "./coachAnswerPlan";

test("a month summary features the best clip in that month, not the latest upload", () => {
  const plan = planAnswer("How was my shots this month?");
  assert.equal(plan.family, "window");
  assert.equal(plan.needsLibrary, true);
  assert.equal(plan.showVideo, true);
  assert.equal(plan.pick, "best_score");
  assert.equal(plan.window?.label, "this month");
  assert.equal(plan.shotQuery, null);
});

test("best score last week stays inside last week", () => {
  const plan = planAnswer("What's my best score last week");
  assert.equal(plan.family, "window");
  assert.equal(plan.showVideo, true);
  assert.equal(plan.pick, "best_score");
  assert.equal(plan.window?.label, "last week");
  assert.ok(plan.window?.since);
  assert.ok(plan.window?.until);
  assert.ok(plan.window!.until!.getTime() > plan.window!.since!.getTime());
});

test("a joint question measures a clip and does not lead with the overall score", () => {
  const plan = planAnswer("Is my shoulder rotation generating enough power?");
  assert.equal(plan.family, "biomechanics");
  assert.equal(plan.showVideo, true);
  assert.equal(plan.showScore, false);
  assert.equal(plan.showMotion, true);
  assert.equal(plan.theme, "shoulder");
  assert.equal(plan.needsLibrary, false);
});

test("a named shot is not replaced by the latest upload", () => {
  const plan = planAnswer("my backhand volley needs work");
  assert.equal(plan.shotQuery, "backhand volley");
  assert.equal(plan.showVideo, true);
  assert.equal(plan.family, "shot");
});

test("drills are spoken coaching with no clip", () => {
  const plan = planAnswer("Give me three drills to correct my elbow positioning.");
  assert.equal(plan.family, "dialogue");
  assert.equal(plan.showVideo, false);
  assert.equal(plan.needsLibrary, true);
  assert.equal(plan.theme, "elbow");
});

test("a pro reference question keeps the named shot and the pro joints", () => {
  const plan = planAnswer("How many degrees is my elbow position off compared with the reference technique?");
  assert.equal(plan.family, "pro");
  assert.equal(plan.includePro, true);
  assert.equal(plan.showVideo, true);
  assert.equal(plan.theme, "elbow");
});

test("a dated shot compare stays a two-clip compare", () => {
  const plan = planAnswer("Can you compare my bandeja today with my bandeja from three weeks ago?");
  assert.equal(plan.family, "compare");
  assert.equal(plan.shotQuery, "bandeja");
  assert.equal(plan.showVideo, true);
});

test("an improvement trend does not attach one misleading clip", () => {
  const plan = planAnswer("Has my forehand improved over the last 30 days?");
  assert.equal(plan.family, "window");
  assert.equal(plan.showVideo, false);
  assert.equal(plan.shotQuery, "forehand");
  assert.match(plan.window?.label ?? "", /30 days/);
});

test("the best of the last five smashes is the featured clip", () => {
  const plan = planAnswer("Compare my last five smashes. Which one had the best technique?");
  assert.equal(plan.family, "window");
  assert.equal(plan.shotQuery, "smash");
  assert.equal(plan.pick, "best_technique");
  assert.equal(plan.showVideo, true);
  assert.equal(plan.window?.limit, 5);
});
