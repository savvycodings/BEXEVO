import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { expo } from "@better-auth/expo";
import { db, user, session, account, verification } from "./db";

const resolvedBaseUrl = process.env.BETTER_AUTH_URL;
const resolvedSecret = process.env.BETTER_AUTH_SECRET;
const isDevelopment = process.env.ENVIRONMENT !== "PRODUCTION";

function buildSocialProviders() {
  const googleId = process.env.GOOGLE_CLIENT_ID?.trim();
  const googleSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  const facebookId = process.env.FACEBOOK_CLIENT_ID?.trim();
  const facebookSecret = process.env.FACEBOOK_CLIENT_SECRET?.trim();
  const appleId = process.env.APPLE_CLIENT_ID?.trim();
  const appleSecret = process.env.APPLE_CLIENT_SECRET?.trim();

  const providers: Record<
    string,
    { clientId: string; clientSecret: string; appBundleIdentifier?: string }
  > = {};

  if (googleId && googleSecret) {
    providers.google = { clientId: googleId, clientSecret: googleSecret };
  }
  if (facebookId && facebookSecret) {
    providers.facebook = { clientId: facebookId, clientSecret: facebookSecret };
  }
  if (appleId && appleSecret) {
    providers.apple = {
      clientId: appleId,
      clientSecret: appleSecret,
      ...(process.env.APPLE_APP_BUNDLE_IDENTIFIER?.trim()
        ? { appBundleIdentifier: process.env.APPLE_APP_BUNDLE_IDENTIFIER.trim() }
        : {}),
    };
  }

  return providers;
}

const socialProviders = buildSocialProviders();
const hasSocialProviders = Object.keys(socialProviders).length > 0;

const trustedOrigins = [
  resolvedBaseUrl || "http://localhost:3050",
  "http://localhost:8081",
  "http://127.0.0.1:8081",
  "exp://",
  "xevo://",
  "xevo://*",
];

console.log("[BetterAuth] Initializing auth", {
  baseURL: resolvedBaseUrl,
  hasSecret: !!resolvedSecret,
  environment: process.env.ENVIRONMENT,
  trustedOrigins,
  socialProviders: hasSocialProviders ? Object.keys(socialProviders) : [],
});

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user,
      session,
      account,
      verification,
    },
  }),
  emailAndPassword: {
    enabled: true,
  },
  plugins: [expo()],
  ...(hasSocialProviders ? { socialProviders } : {}),
  secret: resolvedSecret,
  baseURL: resolvedBaseUrl,
  cookies: {
    sessionToken: {
      sameSite: isDevelopment ? "lax" : "none",
      secure: !isDevelopment,
    },
  },
  trustedOrigins,
});
