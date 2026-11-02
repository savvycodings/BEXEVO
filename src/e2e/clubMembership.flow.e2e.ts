// Backend E2E flow for club memberships over real HTTP with real sessions: invites, join
// requests, cross-acceptance, main-club promotion, removal, the 403/404/409 cases, member
// counts and the notifications each step should (or shouldn't) write.
//
// Run: start the server (`pnpm dev:e2e` or `pnpm run dev`), then `pnpm run test:e2e`.
// Env: E2E_BASE_URL (default http://localhost:3050), ADMIN_HUB_GATE_PASSWORD (must match the
// server's; defaults to "xevodev").

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import { E2EClient } from "./lib/http";

const ADMIN_HUB_GATE_PASSWORD = process.env.ADMIN_HUB_GATE_PASSWORD || "xevodev";

type Player = { client: E2EClient; id: string; email: string };

async function freshPlayer(label: string): Promise<Player> {
  const client = new E2EClient();
  const suffix = randomUUID().slice(0, 8);
  const email = `e2e-${label}-${suffix}@xevo.test`;
  const password = "E2E-test-password-1!";
  const up = await client.postJson("/api/auth/sign-up/email", { email, password, name: `E2E ${label} ${suffix}` });
  assert.ok(up.ok, `sign-up failed: ${await up.text()}`);
  const inn = await client.postJson("/api/auth/sign-in/email", { email, password });
  assert.ok(inn.ok, `sign-in failed: ${await inn.text()}`);
  const s = await client.getJson("/api/auth/get-session");
  return { client, id: s.body.user.id, email };
}

async function call(client: E2EClient, method: string, path: string, body?: unknown) {
  const res = await client.request(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, text };
}

async function createApprovedClub(owner: Player, name: string, approve = true) {
  const r = await call(owner.client, "POST", "/api/auth/club", {
    name: `${name} ${Date.now()}`,
    address: "1 Test Rd",
    city: "Miami",
    country: "USA",
  });
  assert.equal(r.status, 201, r.text);
  const club = r.body.club;
  if (approve) {
    const res = await owner.client.request(`/club/admin/${club.id}/approve`, {
      method: "POST",
      headers: { "x-xevo-admin-hub-password": ADMIN_HUB_GATE_PASSWORD },
    });
    assert.equal(res.status, 200, await res.text());
  }
  return club as { id: string; slug: string; name: string };
}

async function detail(client: E2EClient, slug: string) {
  const r = await client.getJson(`/club/${slug}`);
  assert.equal(r.status, 200);
  return r.body.club;
}

async function notifications(p: Player, kind: string) {
  const r = await p.client.getJson("/profile/notifications");
  assert.equal(r.status, 200);
  return (r.body.notifications as any[]).filter((n) => n.kind === kind);
}

test("club memberships: invites, requests, main club, removal", async (t) => {
  const owner = await freshPlayer("club-owner");
  const ana = await freshPlayer("club-ana");
  const ben = await freshPlayer("club-ben");
  const cam = await freshPlayer("club-cam");
  const stranger = await freshPlayer("club-stranger");

  const x = await createApprovedClub(owner, "E2E Members Club X");
  const y = await createApprovedClub(owner, "E2E Members Club Y");
  const pending = await createApprovedClub(owner, "E2E Pending Club", false);

  await t.test("fresh state: no invites, memberCount 0, myMembership none", async () => {
    const inv = await ana.client.getJson("/club-memberships/invites");
    assert.equal(inv.status, 200);
    assert.deepEqual(inv.body, { invites: [], count: 0 });
    assert.equal((await new E2EClient().getJson("/club-memberships/invites")).status, 401);

    const d = await detail(ana.client, x.slug);
    assert.equal(d.memberCount, 0);
    assert.deepEqual(d.myMembership, { state: "none", id: null, isMain: false });
    const anon = await detail(new E2EClient(), x.slug);
    assert.equal(anon.memberCount, 0);
    assert.equal("myMembership" in anon, false);

    const list = await ana.client.getJson("/club");
    const listed = list.body.clubs.find((c: any) => c.id === x.id);
    assert.equal(listed.memberCount, 0);
  });

  await t.test("owner-only routes: 403 for others, 404 for unknown club, 401 signed out", async () => {
    assert.equal((await stranger.client.getJson(`/api/auth/club/mine/${x.id}/members`)).status, 403);
    assert.equal(
      (await call(stranger.client, "POST", `/api/auth/club/mine/${x.id}/invites`, { email: ana.email })).status,
      403
    );
    assert.equal((await owner.client.getJson(`/api/auth/club/mine/nope-404/members`)).status, 404);
    assert.equal((await new E2EClient().getJson(`/api/auth/club/mine/${x.id}/members`)).status, 401);
    const ok = await owner.client.getJson(`/api/auth/club/mine/${x.id}/members`);
    assert.equal(ok.status, 200);
    assert.deepEqual(
      { r: ok.body.requests, i: ok.body.invites, m: ok.body.members },
      { r: [], i: [], m: [] }
    );
  });

  let anaInviteId = "";
  await t.test("owner invites ana by email (case-insensitive); unknown email is 404", async () => {
    const unknown = await call(owner.client, "POST", `/api/auth/club/mine/${x.id}/invites`, {
      email: "nobody-here@xevo.test",
    });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error, "No Axevo player with that email");
    assert.equal(
      (await call(owner.client, "POST", `/api/auth/club/mine/${x.id}/invites`, { email: "not-an-email" })).status,
      400
    );

    const r = await call(owner.client, "POST", `/api/auth/club/mine/${x.id}/invites`, {
      email: `  ${ana.email.toUpperCase()} `,
    });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.state, "invited");
    anaInviteId = r.body.membership.id;

    const again = await call(owner.client, "POST", `/api/auth/club/mine/${x.id}/invites`, { email: ana.email });
    assert.equal(again.status, 200);
    assert.equal(again.body.membership.id, anaInviteId, "re-invite must return the same record");

    const notes = await notifications(ana, "club_invite");
    assert.equal(notes.length, 1, "exactly one club_invite notification");
    assert.equal(notes[0].refType, "club_membership");
    assert.equal(notes[0].refId, anaInviteId);
    assert.match(notes[0].title, /invited you to join/);

    const view = await owner.client.getJson(`/api/auth/club/mine/${x.id}/members`);
    assert.equal(view.body.invites.length, 1);
    assert.equal(view.body.invites[0].invitedEmail, ana.email);
    assert.equal(view.body.invites[0].player.id, ana.id);
    assert.equal("email" in view.body.invites[0].player, false);
  });

  await t.test("ana sees the invite; only ana can accept", async () => {
    const inv = await ana.client.getJson("/club-memberships/invites");
    assert.equal(inv.body.count, 1);
    assert.equal(inv.body.invites[0].id, anaInviteId);
    assert.equal(inv.body.invites[0].club.id, x.id);
    assert.equal(inv.body.invites[0].club.memberCount, 0);
    assert.equal((await detail(ana.client, x.slug)).myMembership.state, "invited");

    assert.equal((await call(ben.client, "POST", `/club-memberships/invites/${anaInviteId}/accept`)).status, 403);
    assert.equal((await call(owner.client, "POST", `/club-memberships/invites/${anaInviteId}/accept`)).status, 403);
    assert.equal((await call(ana.client, "POST", `/club-memberships/invites/nope-404/accept`)).status, 404);

    const r = await call(ana.client, "POST", `/api/auth/club-memberships/invites/${anaInviteId}/accept`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.state, "member");
    assert.equal(r.body.isMain, true, "first club is the main club");
    assert.equal(r.body.memberCount, 1);
    assert.equal((await call(ana.client, "POST", `/club-memberships/invites/${anaInviteId}/accept`)).status, 409);

    const d = await detail(ana.client, x.slug);
    assert.equal(d.memberCount, 1);
    assert.deepEqual(d.myMembership, { state: "member", id: anaInviteId, isMain: true });
    assert.equal((await notifications(ana, "club_join_approved")).length, 0, "accepting writes no notification");
    assert.equal(
      (await call(owner.client, "POST", `/api/auth/club/mine/${x.id}/invites`, { email: ana.email })).status,
      409,
      "inviting a member is a 409"
    );
  });

  let benRequestId = "";
  await t.test("ben asks to join X; owner approves; ben is notified", async () => {
    assert.equal((await call(ben.client, "POST", "/club-memberships/requests", { clubId: pending.id })).status, 409);
    assert.equal((await call(ben.client, "POST", "/club-memberships/requests", { clubId: "nope-404" })).status, 404);

    const r = await call(ben.client, "POST", "/club-memberships/requests", { clubId: x.id });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.state, "requested");
    benRequestId = r.body.membership.id;
    assert.equal((await detail(ben.client, x.slug)).myMembership.state, "requested");
    assert.equal((await detail(ben.client, x.slug)).memberCount, 1, "requests don't count");

    assert.equal(
      (await call(stranger.client, "POST", `/api/auth/club/mine/${x.id}/requests/${benRequestId}/approve`)).status,
      403
    );
    assert.equal(
      (await call(owner.client, "POST", `/api/auth/club/mine/${y.id}/requests/${benRequestId}/approve`)).status,
      404,
      "request belongs to another club"
    );
    const ap = await call(owner.client, "POST", `/api/auth/club/mine/${x.id}/requests/${benRequestId}/approve`);
    assert.equal(ap.status, 200, ap.text);
    assert.equal(ap.body.state, "member");
    assert.equal(
      (await call(owner.client, "POST", `/api/auth/club/mine/${x.id}/requests/${benRequestId}/approve`)).status,
      409
    );

    const notes = await notifications(ben, "club_join_approved");
    assert.equal(notes.length, 1);
    assert.equal(notes[0].refType, "club");
    assert.equal(notes[0].refId, x.slug);
    assert.equal((await detail(ben.client, x.slug)).memberCount, 2);
  });

  await t.test("cam: request meets invite (cross-acceptance) and invite meets request", async () => {
    // Invite first, then cam asks to join: accepted, no notification for the request side.
    const inv = await call(owner.client, "POST", `/api/auth/club/mine/${x.id}/invites`, { email: cam.email });
    assert.equal(inv.status, 201);
    const req = await call(cam.client, "POST", "/club-memberships/requests", { clubId: x.id });
    assert.equal(req.status, 200, req.text);
    assert.equal(req.body.state, "member");
    assert.equal(req.body.membership.id, inv.body.membership.id, "the invite row became the membership");
    assert.equal((await notifications(cam, "club_join_approved")).length, 0);
    assert.equal((await detail(cam.client, x.slug)).memberCount, 3);

    // Cam asks Y first, then the owner invites: accepted, and counts as an approval.
    const r2 = await call(cam.client, "POST", "/club-memberships/requests", { clubId: y.id });
    assert.equal(r2.body.state, "requested");
    const inv2 = await call(owner.client, "POST", `/api/auth/club/mine/${y.id}/invites`, { email: cam.email });
    assert.equal(inv2.status, 200, inv2.text);
    assert.equal(inv2.body.state, "member");
    const approved = await notifications(cam, "club_join_approved");
    assert.equal(approved.length, 1);
    assert.equal(approved[0].refId, y.slug);
  });

  await t.test("decline and cancel delete records; no notifications", async () => {
    const z = await createApprovedClub(owner, "E2E Members Club Z");
    const inv = await call(owner.client, "POST", `/api/auth/club/mine/${z.id}/invites`, { email: stranger.email });
    const invId = inv.body.membership.id;
    assert.equal((await call(stranger.client, "POST", `/club-memberships/invites/${invId}/decline`)).status, 200);
    assert.equal((await stranger.client.getJson("/club-memberships/invites")).body.count, 0);
    // Can be invited again later, then the owner cancels it.
    const inv2 = await call(owner.client, "POST", `/api/auth/club/mine/${z.id}/invites`, { email: stranger.email });
    assert.equal(inv2.status, 201);
    assert.notEqual(inv2.body.membership.id, invId);
    assert.equal(
      (await call(stranger.client, "DELETE", `/api/auth/club/mine/${z.id}/invites/${inv2.body.membership.id}`)).status,
      403
    );
    assert.equal(
      (await call(owner.client, "DELETE", `/api/auth/club/mine/${z.id}/invites/${inv2.body.membership.id}`)).status,
      200
    );
    assert.equal(
      (await call(stranger.client, "POST", `/club-memberships/invites/${inv2.body.membership.id}/accept`)).status,
      404
    );

    const rq = await call(stranger.client, "POST", "/club-memberships/requests", { clubId: z.id });
    assert.equal((await call(ben.client, "DELETE", `/club-memberships/requests/${rq.body.membership.id}`)).status, 403);
    assert.equal((await call(stranger.client, "DELETE", `/club-memberships/requests/${rq.body.membership.id}`)).status, 200);
    const rq2 = await call(stranger.client, "POST", "/club-memberships/requests", { clubId: z.id });
    assert.equal(
      (await call(owner.client, "POST", `/api/auth/club/mine/${z.id}/requests/${rq2.body.membership.id}/decline`)).status,
      200
    );
    assert.equal((await detail(stranger.client, z.slug)).myMembership.state, "none");
    assert.equal((await notifications(stranger, "club_join_approved")).length, 0);
  });

  await t.test("owner joining their own club is accepted right away", async () => {
    const r = await call(owner.client, "POST", "/club-memberships/requests", { clubId: y.id });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.state, "member");
    assert.equal((await notifications(owner, "club_join_approved")).length, 0);
  });

  await t.test("main club: set, list order, and promotion on leave", async () => {
    // Ana: X (main). Join Y, then a third club W.
    const w = await createApprovedClub(owner, "E2E Members Club W");
    for (const c of [y, w]) {
      const inv = await call(owner.client, "POST", `/api/auth/club/mine/${c.id}/invites`, { email: ana.email });
      const acc = await call(ana.client, "POST", `/club-memberships/invites/${inv.body.membership.id}/accept`);
      assert.equal(acc.body.isMain, false);
    }
    let mine = await ana.client.getJson("/club-memberships/mine");
    assert.deepEqual(
      mine.body.clubs.map((c: any) => [c.id, c.isMain]),
      [
        [x.id, true],
        [y.id, false],
        [w.id, false],
      ]
    );

    // Make W main, then Y; only one main at a time.
    assert.equal((await call(ana.client, "POST", `/club-memberships/clubs/${w.id}/main`)).body.isMain, true);
    mine = await ana.client.getJson("/club-memberships/mine");
    assert.equal(mine.body.clubs[0].id, w.id);
    assert.equal(mine.body.clubs.filter((c: any) => c.isMain).length, 1);
    assert.equal((await detail(ana.client, x.slug)).myMembership.isMain, false);
    assert.equal((await call(ana.client, "POST", `/club-memberships/clubs/${pending.id}/main`)).status, 404);

    // Leaving main W promotes the earliest joined of the rest: X.
    const leave = await call(ana.client, "DELETE", `/club-memberships/clubs/${w.id}`);
    assert.equal(leave.status, 200, leave.text);
    assert.equal(leave.body.state, "none");
    mine = await ana.client.getJson("/club-memberships/mine");
    assert.deepEqual(
      mine.body.clubs.map((c: any) => [c.id, c.isMain]),
      [
        [x.id, true],
        [y.id, false],
      ]
    );
    assert.equal((await call(ana.client, "DELETE", `/club-memberships/clubs/${w.id}`)).status, 404);

    // Others can read ana's clubs by id.
    const other = await ben.client.getJson(`/club-memberships/users/${ana.id}`);
    assert.equal(other.body.clubs[0].id, x.id);
    assert.equal(other.body.clubs[0].isMain, true);
  });

  await t.test("owner removes a member; count drops; no notification", async () => {
    const before = (await detail(owner.client, x.slug)).memberCount;
    const view = await owner.client.getJson(`/api/auth/club/mine/${x.id}/members`);
    const benRow = view.body.members.find((m: any) => m.player.id === ben.id);
    assert.ok(benRow);
    for (const m of view.body.members) assert.equal("email" in m.player, false);
    for (const m of view.body.members) assert.equal("invitedEmail" in m, false);

    assert.equal((await call(ana.client, "DELETE", `/api/auth/club/mine/${x.id}/members/${benRow.id}`)).status, 403);
    const r = await call(owner.client, "DELETE", `/api/auth/club/mine/${x.id}/members/${benRow.id}`);
    assert.equal(r.status, 200, r.text);
    assert.equal((await call(owner.client, "DELETE", `/api/auth/club/mine/${x.id}/members/${benRow.id}`)).status, 404);
    assert.equal((await detail(owner.client, x.slug)).memberCount, before - 1);
    assert.equal((await ben.client.getJson("/club-memberships/mine")).body.clubs.length, 0);
    assert.equal((await notifications(ben, "club_join_approved")).length, 1, "still only the approval note");

    const mineClubs = await owner.client.getJson("/api/auth/club/mine");
    assert.equal(mineClubs.body.clubs.find((c: any) => c.id === x.id).memberCount, before - 1);
  });
});
