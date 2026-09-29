import { createHash, randomInt, randomUUID, timingSafeEqual } from "crypto";
import { and, eq, gt } from "drizzle-orm";
import { db, verification } from "../db";
import { sendSignupVerificationEmail } from "../lib/email/sendSignupVerificationEmail";
import { getSignupOtpHappyPathCode, isSignupOtpHappyPathCode } from "./signupOtpHappyPath";

const CODE_TTL_MS = 10 * 60 * 1000;
const VERIFIED_TTL_MS = 60 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;

const signupCodeIdentifier = (email: string) => `signup-code:${email}`;
const signupVerifiedIdentifier = (email: string) => `signup-verified:${email}`;

export function normalizeSignupEmail(email: string): string {
  return email.trim().toLowerCase();
}

function hashSignupCode(email: string, code: string): string {
  const secret = process.env.BETTER_AUTH_SECRET || "xevo-dev-secret";
  return createHash("sha256").update(`${email}:${code}:${secret}`).digest("hex");
}

function generateSignupCode(): string {
  return String(randomInt(100000, 999999));
}

function safeEqualHash(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

async function issueSignupVerifiedToken(email: string): Promise<string> {
  const verificationToken = randomUUID();
  const verifiedExpiresAt = new Date(Date.now() + VERIFIED_TTL_MS);

  await db.delete(verification).where(eq(verification.identifier, signupCodeIdentifier(email)));
  await db.delete(verification).where(eq(verification.identifier, signupVerifiedIdentifier(email)));
  await db.insert(verification).values({
    id: randomUUID(),
    identifier: signupVerifiedIdentifier(email),
    value: verificationToken,
    expiresAt: verifiedExpiresAt,
  });

  return verificationToken;
}

export async function sendSignupVerificationCode(
  email: string,
  name?: string | null
): Promise<
  | { ok: true; retryAfterSec?: number }
  | { ok: false; error: string; retryAfterSec?: number; message?: string }
> {
  const normalized = normalizeSignupEmail(email);
  if (!normalized || !normalized.includes("@")) {
    return { ok: false, error: "INVALID_EMAIL", message: "Enter a valid email address." };
  }

  const existing = await db.query.verification.findFirst({
    where: eq(verification.identifier, signupCodeIdentifier(normalized)),
  });

  if (existing) {
    const elapsedMs = Date.now() - existing.createdAt.getTime();
    if (elapsedMs < RESEND_COOLDOWN_MS) {
      const retryAfterSec = Math.ceil((RESEND_COOLDOWN_MS - elapsedMs) / 1000);
      return { ok: false, error: "RESEND_COOLDOWN", retryAfterSec };
    }
  }

  const code = generateSignupCode();
  const codeHash = hashSignupCode(normalized, code);
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);

  await db.delete(verification).where(eq(verification.identifier, signupCodeIdentifier(normalized)));
  await db.insert(verification).values({
    id: randomUUID(),
    identifier: signupCodeIdentifier(normalized),
    value: codeHash,
    expiresAt,
  });

  const sendResult = await sendSignupVerificationEmail({
    to: normalized,
    name,
    code,
  });
  const happyPathCode = getSignupOtpHappyPathCode();

  if (!sendResult.sent) {
    if (sendResult.skipped === "email_not_configured" || happyPathCode) {
      console.warn("[SignupVerification] email not delivered — using development happy-path OTP", {
        email: normalized,
        skipped: sendResult.skipped,
        error: sendResult.error,
        generatedCode: code,
        happyPathCode: happyPathCode ?? undefined,
      });
      return { ok: true };
    }
    console.error("[SignupVerification] email send failed", {
      email: normalized,
      error: sendResult.error,
    });
    return {
      ok: false,
      error: "EMAIL_SEND_FAILED",
      message: sendResult.error || "Could not send verification email.",
    };
  }

  if (happyPathCode) {
    console.warn("[SignupVerification] development happy-path OTP available if email does not arrive", {
      email: normalized,
      happyPathCode,
    });
  }

  return { ok: true };
}

export async function verifySignupVerificationCode(
  email: string,
  code: string
): Promise<
  | { ok: true; verificationToken: string }
  | { ok: false; error: string; message?: string }
> {
  const normalized = normalizeSignupEmail(email);
  const trimmedCode = code.trim();

  if (!/^\d{6}$/.test(trimmedCode)) {
    return { ok: false, error: "INVALID_CODE", message: "Enter the 6-digit code from your email." };
  }

  if (isSignupOtpHappyPathCode(trimmedCode)) {
    console.warn("[SignupVerification] accepted development happy-path OTP", {
      email: normalized,
    });
    const verificationToken = await issueSignupVerifiedToken(normalized);
    return { ok: true, verificationToken };
  }

  const record = await db.query.verification.findFirst({
    where: eq(verification.identifier, signupCodeIdentifier(normalized)),
  });

  if (!record || record.expiresAt <= new Date()) {
    return { ok: false, error: "EXPIRED", message: "This code has expired. Request a new one." };
  }

  const expectedHash = hashSignupCode(normalized, trimmedCode);
  if (!safeEqualHash(record.value, expectedHash)) {
    return { ok: false, error: "INVALID_CODE", message: "That code is incorrect. Try again." };
  }

  const verificationToken = await issueSignupVerifiedToken(normalized);
  return { ok: true, verificationToken };
}

export async function consumeSignupVerificationToken(
  email: string,
  token: string
): Promise<boolean> {
  const normalized = normalizeSignupEmail(email);
  const trimmedToken = token.trim();
  if (!trimmedToken) return false;

  const record = await db.query.verification.findFirst({
    where: and(
      eq(verification.identifier, signupVerifiedIdentifier(normalized)),
      eq(verification.value, trimmedToken),
      gt(verification.expiresAt, new Date())
    ),
  });

  if (!record) return false;

  await db.delete(verification).where(eq(verification.identifier, signupVerifiedIdentifier(normalized)));
  return true;
}
