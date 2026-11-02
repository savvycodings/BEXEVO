// Backend E2E flow for follows: a fresh player follows a fresh coach (granted through the admin
// hub), follows twice, unfollows, is rejected for non-coach / unknown / self targets, follows a
// country in lowercase, and finally the player's user row is deleted to check the coach's
// follower count drops (follows cascade with the follower).
//
// Run: `pnpm dev:e2e` in one terminal, then in another:
//   DATABASE_URL=<the server's DATABASE_URL> pnpm exec tsx --test src/e2e/follows.flow.e2e.ts
// The last step deletes a user row directly, so it only runs when this process's DATABASE_URL
// points at the same host the running server reports from /__e2e/health (fakes mode).

import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import { E2EClient, E2E_BASE_URL } from "./lib/http";
import { signUpFreshE2EUser } from "./lib/testUser";

const ADMIN_HUB_GATE_PASSWORD = process.env.ADMIN_HUB_GATE_PASSWORD || "xevodev";

async function userId(client: E2EClient): Promise<string> {
  const { body } = await client.getJson("/api/auth/get-session");
  assert.ok(body?.user?.id, "no session user");
  return body.user.id;
}

async function call(client: E2EClient, method: string, path: string) {
  const res = await client.request(path, { method });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function grantCoach(admin: E2EClient, targetUserId: string) {
  const res = await admin.request("/api/auth/profile/admin-grant-coach", {
    method: "POST",
    headers: { "content-type": "application/json", "x-xevo-admin-hub-password": ADMIN_HUB_GATE_PASSWORD },
    body: JSON.stringify({ targetUserId }),
  });
  assert.equal(res.status, 200, `grant coach failed: ${await res.text()}`);
}

test("follows: follow / twice / unfollow / bad targets / country / follower deleted", async (t) => {
  const player = await signUpFreshE2EUser("follow-player");
  const coach = await signUpFreshE2EUser("follow-coach");
  const other = await signUpFreshE2EUser("follow-other");
  const playerId = await userId(player);
  const coachId = await userId(coach);
  const otherId = await userId(other);
  await grantCoach(player, coachId);

  await t.test("not signed in is 401", async () => {
    const anon = new E2EClient();
    assert.equal((await call(anon, "GET", "/api/auth/follows/me")).status, 401);
    assert.equal((await call(anon, "PUT", `/api/auth/follows/coach/${coachId}`)).status, 401);
  });

  await t.test("follow a coach", async () => {
    const before = await call(player, "GET", `/api/auth/follows/coach/${coachId}`);
    assert.deepEqual(before.body, { following: false, followerCount: 0 });
    const r = await call(player, "PUT", `/api/auth/follows/coach/${coachId}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { following: true, followerCount: 1 });
  });

  await t.test("follow twice keeps one follow", async () => {
    const r = await call(player, "PUT", `/api/auth/follows/coach/${coachId}`);
    assert.deepEqual(r.body, { following: true, followerCount: 1 });
    const me = await call(player, "GET", "/api/auth/follows/me");
    assert.deepEqual(me.body.coaches, [coachId]);
  });

  await t.test("unfollow", async () => {
    const r = await call(player, "DELETE", `/api/auth/follows/coach/${coachId}`);
    assert.deepEqual(r.body, { following: false, followerCount: 0 });
    const again = await call(player, "DELETE", `/api/auth/follows/coach/${coachId}`);
    assert.deepEqual(again.body, { following: false, followerCount: 0 });
  });

  await t.test("target is not a coach -> 400", async () => {
    assert.equal((await call(player, "PUT", `/api/auth/follows/coach/${otherId}`)).status, 400);
    const me = await call(player, "GET", "/api/auth/follows/me");
    assert.ok(!me.body.coaches.includes(otherId));
  });

  await t.test("unknown coach -> 404", async () => {
    assert.equal((await call(player, "PUT", "/api/auth/follows/coach/no-such-user-id")).status, 404);
  });

  await t.test("follow yourself -> 400", async () => {
    assert.equal((await call(coach, "PUT", `/api/auth/follows/coach/${coachId}`)).status, 400);
  });

  await t.test("bad targets -> 400", async () => {
    assert.equal((await call(player, "PUT", "/api/auth/follows/club/abc")).status, 400);
    assert.equal((await call(player, "PUT", "/api/auth/follows/country/Spain")).status, 400);
    assert.equal((await call(player, "PUT", "/api/auth/follows/country/E1")).status, 400);
  });

  await t.test("country in lowercase is stored uppercase", async () => {
    const r = await call(player, "PUT", "/api/auth/follows/country/es");
    assert.equal(r.status, 200);
    assert.equal(r.body.following, true);
    assert.equal((await call(player, "GET", "/api/auth/follows/country/ES")).body.following, true);
    assert.equal((await call(player, "GET", "/api/auth/follows/country/es")).body.following, true);
    const me = await call(player, "GET", "/api/auth/follows/me");
    assert.deepEqual(me.body.countries, ["ES"]);
  });

  await t.test("deleting the follower's user row lowers the coach's count", async (st) => {
    const health = await fetch(`${E2E_BASE_URL}/__e2e/health`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const localUrl = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;
    if (!health?.fakes || !localUrl || health.dbEndpoint !== localUrl.hostname) {
      st.skip("server is not in fakes mode on this process's DATABASE_URL host");
      return;
    }
    const { db, user } = await import("../db");
    const { eq } = await import("drizzle-orm");

    // A followed coach whose account is deleted drops out of the follower's list.
    const gone = await signUpFreshE2EUser("follow-gone-coach");
    const goneId = await userId(gone);
    await grantCoach(other, goneId);
    assert.equal((await call(other, "PUT", `/api/auth/follows/coach/${goneId}`)).status, 200);
    await db.delete(user).where(eq(user.id, goneId));
    assert.ok(!(await call(other, "GET", "/api/auth/follows/me")).body.coaches.includes(goneId));

    await call(player, "PUT", `/api/auth/follows/coach/${coachId}`);
    assert.equal((await call(other, "GET", `/api/auth/follows/coach/${coachId}`)).body.followerCount, 1);
    await db.delete(user).where(eq(user.id, playerId));
    assert.equal((await call(other, "GET", `/api/auth/follows/coach/${coachId}`)).body.followerCount, 0);
  });
});
