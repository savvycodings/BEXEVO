// Backend E2E flow: sign in -> upload -> analyze -> read analysis -> appears in activities.
//
// This hits a REAL running server (E2E_BASE_URL, default http://localhost:3050) with REAL
// upstream calls (fal.ai for pose/analysis, an LLM for coach text) — there is no mocking layer
// for those clients today (they're called inline, not through an injectable interface), so this
// suite is slower and non-deterministic in exact output, and costs real API usage per run.
// That's a real gap, not a design choice — see README.md "Known limitation" for the follow-up.
//
// Run: start the server (`pnpm run dev`) in one terminal, then in another:
//   pnpm run test:e2e
//
// Env:
//   E2E_BASE_URL        default http://localhost:3050
//   E2E_TEST_EMAIL       default e2e-bexevo@xevo.test (auto-created on first run)
//   E2E_TEST_PASSWORD    default E2E-test-password-1!
//   E2E_INCLUDE_COMFY    set to "1" to also exercise /correction-images (needs a reachable
//                        Comfy instance — see COMFYUI_BASE_URL on the server itself)
//   E2E_ANALYZE_TIMEOUT_MS  default 120000 — /analyze blocks until the full pipeline finishes
//
// Fakes mode: when the server runs with XEVO_E2E_FAKES=1 (`pnpm dev:e2e`), the AI calls are
// served from src/e2e/fixtures, so this flow uploads the real fixture clip, expects a completed
// analysis, also runs /correction-images, and asserts no real outbound request was made.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import { signInE2EUser } from "./lib/testUser";
import { makeFixtureVideo } from "./lib/fixtureVideo";
import path from "path";
import { E2E_BASE_URL } from "./lib/http";

async function serverFakes(): Promise<boolean> {
  const r = await fetch(`${E2E_BASE_URL}/__e2e/health`).catch(() => null);
  if (!r || !r.ok) return false;
  return Boolean(((await r.json()) as { fakes?: boolean }).fakes);
}

const ANALYZE_TIMEOUT_MS = Number(process.env.E2E_ANALYZE_TIMEOUT_MS ?? 120_000);
const INCLUDE_COMFY = process.env.E2E_INCLUDE_COMFY === "1";

test("technique flow: upload -> analyze -> analysis -> activities", async (t) => {
  // Setup steps (sign-in, fixture creation) run as plain awaits, not subtests — t.test()
  // resolves to whether the subtest passed, not the callback's return value, so anything whose
  // result later steps depend on has to be captured outside of it.
  const client = await signInE2EUser();
  const fakes = await serverFakes();
  if (fakes) await fetch(`${E2E_BASE_URL}/__e2e/outbound`, { method: "DELETE" });

  const fixture = fakes
    ? { path: path.join(__dirname, "fixtures", "player-forehand-volley.mp4"), cleanup: () => {} }
    : await makeFixtureVideo({ seconds: 2 });
  t.after(() => fixture.cleanup());

  let techniqueVideoId = "";
  await t.test("upload video", async () => {
    const buf = await fs.promises.readFile(fixture.path);
    const form = new FormData();
    form.append("video", new Blob([buf], { type: "video/mp4" }), "e2e-fixture.mp4");

    const res = await client.request("/api/auth/technique/upload", {
      method: "POST",
      body: form,
    });
    const text = await res.text();
    assert.equal(res.status, 200, `upload failed: ${text}`);
    const body = JSON.parse(text);
    assert.ok(body.id, "upload response missing id");
    techniqueVideoId = body.id;
  });

  let analysisId = "";
  await t.test(
    "analyze video (real AI calls, or fixtures in fakes mode)",
    { timeout: ANALYZE_TIMEOUT_MS },
    async () => {
      const res = await client.postJson("/api/auth/technique/analyze", {
        techniqueVideoId,
      });
      const text = await res.text();
      assert.equal(res.status, 200, `analyze failed: ${text}`);
      const body = JSON.parse(text);
      assert.ok(body.analysisId, "analyze response missing analysisId");
      analysisId = body.analysisId;
    }
  );

  await t.test("fetch completed analysis", async () => {
    const { status, body } = await client.getJson(`/api/auth/technique/analysis/${analysisId}`);
    assert.equal(status, 200);
    // /analyze is synchronous — by the time it returns, status is already 'completed' or
    // 'failed'. A synthetic testsrc clip has no real pose to find, so 'failed' here (the
    // pipeline ran and reported no analyzable pose) is a legitimate outcome, not a test bug —
    // only an unexpected status or a thrown request is.
    assert.ok(
      (fakes ? ["completed"] : ["completed", "failed"]).includes(body.status),
      `unexpected analysis status: ${body.status}`
    );
  });

  await t.test("analysis appears in activities list", async () => {
    const { status, body } = await client.getJson("/api/auth/technique/activities");
    assert.equal(status, 200);
    const list: any[] = Array.isArray(body) ? body : body?.items ?? body?.activities ?? [];
    const ids = list.map((a: any) => a.analysisId ?? a.id);
    assert.ok(ids?.includes(analysisId), "new analysis not present in /activities");
  });

  await t.test(
    "correction images render (Comfy, or fixtures in fakes mode)",
    { timeout: ANALYZE_TIMEOUT_MS, skip: !INCLUDE_COMFY && !fakes && "set E2E_INCLUDE_COMFY=1 to include it" },
    async () => {
      const res = await client.postJson("/api/auth/technique/correction-images", {
        analysisId,
      });
      assert.equal(res.status, 200, `correction-images failed: ${await res.text()}`);
    }
  );

  await t.test("no real outbound calls in fakes mode", { skip: !fakes && "server is not in fakes mode" }, async () => {
    const r = await fetch(`${E2E_BASE_URL}/__e2e/health`);
    const h = (await r.json()) as { outboundCalls: number; outbound: Array<{ url: string }> };
    assert.equal(h.outboundCalls, 0, `real outbound calls: ${h.outbound.map((o) => o.url).join(", ")}`);
  });
});
