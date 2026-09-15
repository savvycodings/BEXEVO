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
