import test from "node:test";
import assert from "node:assert/strict";
import { adminHubPasswordValid, roleAfterCoachRevoke } from "./coachRole";

test("roleAfterCoachRevoke returns student when linked to a coach", () => {
  assert.equal(roleAfterCoachRevoke(true), "student");
});

test("roleAfterCoachRevoke returns none when not linked", () => {
  assert.equal(roleAfterCoachRevoke(false), "none");
});

test("adminHubPasswordValid rejects empty and wrong password", () => {
  assert.equal(adminHubPasswordValid("", "xevodev"), false);
  assert.equal(adminHubPasswordValid("wrong", "xevodev"), false);
  assert.equal(adminHubPasswordValid("xevodev", "xevodev"), true);
});
