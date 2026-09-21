import { randomUUID } from "crypto";
import { E2EClient } from "./http";

// Fixed test account so repeat runs re-use the same user instead of accumulating throwaway
// accounts. Override via env if you want an isolated one per CI run.
const EMAIL = process.env.E2E_TEST_EMAIL ?? "e2e-bexevo@xevo.test";
const PASSWORD = process.env.E2E_TEST_PASSWORD ?? "E2E-test-password-1!";
const NAME = process.env.E2E_TEST_NAME ?? "BEXevo E2E";

/** Signs in the fixed e2e test user, creating it via better-auth sign-up on first run. */
export async function signInE2EUser(): Promise<E2EClient> {
  const client = new E2EClient();

  const signIn = await client.postJson("/api/auth/sign-in/email", {
    email: EMAIL,
    password: PASSWORD,
  });
  if (signIn.ok) return client;

  const signUp = await client.postJson("/api/auth/sign-up/email", {
    email: EMAIL,
    password: PASSWORD,
    name: NAME,
  });
  if (!signUp.ok) {
    const body = await signUp.text().catch(() => "");
    throw new Error(
      `E2E test user sign-in failed (${signIn.status}) and sign-up also failed (${signUp.status}): ${body}`
    );
  }

  const retrySignIn = await client.postJson("/api/auth/sign-in/email", {
    email: EMAIL,
    password: PASSWORD,
  });
  if (!retrySignIn.ok) {
    const body = await retrySignIn.text().catch(() => "");
    throw new Error(`E2E test user sign-in failed after sign-up (${retrySignIn.status}): ${body}`);
  }
  return client;
}

/**
 * Creates and signs in a brand-new, uniquely-emailed e2e user, unlike signInE2EUser's fixed,
 * reused account. Achievement/streak state is permanent per user, so a suite that wants to
 * observe achievements move locked -> claimable -> claimed from a clean slate needs a fresh
 * account every run rather than one that accumulates state across runs.
 */
export async function signUpFreshE2EUser(label: string): Promise<E2EClient> {
  const client = new E2EClient();
  const suffix = randomUUID().slice(0, 8);
  const email = `e2e-${label}-${suffix}@xevo.test`;
  const password = "E2E-test-password-1!";

  const signUp = await client.postJson("/api/auth/sign-up/email", {
    email,
    password,
    name: `E2E ${label} ${suffix}`,
  });
  if (!signUp.ok) {
    const body = await signUp.text().catch(() => "");
    throw new Error(`Fresh e2e user sign-up failed for ${email} (${signUp.status}): ${body}`);
  }

  const signIn = await client.postJson("/api/auth/sign-in/email", { email, password });
  if (!signIn.ok) {
    const body = await signIn.text().catch(() => "");
    throw new Error(
      `Fresh e2e user sign-in failed after sign-up for ${email} (${signIn.status}): ${body}`
    );
  }

  return client;
}
