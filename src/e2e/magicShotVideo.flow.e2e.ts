// Backend flow for the pose-correction Magic Shot video (XEVO_VIDEO_PROVIDER=pose-correction).
// Needs the server in fakes mode (`pnpm dev:e2e`): the analyzer fixture carries 3D landmarks and
// the fake video provider returns the corrected skeleton, so no paid call is made.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { signInE2EUser } from "./lib/testUser";
import { E2E_BASE_URL } from "./lib/http";

const CLIP = path.join(__dirname, "fixtures", "player-forehand-volley.mp4");
const SHOT = { category: "net_play", strokePreset: "forehand_volley", shotLabel: "Forehand volley", viewId: "front" };

async function flags(body: Record<string, unknown>) {
  await fetch(`${E2E_BASE_URL}/__e2e/flags`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

async function analyzedFixture(client: Awaited<ReturnType<typeof signInE2EUser>>): Promise<string> {
  const form = new FormData();
  form.append("video", new Blob([fs.readFileSync(CLIP)], { type: "video/mp4" }), "fv.mp4");
  const up = await client.request("/api/auth/technique/upload", { method: "POST", body: form });
  const { id } = JSON.parse(await up.text());
  const an = await client.postJson("/api/auth/technique/analyze", { techniqueVideoId: id, userShot: SHOT });
  const text = await an.text();
  assert.equal(an.status, 200, text);
  return JSON.parse(text).analysisId;
}

async function pollVideo(client: Awaited<ReturnType<typeof signInE2EUser>>, analysisId: string, want: string) {
  for (let i = 0; i < 90; i++) {
    const { body } = await client.getJson(`/api/auth/technique/analysis/${analysisId}/correction-videos`);
    if (body.status === want || (body.status !== "running" && body.status !== "idle")) return body;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("correction video did not finish");
}

test("pose-correction Magic Shot video", async (t) => {
  const r = await fetch(`${E2E_BASE_URL}/__e2e/health`).catch(() => null);
  if (!r || !r.ok || !(await r.json()).fakes) {
    t.skip("server is not in fakes mode");
    return;
  }
  await fetch(`${E2E_BASE_URL}/__e2e/seed`, { method: "POST" });
  await flags({ fakeVideoFail: false });
  const client = await signInE2EUser();

  await t.test("done: video, skeleton, start image, overlay and corrections", { timeout: 180_000 }, async () => {
    const analysisId = await analyzedFixture(client);
    const start = await client.postJson("/api/auth/technique/correction-videos", { analysisId, forceRegenerate: true });
    assert.equal(start.status, 202, await start.text());
    const body = await pollVideo(client, analysisId, "done");
    assert.equal(body.status, "done", JSON.stringify(body));
    for (const k of ["video", "poseVideo", "startImage", "overlayVideo"]) assert.ok(body[k], `missing ${k}`);
    assert.ok(Array.isArray(body.corrections), "corrections should be a list");
    const vid = await fetch(`${E2E_BASE_URL}${body.video}`);
    assert.equal(Buffer.from(await vid.arrayBuffer()).subarray(4, 8).toString(), "ftyp");
    assert.equal(body.correction_context_videos_comfy.pipeline, "pose-correction");
    assert.equal(body.correction_context_videos_comfy.pro_reference_id, "fh-volley-front-42cf0eba");
  });

  await t.test("invalid strengths are refused up front", async () => {
    const analysisId = await analyzedFixture(client);
    const res = await client.postJson("/api/auth/technique/correction-videos", { analysisId, strengths: { racketArm: 5 } });
    assert.equal(res.status, 400, await res.text());
  });

  await t.test("provider failure: failed status, no video stored", { timeout: 180_000 }, async () => {
    const analysisId = await analyzedFixture(client);
    await flags({ fakeVideoFail: true });
    try {
      const start = await client.postJson("/api/auth/technique/correction-videos", { analysisId, forceRegenerate: true });
      assert.equal(start.status, 202);
      const body = await pollVideo(client, analysisId, "failed");
      assert.equal(body.status, "failed", JSON.stringify(body));
      assert.match(String(body.error), /Fake provider failure/);
      assert.equal(body.video, null);
    } finally {
      await flags({ fakeVideoFail: false });
    }
  });
});
