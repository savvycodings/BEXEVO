import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db, user, session, account, verification } from "./db";

const resolvedBaseUrl = process.env.BETTER_AUTH_URL;
const resolvedSecret = process.env.BETTER_AUTH_SECRET;
const isDevelopment = process.env.ENVIRONMENT !== "PRODUCTION";

const trustedOrigins = [
  resolvedBaseUrl || "http://localhost:3050",
  "http://localhost:8081",
  "http://127.0.0.1:8081",
  "exp://",
  "xevo://",
];

console.log("[BetterAuth] Initializing auth", {
  baseURL: resolvedBaseUrl,
  hasSecret: !!resolvedSecret,
  environment: process.env.ENVIRONMENT,
  trustedOrigins,
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
