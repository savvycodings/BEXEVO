export type CoachReviewReadyEmailParams = {
  studentName: string;
  coachFeedbackPreview: string | null;
  annotationCount: number;
  openUrl: string | null;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildCoachReviewReadyEmail(
  params: CoachReviewReadyEmailParams
): { subject: string; html: string; text: string } {
  const greeting = params.studentName.trim() || "there";
  const preview = params.coachFeedbackPreview?.trim() || null;
  const marksLine =
    params.annotationCount === 1
      ? "1 annotated frame"
      : `${params.annotationCount} annotated frames`;

  const subject = "Your coach feedback is ready";

  const textParts = [
    `Hi ${greeting},`,
    "",
    "Your coach finished reviewing your technique video.",
    preview ? `Feedback preview: ${preview}` : "Open Xevo to read the full review and see frame-by-frame marks.",
    params.annotationCount > 0 ? `Includes ${marksLine}.` : "",
    params.openUrl ? `Open in Xevo: ${params.openUrl}` : "Open the Xevo app and check Activities for the full review.",
    "",
    "— Xevo",
  ].filter(Boolean);

  const previewBlock = preview
    ? `<p style="margin:16px 0;padding:12px 14px;background:#f4f4f5;border-radius:8px;color:#18181b;font-size:15px;line-height:1.5;">${escapeHtml(preview)}</p>`
    : `<p style="margin:16px 0;color:#52525b;font-size:15px;line-height:1.5;">Open Xevo to read the full review and see frame-by-frame marks.</p>`;

  const marksBlock =
    params.annotationCount > 0
      ? `<p style="margin:0 0 16px;color:#52525b;font-size:14px;">Includes ${escapeHtml(marksLine)}.</p>`
      : "";

  const ctaBlock = params.openUrl
    ? `<p style="margin:24px 0 0;"><a href="${escapeHtml(params.openUrl)}" style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:8px;font-size:14px;font-weight:600;">View coach review</a></p>`
    : `<p style="margin:24px 0 0;color:#52525b;font-size:14px;">Open the Xevo app and check <strong>Activities</strong> for the full review.</p>`;

  const html = `<!DOCTYPE html>
<html lang="en">
  <body style="margin:0;padding:0;background:#fafafa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#fafafa;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border:1px solid #e4e4e7;border-radius:12px;padding:28px 24px;">
            <tr>
              <td>
                <p style="margin:0 0 8px;font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#71717a;">Xevo</p>
                <h1 style="margin:0 0 12px;font-size:24px;line-height:1.25;color:#18181b;">Coach feedback is ready</h1>
                <p style="margin:0 0 16px;color:#52525b;font-size:15px;line-height:1.5;">Hi ${escapeHtml(greeting)}, your coach finished reviewing your technique video.</p>
                ${previewBlock}
                ${marksBlock}
                ${ctaBlock}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { subject, html, text: textParts.join("\n") };
}
