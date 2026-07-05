import { buildSignupVerificationEmail } from "./templates/signupVerificationEmail";
import { getFromAddress, getResendClient, isEmailConfigured } from "./resendClient";

export type SendSignupVerificationEmailInput = {
  to: string;
  name?: string | null;
  code: string;
};

export async function sendSignupVerificationEmail(
  input: SendSignupVerificationEmailInput
): Promise<{ sent: boolean; emailId?: string; skipped?: string; error?: string }> {
  if (!isEmailConfigured()) {
    console.warn("[Email] signup_verification skipped — RESEND not configured", {
      to: input.to,
      code: input.code,
    });
    return { sent: false, skipped: "email_not_configured" };
  }

  const resend = getResendClient();
  const from = getFromAddress();
  if (!resend || !from) {
    return { sent: false, skipped: "email_not_configured" };
  }

  const { subject, html, text } = buildSignupVerificationEmail({
    name: input.name,
    code: input.code,
  });

  const { data, error } = await resend.emails.send({
    from,
    to: [input.to],
    subject,
    html,
    text,
    tags: [{ name: "kind", value: "signup_verification" }],
  });

  if (error) {
    console.error("[Email] signup_verification send failed", {
      to: input.to,
      message: error.message,
    });
    return { sent: false, error: error.message };
  }

  return { sent: true, emailId: data?.id };
}
