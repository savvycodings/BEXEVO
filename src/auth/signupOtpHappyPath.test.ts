import assert from "node:assert/strict";
import test from "node:test";
import {
  getSignupOtpHappyPathCode,
  isSignupOtpHappyPathCode,
  isSignupOtpHappyPathEnabled,
} from "./signupOtpHappyPath";

test("signup OTP happy path is disabled in production", () => {
  assert.equal(isSignupOtpHappyPathEnabled("PRODUCTION"), false);
  assert.equal(getSignupOtpHappyPathCode("PRODUCTION", "000000"), null);
  assert.equal(isSignupOtpHappyPathCode("000000", "PRODUCTION"), false);
});

test("signup OTP happy path defaults to 000000 outside production", () => {
  assert.equal(isSignupOtpHappyPathEnabled("DEVELOPMENT"), true);
  assert.equal(getSignupOtpHappyPathCode("DEVELOPMENT", undefined), "000000");
  assert.equal(isSignupOtpHappyPathCode("000000", "DEVELOPMENT"), true);
  assert.equal(isSignupOtpHappyPathCode("123456", "DEVELOPMENT"), false);
});

test("signup OTP happy path honors a custom 6-digit override", () => {
  assert.equal(getSignupOtpHappyPathCode("DEVELOPMENT", "847291"), "847291");
  assert.equal(isSignupOtpHappyPathCode("847291", "DEVELOPMENT", "847291"), true);
  assert.equal(isSignupOtpHappyPathCode("000000", "DEVELOPMENT", "847291"), false);
});

test("signup OTP happy path ignores invalid overrides", () => {
  assert.equal(getSignupOtpHappyPathCode("STAGING", "abc"), "000000");
  assert.equal(getSignupOtpHappyPathCode("STAGING", "12"), "000000");
});
