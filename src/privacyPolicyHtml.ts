const CONTACT =
  (process.env.PRIVACY_CONTACT_EMAIL || 'privacy@xevopadel.com').trim() || 'privacy@xevopadel.com'

const LAST_UPDATED = '2026-03-25'

export function getPrivacyPolicyHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Privacy Policy – Xevo Padel</title>
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
  <h1>Privacy Policy</h1>
  <p class="meta">Xevo Padel (“we”, “us”) · Last updated: ${LAST_UPDATED}</p>

  <p>This policy describes how we collect, use, and share information when you use the Xevo Padel mobile application and related services (the “Services”).</p>

  <h2>Information we collect</h2>
  <ul>
    <li><strong>Account data.</strong> If you create an account, we process information you provide (such as name, email address, and authentication identifiers). Social sign-in (for example Google, Facebook, or Apple) is handled by your provider and our authentication service according to your choices there.</li>
    <li><strong>Profile and preferences.</strong> Optional details you add in the app (for example playing preferences or ranking information).</li>
    <li><strong>Content you upload.</strong> Videos and related media you submit for technique analysis, and derived outputs (such as pose-related metrics, scores, and AI-generated feedback or images) processed to deliver the Services.</li>
    <li><strong>Technical data.</strong> Device or connection data typical for mobile apps and APIs (for example IP address, app version, and error logs) used to operate and secure the Services.</li>
  </ul>

  <h2>How we use information</h2>
  <ul>
    <li>To provide, maintain, and improve the Services (including AI-assisted coaching features).</li>
    <li>To authenticate you and protect accounts.</li>
    <li>To comply with law and respond to valid legal requests.</li>
  </ul>

  <h2>Processors and third parties</h2>
  <p>We use trusted infrastructure and service providers (for example hosting, database, and AI model providers) who process data on our instructions to operate the Services. Where you connect a third-party account (such as Facebook), that provider’s privacy policy also applies to information you share with them.</p>

  <h2>Retention</h2>
  <p>We retain information as long as needed to provide the Services, comply with legal obligations, resolve disputes, and enforce our agreements. You may request deletion of your account subject to applicable law and technical limits.</p>

  <h2>Security</h2>
  <p>We use reasonable technical and organizational measures to protect your information. No method of transmission over the Internet is completely secure.</p>

  <h2>International transfers</h2>
  <p>Your information may be processed in countries where we or our providers operate.</p>

  <h2>Children</h2>
  <p>The Services are not directed at children under 13 (or the minimum age required in your jurisdiction). We do not knowingly collect personal information from children in violation of applicable law.</p>

  <h2>Your rights</h2>
  <p>Depending on where you live, you may have rights to access, correct, delete, or object to certain processing of your personal information. Contact us to make a request.</p>

  <h2>Changes</h2>
  <p>We may update this policy from time to time. We will post the updated version on this page and adjust the “Last updated” date above.</p>

  <h2>Contact</h2>
  <p>Questions about this policy: <a href="mailto:${CONTACT}">${CONTACT}</a></p>
  <p><a href="/data-deletion">How to request deletion of your data</a></p>
</body>
</html>`
}
