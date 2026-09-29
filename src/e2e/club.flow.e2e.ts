// Backend E2E flow: a club-owner account submits a club, adds a court and amenities, uploads a
// banner, an axevo admin approves it, and the club becomes publicly visible — the full path
// "the endpoints, the CRUD" was built for.
//
// Run: start the server (`pnpm run dev`) in one terminal, then in another:
//   pnpm run test:e2e
//
// Env: E2E_BASE_URL (default http://localhost:3050), ADMIN_HUB_GATE_PASSWORD (must match
// whatever the running server has configured — defaults to "xevodev" in both, same as the
// existing admin-grant-coach flow).

import test from "node:test";
import assert from "node:assert/strict";
import { E2EClient } from "./lib/http";
import { signUpFreshE2EUser } from "./lib/testUser";

const ADMIN_HUB_GATE_PASSWORD = process.env.ADMIN_HUB_GATE_PASSWORD || "xevodev";

async function postJsonOk(client: E2EClient, path: string, body: unknown) {
  const res = await client.postJson(path, body);
  const text = await res.text();
  assert.equal(res.status < 300, true, `POST ${path} failed (${res.status}): ${text}`);
  return JSON.parse(text);
}

test("club: submit -> courts -> amenities -> admin approve -> publicly visible", async (t) => {
  const owner = await signUpFreshE2EUser("club-owner");

  let clubId = "";
  let slug = "";
  await t.test("club owner creates a club (starts pending)", async () => {
    const body = await postJsonOk(owner, "/api/auth/club", {
      name: `E2E Test Padel Club ${Date.now()}`,
      address: "123 Test Court Rd, Miami, FL",
      city: "Miami",
      country: "USA",
      phone: "+1 555-000-0000",
      hoursText: "Open 9am-9pm",
    });
    assert.equal(body.club.status, "pending");
    assert.ok(body.club.id);
    assert.ok(body.club.slug);
    clubId = body.club.id;
    slug = body.club.slug;
  });

  await t.test("pending club is not publicly visible", async () => {
    const { status } = await owner.getJson(`/api/auth/club/${slug}`);
    assert.equal(status, 404);
    const { body: listBody } = await owner.getJson("/api/auth/club");
    assert.ok(
      !listBody.clubs.some((c: any) => c.id === clubId),
      "pending club leaked into the public list"
    );
  });

  await t.test("club owner adds a court", async () => {
    const body = await postJsonOk(owner, `/api/auth/club/mine/${clubId}/courts`, {
      name: "Court 1",
      indoorOutdoor: "outdoor",
      hasLighting: true,
    });
    assert.equal(body.court.name, "Court 1");
    assert.equal(body.court.indoorOutdoor, "outdoor");
  });

  await t.test("club owner sets amenities", async () => {
    const res = await owner.request(`/api/auth/club/mine/${clubId}/amenities`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keys: ["parking", "showers", "wifi"] }),
    });
    const text = await res.text();
    assert.equal(res.status, 200, `PUT amenities failed: ${text}`);
    const body = JSON.parse(text);
    assert.deepEqual([...body.amenityKeys].sort(), ["parking", "showers", "wifi"]);
  });

  await t.test("amenities reject an unknown key", async () => {
    const res = await owner.request(`/api/auth/club/mine/${clubId}/amenities`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keys: ["not_a_real_amenity"] }),
    });
    assert.equal(res.status, 400);
  });

  await t.test("club owner's own club shows courts + amenities while still pending", async () => {
    const { status, body } = await owner.getJson(`/api/auth/club/mine/${clubId}`);
    assert.equal(status, 200);
    assert.equal(body.club.courts.length, 1);
    assert.deepEqual([...body.club.amenityKeys].sort(), ["parking", "showers", "wifi"]);
  });

  await t.test("admin endpoints reject a missing/invalid password", async () => {
    const res = await owner.request("/api/auth/club/admin/pending", {
      headers: { "x-xevo-admin-hub-password": "wrong" },
    });
    assert.equal(res.status, 403);
  });

  await t.test("club shows up in the admin pending queue", async () => {
    const res = await owner.request("/api/auth/club/admin/pending", {
      headers: { "x-xevo-admin-hub-password": ADMIN_HUB_GATE_PASSWORD },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.clubs.some((c: any) => c.id === clubId), "club missing from admin pending queue");
  });

  await t.test("admin approves the club", async () => {
    const res = await owner.request(`/api/auth/club/admin/${clubId}/approve`, {
      method: "POST",
      headers: { "x-xevo-admin-hub-password": ADMIN_HUB_GATE_PASSWORD },
    });
    assert.equal(res.status, 200, `approve failed: ${await res.text()}`);
  });

  await t.test("approved club is now publicly visible with courts + amenities", async () => {
    const { status, body } = await owner.getJson(`/api/auth/club/${slug}`);
    assert.equal(status, 200);
    assert.equal(body.club.status, "approved");
    assert.equal(body.club.courts.length, 1);
    assert.deepEqual([...body.club.amenityKeys].sort(), ["parking", "showers", "wifi"]);

    const { body: listBody } = await owner.getJson("/api/auth/club");
    assert.ok(listBody.clubs.some((c: any) => c.id === clubId), "approved club missing from public list");
  });

  await t.test("a stranger cannot edit someone else's club", async () => {
    const stranger = await signUpFreshE2EUser("club-stranger");
    const res = await stranger.request(`/api/auth/club/mine/${clubId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Hijacked Name" }),
    });
    assert.equal(res.status, 404);
  });
});
