import { isEmailConfigured } from "../lib/email/resendClient";
import { sendPasswordResetEmail } from "../lib/email/sendPasswordResetEmail";
import { getSignupOtpHappyPathCode } from "./signupOtpHappyPath";

type OtpType = "sign-in" | "email-verification" | "forget-password" | "change-email";

export function isPasswordResetDevEnvironment(
  environment = process.env.ENVIRONMENT
): boolean {
  return environment?.trim().toUpperCase() === "DEVELOPMENT";
}

/** Fixed code only in development when email cannot be sent. Every other environment uses a random OTP. */
export function passwordResetDevOtp(
  type: OtpType,
  environment = process.env.ENVIRONMENT,
  emailConfigured = isEmailConfigured()
): string | undefined {
  if (type !== "forget-password") return undefined;
  if (emailConfigured || !isPasswordResetDevEnvironment(environment)) return undefined;
  return getSignupOtpHappyPathCode(environment) ?? undefined;
}

export function passwordResetDevFallbackCode(): string | null {
  return passwordResetDevOtp("forget-password") ?? null;
}

export async function deliverPasswordResetOtp(input: {
  email: string;
  otp: string;
  type: OtpType;
}): Promise<void> {
  if (input.type !== "forget-password") return;

  const result = await sendPasswordResetEmail({ to: input.email, code: input.otp });
  if (result.sent) return;

  if (result.skipped === "email_not_configured" && isPasswordResetDevEnvironment()) {
    console.warn("[PasswordReset] email not delivered — use the development code", {
      email: input.email,
      code: input.otp,
    });
    return;
  }

  console.error("[PasswordReset] email send failed", {
    email: input.email,
    skipped: result.skipped,
    error: result.error,
  });
  throw new Error(result.error || "Could not send password reset email.");
}
