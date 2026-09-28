import { timingSafeEqual } from "crypto";

const DEFAULT_HAPPY_PATH_CODE = "000000";

export function isSignupOtpHappyPathEnabled(
  environment = process.env.ENVIRONMENT
): boolean {
  return environment !== "PRODUCTION";
}

export function getSignupOtpHappyPathCode(
  environment = process.env.ENVIRONMENT,
  configuredCode = process.env.SIGNUP_OTP_HAPPY_PATH_CODE
): string | null {
  if (!isSignupOtpHappyPathEnabled(environment)) return null;
  const configured = configuredCode?.trim();
  if (configured && /^\d{6}$/.test(configured)) return configured;
  return DEFAULT_HAPPY_PATH_CODE;
}

export function isSignupOtpHappyPathCode(
  code: string,
  environment = process.env.ENVIRONMENT,
  configuredCode = process.env.SIGNUP_OTP_HAPPY_PATH_CODE
): boolean {
  const happyPathCode = getSignupOtpHappyPathCode(environment, configuredCode);
  if (!happyPathCode) return false;
  const left = Buffer.from(code);
  const right = Buffer.from(happyPathCode);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
