import "dotenv/config";

export type TrainUploadAuth = {
  authorization?: string;
  cookie?: string;
};

function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

async function probeBaseUrl(base: string): Promise<boolean> {
  try {
    const res = await fetch(`${normalizeBaseUrl(base)}/api/auth/get-session`, {
      signal: AbortSignal.timeout(5000),
    });
    return res.status < 500;
  } catch {
    return false;
  }
}

/** Pick localhost when up; otherwise fall back to BETTER_AUTH_URL / ngrok. */
export async function resolveTrainUploadBaseUrl(): Promise<string> {
  const explicit = normalizeBaseUrl(process.env.TRAIN_UPLOAD_BASE_URL || "");
  const candidates = [
    explicit,
    "http://127.0.0.1:3050",
    normalizeBaseUrl(process.env.BETTER_AUTH_URL || ""),
    normalizeBaseUrl(process.env.PUBLIC_VIDEO_BASE_URL || ""),
  ].filter(Boolean);

  const seen = new Set<string>();
  const unique = candidates.filter((u) => {
    if (seen.has(u)) return false;
    seen.add(u);
    return true;
  });

  for (const base of unique) {
    if (await probeBaseUrl(base)) {
      if (explicit && base !== explicit) {
        console.warn(`[train-upload] ${explicit} unreachable — using ${base}`);
      } else if (!explicit && base !== "http://127.0.0.1:3050") {
        console.warn(`[train-upload] localhost:3050 not running — using ${base}`);
      }
      return base;
    }
  }

  throw new Error(
    `No API reachable. Start the server (pnpm dev in server/) or set TRAIN_UPLOAD_BASE_URL.\nTried: ${unique.join(", ")}`
  );
}

/**
 * Resolve session for POST /api/auth/train/upload.
 *
 * Priority:
 * 1. TRAIN_UPLOAD_SESSION_TOKEN → Authorization: Bearer
 * 2. TRAIN_UPLOAD_SESSION_COOKIE → Cookie header (full value or just token)
 * 3. TRAIN_UPLOAD_EMAIL + TRAIN_UPLOAD_PASSWORD → sign-in via Better Auth
 */
export async function resolveTrainUploadAuth(baseUrl: string): Promise<TrainUploadAuth> {
  const token = (process.env.TRAIN_UPLOAD_SESSION_TOKEN || "").trim();
  if (token) {
    return { authorization: `Bearer ${token}` };
  }

  const cookieRaw = (process.env.TRAIN_UPLOAD_SESSION_COOKIE || "").trim();
  if (cookieRaw) {
    const cookie = cookieRaw.includes("=")
      ? cookieRaw
      : `better-auth.session_token=${cookieRaw}`;
    return { cookie };
  }

  const email = (process.env.TRAIN_UPLOAD_EMAIL || "").trim();
  const password = process.env.TRAIN_UPLOAD_PASSWORD || "";
  if (!email || !password) {
    throw new Error(
      "Set TRAIN_UPLOAD_SESSION_TOKEN, TRAIN_UPLOAD_SESSION_COOKIE, or TRAIN_UPLOAD_EMAIL + TRAIN_UPLOAD_PASSWORD in server/.env"
    );
  }

  const url = `${baseUrl.replace(/\/+$/, "")}/api/auth/sign-in/email`;
  const origin =
    (process.env.TRAIN_UPLOAD_ORIGIN || "").trim() ||
    (() => {
      try {
        return new URL(baseUrl).origin;
      } catch {
        return "http://127.0.0.1:3050";
      }
    })();

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
    },
    body: JSON.stringify({ email, password }),
  });

  const setCookie = res.headers.getSetCookie?.() ?? [];
  const cookieHeader = setCookie.length
    ? setCookie.map((c) => c.split(";")[0]).join("; ")
    : res.headers.get("set-cookie")?.split(",")[0]?.split(";")[0] ?? "";

  const body = (await res.json().catch(() => null)) as {
    token?: string;
    session?: { token?: string };
  } | null;

  if (cookieHeader) {
    return { cookie: cookieHeader };
  }

  const sessionToken = body?.token ?? body?.session?.token;
  if (sessionToken) {
    return { authorization: `Bearer ${sessionToken}` };
  }

  if (!res.ok) {
    throw new Error(`Sign-in failed (${res.status}): ${JSON.stringify(body)}`);
  }

  throw new Error(
    "Sign-in succeeded but no session token/cookie returned. Set TRAIN_UPLOAD_SESSION_TOKEN manually."
  );
}

export function printTrainUploadAuthHelp(): void {
  console.log(`
Train upload authentication (set in server/.env):

  Option A — Bearer token (from app session / DB session.token):
    TRAIN_UPLOAD_SESSION_TOKEN=<token>

  Option B — Cookie (from browser devtools after sign-in):
    TRAIN_UPLOAD_SESSION_COOKIE=better-auth.session_token=...

  Option C — Email/password (script signs in once per run):
    TRAIN_UPLOAD_EMAIL=you@example.com
    TRAIN_UPLOAD_PASSWORD=...

  Base URL (default BETTER_AUTH_URL or http://127.0.0.1:3050):
    TRAIN_UPLOAD_BASE_URL=https://xevo-api-kyle.ngrok-free.dev

  Admin secret (default ADMIN_TRAIN_SECRET or xevodev):
    ADMIN_TRAIN_SECRET=xevodev
`);
}
