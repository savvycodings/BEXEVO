import assert from "node:assert/strict";
import test from "node:test";
import { buildPasswordResetEmail } from "./templates/passwordResetEmail";

test("buildPasswordResetEmail includes the reset code and expiry", () => {
  const { subject, html, text } = buildPasswordResetEmail({ code: "482913" });

  assert.equal(subject, "482913 is your Xevo password reset code");
  assert.match(text, /482913/);
  assert.match(text, /10 minutes/);
  assert.match(html, /482913/);
  assert.match(html, /new password/);
});
