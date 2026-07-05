export function buildSignupVerificationEmail(input: {
  name?: string | null;
  code: string;
}): { subject: string; html: string; text: string } {
  const greeting = input.name?.trim() ? `Hi ${input.name.trim()},` : "Hi,";
  const subject = `${input.code} is your Xevo verification code`;

  const text = [
    greeting,
    "",
    "Use this code to verify your email and continue setting up your Xevo account:",
    "",
    input.code,
    "",
    "This code expires in 10 minutes. If you did not request this, you can ignore this email.",
    "",
    "— Xevo Padel",
  ].join("\n");

  const html = `<!DOCTYPE html>
<html lang="en">
  <body style="margin:0;padding:0;background:#030A17;font-family:Arial,sans-serif;color:#E8F1FF;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#030A17;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:480px;background:#071D47;border:1px solid rgba(0,120,255,0.35);border-radius:18px;padding:28px 24px;">
            <tr>
              <td style="font-size:16px;line-height:24px;padding-bottom:12px;">${greeting}</td>
            </tr>
            <tr>
              <td style="font-size:15px;line-height:22px;color:#A5C4EB;padding-bottom:20px;">
                Enter this verification code in the app to continue creating your account:
              </td>
            </tr>
            <tr>
              <td align="center" style="padding-bottom:20px;">
                <div style="display:inline-block;font-size:34px;letter-spacing:10px;font-weight:700;color:#00BBFF;background:#041641;border:1px solid rgba(0,187,255,0.35);border-radius:14px;padding:16px 22px;">
                  ${input.code}
                </div>
              </td>
            </tr>
            <tr>
              <td style="font-size:13px;line-height:20px;color:#86A7D2;">
                This code expires in 10 minutes. If you did not request this email, you can safely ignore it.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { subject, html, text };
}
