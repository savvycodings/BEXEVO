// Minimal cookie-jar fetch client. `fetch` doesn't manage cookies across calls the way a
// browser does, and better-auth's Node handler authenticates via a session cookie — so every
// e2e call needs to go through one client instance to stay logged in.

export const E2E_BASE_URL = (process.env.E2E_BASE_URL ?? "http://localhost:3050").replace(
  /\/+$/,
  ""
);

export class E2EClient {
  private cookies = new Map<string, string>();

  private applySetCookie(res: Response) {
    // Node's fetch exposes multiple Set-Cookie headers via getSetCookie(); fall back to a
    // single header read for older runtimes.
    const raw =
      typeof (res.headers as any).getSetCookie === "function"
        ? (res.headers as any).getSetCookie()
        : [res.headers.get("set-cookie")].filter((v): v is string => !!v);

    for (const cookieStr of raw) {
      const [pair] = cookieStr.split(";");
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    const cookieHeader = this.cookieHeader();
    if (cookieHeader) headers.set("cookie", cookieHeader);

    const res = await fetch(`${E2E_BASE_URL}${path}`, { ...init, headers });
    this.applySetCookie(res);
    return res;
  }

  async postJson(path: string, body: unknown): Promise<Response> {
    return this.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async getJson<T = any>(path: string): Promise<{ status: number; body: T }> {
    const res = await this.request(path, { method: "GET" });
    const body = (await res.json().catch(() => null)) as T;
    return { status: res.status, body };
  }
}
