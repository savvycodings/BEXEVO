// Backend E2E flow: POST /profile/player-details, the partial update behind the app's
// Game Settings "player details" step. Only the keys sent are written.
//
// Run: start the server (`pnpm dev:e2e`), then `pnpm test:e2e`.
// Env: E2E_BASE_URL (default http://localhost:3050).

import test from "node:test";
import assert from "node:assert/strict";
import { E2EClient } from "./lib/http";
import { signUpFreshE2EUser } from "./lib/testUser";

const PATH = "/api/auth/profile/player-details";

async function me(client: E2EClient) {
  const { status, body } = await client.getJson("/api/auth/profile/me");
  assert.equal(status, 200, `GET /me failed (${status})`);
  return body.profile;
}

test("profile: player-details partial update", async (t) => {
  const player = await signUpFreshE2EUser("player-details");

  const setup = await player.postJson("/api/auth/profile/setup", {
    name: "E2E Player Details",
    username: "e2e_player_details",
    gender: "Male",
    dominantHand: "right",
    courtSide: "right",
    hasRanking: "false",
    level: "Beginner",
    areaLocation: "Madrid, Spain",
    heightCm: 170,
    weightKg: 85,
  });
  assert.equal(setup.status, 200, `setup failed: ${await setup.text()}`);

  await t.test("a user with no profile gets 404", async () => {
    const fresh = await signUpFreshE2EUser("player-details-noprofile");
    const res = await fresh.postJson(PATH, { courtSide: "left" });
    assert.equal(res.status, 404);
  });

  await t.test("posting only courtSide leaves every other field unchanged", async () => {
    const before = await me(player);
    const res = await player.postJson(PATH, { courtSide: "left" });
    assert.equal(res.status, 200, await res.text());
    const after = await me(player);
    assert.equal(after.courtSide, "left");
    for (const key of ["dominantHand", "heightCm", "weightKg", "username", "gender", "areaLocation", "level"]) {
      assert.deepEqual(after[key], before[key], `${key} changed`);
    }
  });

  await t.test("heightCm 260 is rejected with nothing changed", async () => {
    const before = await me(player);
    const res = await player.postJson(PATH, { heightCm: 260, courtSide: "right" });
    assert.equal(res.status, 400);
    const after = await me(player);
    assert.equal(after.heightCm, before.heightCm);
    assert.equal(after.courtSide, before.courtSide);
  });

  await t.test("invalid hand and empty body are rejected", async () => {
    assert.equal((await player.postJson(PATH, { dominantHand: "both" })).status, 400);
    assert.equal((await player.postJson(PATH, {})).status, 400);
    assert.equal((await player.postJson(PATH, { weightKg: 20 })).status, 400);
  });

  await t.test("weightKg 84.82 is stored as 84.8", async () => {
    const res = await player.postJson(PATH, { weightKg: 84.82, dominantHand: "left" });
    assert.equal(res.status, 200, await res.text());
    const after = await me(player);
    assert.equal(after.weightKg, 84.8);
    assert.equal(after.dominantHand, "left");
    assert.equal(after.heightCm, 170);
  });

  await t.test("no session gives 401", async () => {
    const anon = new E2EClient();
    const res = await anon.postJson(PATH, { courtSide: "left" });
    assert.equal(res.status, 401);
  });
});
