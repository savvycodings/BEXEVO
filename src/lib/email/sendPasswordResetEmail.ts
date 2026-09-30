import { buildPasswordResetEmail } from "./templates/passwordResetEmail";
import { getFromAddress, getResendClient, isEmailConfigured } from "./resendClient";

export type SendPasswordResetEmailInput = {
  to: string;
  code: string;
};

export async function sendPasswordResetEmail(
  input: SendPasswordResetEmailInput
): Promise<{ sent: boolean; emailId?: string; skipped?: string; error?: string }> {
  if (!isEmailConfigured()) {
    console.warn("[Email] password_reset skipped — RESEND not configured", {
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

  const { subject, html, text } = buildPasswordResetEmail({ code: input.code });
  const { data, error } = await resend.emails.send({
    from,
    to: [input.to],
    subject,
    html,
    text,
    tags: [{ name: "kind", value: "password_reset" }],
  });

  if (error) {
    console.error("[Email] password_reset send failed", {
      to: input.to,
      from,
      message: error.message,
      name: error.name,
    });
    return { sent: false, error: error.message };
  }

  console.log("[Email] password_reset sent", {
    to: input.to,
    from,
    emailId: data?.id,
  });

  return { sent: true, emailId: data?.id };
}
