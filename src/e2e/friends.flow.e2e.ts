// Backend E2E flow for friendships: send -> incoming -> detail -> accept -> GET /friends ->
// unfriend, plus the permission and duplicate cases, over real HTTP with real sessions.
//
// Run: start the server (`pnpm dev:e2e` or `pnpm run dev`), then `pnpm run test:e2e`.
// Env: E2E_BASE_URL (default http://localhost:3050).

import test from "node:test";
import assert from "node:assert/strict";
import { E2EClient } from "./lib/http";
import { signUpFreshE2EUser } from "./lib/testUser";

async function json(client: E2EClient, method: string, path: string, body?: unknown) {
  const res = await client.request(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, text };
}

async function me(client: E2EClient): Promise<{ id: string; name: string }> {
  const { status, body } = await client.getJson("/api/auth/get-session");
  assert.equal(status, 200);
  return body.user;
}

test("friends: send -> incoming -> detail -> accept -> list -> unfriend", async (t) => {
  const alice = await signUpFreshE2EUser("friends-a");
  const bob = await signUpFreshE2EUser("friends-b");
  const carol = await signUpFreshE2EUser("friends-c");
  const [a, b] = await Promise.all([me(alice), me(bob)]);

  let requestId = "";

  await t.test("rejects a request to yourself and to an unknown user", async () => {
    assert.equal((await json(alice, "POST", "/friends/requests", { toUserId: a.id })).status, 400);
    assert.equal((await json(alice, "POST", "/friends/requests", { toUserId: "nope-404" })).status, 404);
  });

  await t.test("alice sends bob a request", async () => {
    const r = await json(alice, "POST", "/friends/requests", { toUserId: b.id });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.status, "pending");
    requestId = r.body.request.id;
    const dup = await json(alice, "POST", "/api/auth/friends/requests", { toUserId: b.id });
    assert.equal(dup.body.status, "pending");
    assert.equal(dup.body.request.id, requestId);
  });

  await t.test("bob sees it as incoming, with a notification", async () => {
    const { status, body } = await bob.getJson("/friends/requests/incoming");
    assert.equal(status, 200);
    assert.equal(body.count, 1);
    assert.equal(body.requests[0].id, requestId);
    assert.equal(body.requests[0].sender.id, a.id);
    assert.deepEqual(body.requests[0].mutual, { count: 0, friends: [] });

    const rel = await bob.getJson(`/friends/relationship/${a.id}`);
    assert.equal(rel.body.status, "incoming_pending");
    assert.equal(rel.body.requestId, requestId);
    assert.equal((await alice.getJson(`/friends/relationship/${b.id}`)).body.status, "outgoing_pending");

    const notes = await bob.getJson("/profile/notifications");
    const n = notes.body.notifications.find((x: any) => x.kind === "friend_request");
    assert.ok(n, "friend_request notification missing");
    assert.equal(n.refId, requestId);
  });

  await t.test("request detail: addressee only", async () => {
    const d = await bob.getJson(`/friends/requests/${requestId}`);
    assert.equal(d.status, 200);
    assert.equal(d.body.sender.id, a.id);
    assert.ok("overallScore" in d.body.sender);
    assert.ok("level" in d.body.sender);
    assert.deepEqual(d.body.mutual, { count: 0, friends: [] });
    assert.equal((await alice.getJson(`/friends/requests/${requestId}`)).status, 404);
    assert.equal((await carol.getJson(`/friends/requests/${requestId}`)).status, 404);
  });

  await t.test("only bob can accept; only alice can cancel", async () => {
    assert.equal((await json(alice, "POST", `/friends/requests/${requestId}/accept`)).status, 403);
    assert.equal((await json(carol, "POST", `/friends/requests/${requestId}/decline`)).status, 403);
    assert.equal((await json(bob, "DELETE", `/friends/requests/${requestId}`)).status, 403);
  });

  await t.test("bob accepts; both list each other; alice is notified", async () => {
    const r = await json(bob, "POST", `/friends/requests/${requestId}/accept`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.status, "accepted");

    assert.deepEqual((await alice.getJson("/friends")).body.friends.map((f: any) => f.id), [b.id]);
    assert.deepEqual((await bob.getJson("/api/auth/friends")).body.friends.map((f: any) => f.id), [a.id]);
    assert.equal((await bob.getJson("/friends/requests/incoming")).body.count, 0);
    assert.equal((await bob.getJson(`/friends/requests/${requestId}`)).status, 404);

    const notes = await alice.getJson("/profile/notifications");
    const n = notes.body.notifications.find((x: any) => x.kind === "friend_request_accepted");
    assert.ok(n, "friend_request_accepted notification missing");
    assert.equal(n.refType, "user");
    assert.equal(n.refId, b.id);
  });

  await t.test("alice unfriends bob", async () => {
    assert.equal((await json(alice, "DELETE", `/friends/${b.id}`)).status, 200);
    assert.deepEqual((await bob.getJson("/friends")).body.friends, []);
    assert.equal((await bob.getJson(`/friends/relationship/${a.id}`)).body.status, "none");
    assert.equal((await json(alice, "DELETE", `/friends/${b.id}`)).status, 404);
  });

  await t.test("a reverse request accepts the pending one", async () => {
    const first = await json(bob, "POST", "/friends/requests", { toUserId: a.id });
    assert.equal(first.body.status, "pending");
    const second = await json(alice, "POST", "/friends/requests", { toUserId: b.id });
    assert.equal(second.body.status, "accepted");
    assert.equal(second.body.request.id, first.body.request.id);
  });

  await t.test("requires a session", async () => {
    const anon = new E2EClient();
    assert.equal((await anon.getJson("/friends")).status, 401);
  });
});
