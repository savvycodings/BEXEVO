import assert from "node:assert/strict";
import test from "node:test";
import { passwordResetDevOtp } from "./passwordResetOtp";

test("password reset fallback code is only issued in development without email", () => {
  assert.equal(passwordResetDevOtp("forget-password", "DEVELOPMENT", false), "000000");
  assert.equal(passwordResetDevOtp("forget-password", "development", false), "000000");
  assert.equal(passwordResetDevOtp("sign-in", "DEVELOPMENT", false), undefined);
});

test("password reset fallback code is off outside development", () => {
  for (const environment of ["PRODUCTION", "STAGING", "", undefined]) {
    assert.equal(passwordResetDevOtp("forget-password", environment, false), undefined);
  }
  assert.equal(passwordResetDevOtp("forget-password", "DEVELOPMENT", true), undefined);
});
