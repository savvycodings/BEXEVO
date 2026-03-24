const CONTACT =
  (
    process.env.DATA_DELETION_CONTACT_EMAIL ||
    process.env.PRIVACY_CONTACT_EMAIL ||
    'privacy@xevopadel.com'
  ).trim() || 'privacy@xevopadel.com'

const LAST_UPDATED = '2026-03-25'

export function getDataDeletionHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>User data deletion – Xevo Padel</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; line-height: 1.55; max-width: 44rem; margin: 0 auto; padding: 1.5rem; color: #111; }
    h1 { font-size: 1.75rem; margin-top: 0; }
    h2 { font-size: 1.15rem; margin-top: 1.75rem; }
    p, ul { font-size: 0.95rem; margin: 0.75rem 0; }
    ul { padding-left: 1.25rem; }
    .meta { color: #555; font-size: 0.875rem; margin-bottom: 1.5rem; }
    a { color: #0066cc; }
  </style>
</head>
<body>
  <h1>User data deletion</h1>
  <p class="meta">Xevo Padel · Last updated: ${LAST_UPDATED}</p>

  <p>If you use Xevo Padel and want your personal data associated with the app removed, you can request deletion as described below.</p>

  <h2>What you can request</h2>
  <ul>
    <li>Deletion of your account and profile information tied to your login.</li>
    <li>Deletion of your uploaded technique videos and related analysis outputs generated for your account (subject to technical retention limits).</li>
  </ul>

  <h2>How to request deletion</h2>
  <p>Send an email to <a href="mailto:${CONTACT}">${CONTACT}</a> with the subject line “Data deletion request” and include:</p>
  <ul>
    <li>The email address associated with your Xevo Padel account (or the sign-in method you used, for example Facebook).</li>
    <li>A short description of what you want deleted (e.g. full account and uploads, or account only).</li>
  </ul>
  <p>We may need to verify your identity before processing the request. We will respond within a reasonable time and in line with applicable law.</p>

  <h2>Facebook Login</h2>
  <p>If you connected with Facebook, you can also remove the app from your Facebook settings: Facebook → Settings &amp; privacy → Settings → Apps and websites → Xevo Padel → Remove. That does not automatically delete all data we may already hold; use the email process above for a full account deletion request.</p>

  <h2>Related</h2>
  <p><a href="/privacy">Privacy policy</a></p>
</body>
</html>`
}
