import { buildCoachReviewReadyEmail } from "./templates/coachReviewReady";
import { getFromAddress, getResendClient, isEmailConfigured } from "./resendClient";

export type SendCoachReviewReadyEmailInput = {
  reviewId: string;
  to: string;
  studentName: string;
  coachFeedbackText: string | null;
  annotationCount: number;
};

export async function sendCoachReviewReadyEmail(
  input: SendCoachReviewReadyEmailInput
): Promise<{ sent: boolean; emailId?: string; skipped?: string; error?: string }> {
  if (!isEmailConfigured()) {
    return { sent: false, skipped: "email_not_configured" };
  }

  const resend = getResendClient();
  const from = getFromAddress();
  if (!resend || !from) {
    return { sent: false, skipped: "email_not_configured" };
  }

  const openBase = (process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  const openUrl = openBase ? `${openBase}/` : null;
  const preview =
    input.coachFeedbackText && input.coachFeedbackText.length > 0
      ? input.coachFeedbackText.slice(0, 220)
      : null;

  const { subject, html, text } = buildCoachReviewReadyEmail({
    studentName: input.studentName,
    coachFeedbackPreview: preview,
    annotationCount: input.annotationCount,
    openUrl,
  });

  const { data, error } = await resend.emails.send(
    {
      from,
      to: [input.to],
      subject,
      html,
      text,
      tags: [
        { name: "kind", value: "coach_review_ready" },
        { name: "review_id", value: input.reviewId },
      ],
    },
    { idempotencyKey: `coach-review-ready/${input.reviewId}` }
  );

  if (error) {
    console.error("[Email] coach_review_ready send failed", {
      reviewId: input.reviewId,
      message: error.message,
    });
    return { sent: false, error: error.message };
  }

  return { sent: true, emailId: data?.id };
}
