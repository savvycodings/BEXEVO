import { test } from "node:test";
import assert from "node:assert/strict";
import {
  labelsMatch,
  passedFromScore,
  percentFromRatio,
} from "./scoring";
import { ACCURACY_PASS_PERCENT } from "./constants";

test("labelsMatch is case-insensitive", () => {
  assert.equal(labelsMatch("Forehand Lob", "forehand lob"), true);
  assert.equal(labelsMatch("", "x"), false);
});

test("passedFromScore uses 60% threshold", () => {
  assert.equal(passedFromScore(59), false);
  assert.equal(passedFromScore(ACCURACY_PASS_PERCENT), true);
  assert.equal(passedFromScore(100), true);
});

test("percentFromRatio rounds", () => {
  assert.equal(percentFromRatio(2, 3), 67);
  assert.equal(percentFromRatio(0, 0), 0);
});
