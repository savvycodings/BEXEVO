import express from "express";
import { fromNodeHeaders } from "better-auth/node";
import { eq } from "drizzle-orm";
import { auth } from "../auth";
import { db, user } from "../db";
import {
  consumeSignupVerificationToken,
  normalizeSignupEmail,
  sendSignupVerificationCode,
  verifySignupVerificationCode,
} from "./signupVerificationService";

const router = express.Router();
router.use(express.json());

router.post("/send-code", async (req, res) => {
  try {
    const email = typeof req.body?.email === "string" ? req.body.email : "";
    const name = typeof req.body?.name === "string" ? req.body.name : undefined;
    const result = await sendSignupVerificationCode(email, name);

    if (!result.ok) {
      const status =
        result.error === "RESEND_COOLDOWN" ? 429 : result.error === "INVALID_EMAIL" ? 400 : 502;
      return res.status(status).json({
        error: result.error,
        message: result.message,
        retryAfterSec: result.retryAfterSec,
      });
    }

    return res.json({ ok: true, retryAfterSec: result.retryAfterSec ?? 60 });
  } catch (err) {
    console.error("[SignupVerification] send-code failed", err);
    return res.status(500).json({ error: "SERVER_ERROR", message: "Could not send verification code." });
  }
});

router.post("/verify-code", async (req, res) => {
  try {
    const email = typeof req.body?.email === "string" ? req.body.email : "";
    const code = typeof req.body?.code === "string" ? req.body.code : "";
    const result = await verifySignupVerificationCode(email, code);

    if (!result.ok) {
      const status = result.error === "EXPIRED" || result.error === "INVALID_CODE" ? 400 : 400;
      return res.status(status).json({ error: result.error, message: result.message });
    }

    return res.json({ ok: true, verificationToken: result.verificationToken });
  } catch (err) {
    console.error("[SignupVerification] verify-code failed", err);
    return res.status(500).json({ error: "SERVER_ERROR", message: "Could not verify code." });
  }
});

router.post("/register", async (req, res) => {
  try {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const email = typeof req.body?.email === "string" ? req.body.email : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const verificationToken =
      typeof req.body?.verificationToken === "string" ? req.body.verificationToken : "";

    if (!name || !email || !password) {
      return res.status(400).json({ error: "MISSING_FIELDS", message: "Name, email, and password are required." });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: "WEAK_PASSWORD", message: "Password must be at least 8 characters." });
    }

    const normalized = normalizeSignupEmail(email);
    const verified = await consumeSignupVerificationToken(normalized, verificationToken);
    if (!verified) {
      return res.status(400).json({
        error: "EMAIL_NOT_VERIFIED",
        message: "Verify your email before creating your account.",
      });
    }

    const signUpResponse = await auth.api.signUpEmail({
      body: { name, email: normalized, password },
      headers: fromNodeHeaders(req.headers),
      asResponse: true,
    });

    const payload = await signUpResponse.json().catch(() => null);
    if (!signUpResponse.ok) {
      return res.status(signUpResponse.status).json(payload ?? { error: "SIGNUP_FAILED" });
    }

    await db
      .update(user)
      .set({ emailVerified: true, updatedAt: new Date() })
      .where(eq(user.email, normalized));

    const setCookie = signUpResponse.headers.get("set-cookie");
    if (setCookie) res.setHeader("set-cookie", setCookie);

    return res.status(signUpResponse.status).json(payload);
  } catch (err) {
    console.error("[SignupVerification] register failed", err);
    return res.status(500).json({ error: "SERVER_ERROR", message: "Could not create account." });
  }
});

export default router;
