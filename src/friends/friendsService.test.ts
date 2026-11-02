// Friends service tests against a real Postgres. They need a disposable database with the
// current schema: TEST_DATABASE_URL if set, otherwise the local e2e database from .env.e2e
// (`pnpm db:e2e`). They never fall back to .env, and they skip when the database is unreachable
// or has no `friendship` table yet. Each test creates its own users and deletes them after.
import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { parse } from "dotenv";
import { Client } from "pg";

function testDbUrl(): string | null {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  const file = path.join(process.cwd(), ".env.e2e");
  if (!fs.existsSync(file)) return null;
  const url = parse(fs.readFileSync(file)).DATABASE_URL;
  if (!url) return null;
  const host = new URL(url).hostname;
  return host === "localhost" || host === "127.0.0.1" ? url : null;
}

async function dbReady(url: string): Promise<boolean> {
  const c = new Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  try {
    await c.connect();
    const r = await c.query("select to_regclass('public.friendship') as t");
    return r.rows[0]?.t != null;
  } catch {
    return false;
  } finally {
    await c.end().catch(() => {});
  }
}

describe("friendsService", async () => {
  const url = testDbUrl();
  const ready = url ? await dbReady(url) : false;
  if (!ready) {
    test("friendsService (needs a test database with a friendship table)", { skip: true }, () => {});
    return;
  }
  process.env.DATABASE_URL = url!;
  type Svc = typeof import("./friendsService");
  type Db = typeof import("../db");
  let svc: Svc;
  let dbm: Db;
  const created: string[] = [];

  async function makeUser(name: string, areaLocation?: string): Promise<string> {
    const id = `t-${randomUUID()}`;
    await dbm.db.insert(dbm.user).values({ id, name, email: `${id}@friends.test` });
    if (areaLocation) await dbm.db.insert(dbm.userProfile).values({ userId: id, areaLocation });
    created.push(id);
    return id;
  }

  async function befriend(a: string, b: string) {
    const { request } = await svc.sendRequest(a, b);
    await svc.accept(request.id, b);
  }

  async function notifications(userId: string) {
    return dbm.db.query.userNotification.findMany({ where: (n, { eq }) => eq(n.userId, userId) });
  }

  async function expectStatus(p: Promise<unknown>, status: number) {
    await assert.rejects(p, (e: unknown) => e instanceof svc.FriendsError && e.status === status);
  }

  before(async () => {
    svc = await import("./friendsService");
    dbm = await import("../db");
  });

  after(async () => {
    const { inArray } = await import("drizzle-orm");
    if (created.length) await dbm.db.delete(dbm.user).where(inArray(dbm.user.id, created));
    await dbm.pool.end();
  });

  describe("sendRequest", () => {
    test("creates a pending request", async () => {
      const a = await makeUser("A");
      const b = await makeUser("B");
      const r = await svc.sendRequest(a, b);
      assert.equal(r.status, "pending");
      assert.equal(r.request.requesterUserId, a);
      assert.equal(r.request.addresseeUserId, b);
    });

    test("rejects yourself with 400 and an unknown user with 404", async () => {
      const a = await makeUser("A");
      await expectStatus(svc.sendRequest(a, a), 400);
      await expectStatus(svc.sendRequest(a, `missing-${randomUUID()}`), 404);
      assert.equal((await svc.relationship(a, a)).status, "none");
    });

    test("returns the existing pending request on a duplicate", async () => {
      const a = await makeUser("A");
      const b = await makeUser("B");
      const first = await svc.sendRequest(a, b);
      const second = await svc.sendRequest(a, b);
      assert.equal(second.status, "pending");
      assert.equal(second.request.id, first.request.id);
      assert.equal((await svc.listIncoming(b)).count, 1);
    });

    test("accepts the reverse pending request", async () => {
      const a = await makeUser("A");
      const b = await makeUser("B");
      const theirs = await svc.sendRequest(b, a);
      const r = await svc.sendRequest(a, b);
      assert.equal(r.status, "accepted");
      assert.equal(r.request.id, theirs.request.id);
      assert.deepEqual(await svc.acceptedFriendIds(a), [b]);
      assert.deepEqual(await svc.acceptedFriendIds(b), [a]);
    });
  });

  describe("accept / decline / cancel", () => {
    test("accept makes both players friends", async () => {
      const a = await makeUser("A");
      const b = await makeUser("B");
      const { request } = await svc.sendRequest(a, b);
      const row = await svc.accept(request.id, b);
      assert.equal(row.status, "accepted");
      assert.ok(row.respondedAt);
      assert.deepEqual(await svc.acceptedFriendIds(a), [b]);
      assert.deepEqual((await svc.listFriends(b)).map((f) => f.id), [a]);
    });

    test("decline deletes the request and the sender can ask again", async () => {
      const a = await makeUser("A");
      const b = await makeUser("B");
      const { request } = await svc.sendRequest(a, b);
      await svc.decline(request.id, b);
      assert.equal((await svc.listIncoming(b)).count, 0);
      assert.equal((await svc.relationship(a, b)).status, "none");
      assert.deepEqual(await svc.acceptedFriendIds(a), []);
      const again = await svc.sendRequest(a, b);
      assert.equal(again.status, "pending");
      assert.notEqual(again.request.id, request.id);
    });

    test("cancel deletes the request", async () => {
      const a = await makeUser("A");
      const b = await makeUser("B");
      const { request } = await svc.sendRequest(a, b);
      await svc.cancel(request.id, a);
      assert.equal((await svc.relationship(b, a)).status, "none");
    });

    test("the wrong user gets 403 and the request is unchanged", async () => {
      const a = await makeUser("A");
      const b = await makeUser("B");
      const c = await makeUser("C");
      const { request } = await svc.sendRequest(a, b);
      await expectStatus(svc.accept(request.id, a), 403);
      await expectStatus(svc.accept(request.id, c), 403);
      await expectStatus(svc.decline(request.id, a), 403);
      await expectStatus(svc.cancel(request.id, b), 403);
      const rel = await svc.relationship(b, a);
      assert.equal(rel.status, "incoming_pending");
      assert.equal(rel.requestId, request.id);
    });

    test("acting on a request that is gone gives 404", async () => {
      const a = await makeUser("A");
      const b = await makeUser("B");
      const { request } = await svc.sendRequest(a, b);
      await svc.decline(request.id, b);
      await expectStatus(svc.accept(request.id, b), 404);
    });
  });

  describe("unfriend", () => {
    test("removes the friendship on both sides and allows a new request", async () => {
      const a = await makeUser("A");
      const b = await makeUser("B");
      await befriend(a, b);
      assert.equal(await svc.unfriend(b, a), true);
      assert.deepEqual(await svc.acceptedFriendIds(a), []);
      assert.deepEqual(await svc.acceptedFriendIds(b), []);
      assert.equal(await svc.unfriend(a, b), false);
      assert.equal((await svc.sendRequest(a, b)).status, "pending");
    });
  });

  describe("relationship", () => {
    test("reports each status from the viewer's side", async () => {
      const a = await makeUser("A");
      const b = await makeUser("B");
      assert.equal((await svc.relationship(a, b)).status, "none");
      const { request } = await svc.sendRequest(a, b);
      assert.deepEqual(await svc.relationship(a, b), { status: "outgoing_pending", requestId: request.id });
      assert.deepEqual(await svc.relationship(b, a), { status: "incoming_pending", requestId: request.id });
      await svc.accept(request.id, b);
      assert.equal((await svc.relationship(a, b)).status, "friends");
      assert.equal((await svc.relationship(b, a)).status, "friends");
    });
  });

  describe("mutualFriends", () => {
    test("counts shared accepted friends and ignores coach links and pending requests", async () => {
      const a = await makeUser("A");
      const b = await makeUser("B");
      const [c, d, e, f] = await Promise.all(["C", "D", "E", "F"].map((n) => makeUser(n)));
      for (const x of [c, d, e]) {
        await befriend(a, x);
        await befriend(x, b);
      }
      // F coaches both A and B: a shared coach link is not a mutual friend.
      await dbm.db.insert(dbm.coachStudent).values([
        { id: randomUUID(), coachUserId: f, studentUserId: a },
        { id: randomUUID(), coachUserId: f, studentUserId: b },
      ]);
      // A pending request doesn't count either.
      const g = await makeUser("G");
      await befriend(a, g);
      await svc.sendRequest(g, b);

      const m = await svc.mutualFriends(a, b);
      assert.equal(m.count, 3);
      assert.deepEqual(m.friends.map((x) => x.id).sort(), [c, d, e].sort());
      assert.deepEqual(await svc.mutualFriends(a, f), { count: 0, friends: [] });
    });

    test("caps the preview at 3 and batches several players", async () => {
      const a = await makeUser("A");
      const b = await makeUser("B");
      const c = await makeUser("C");
      const shared = await Promise.all(["M1", "M2", "M3", "M4"].map((n) => makeUser(n)));
      for (const x of shared) {
        await befriend(a, x);
        await befriend(b, x);
      }
      await befriend(c, shared[0]);
      const batch = await svc.mutualFriendsBatch(a, [b, c]);
      assert.equal(batch.get(b)?.count, 4);
      assert.equal(batch.get(b)?.friends.length, 3);
      assert.equal(batch.get(c)?.count, 1);
    });
  });

  describe("listIncoming", () => {
    test("returns pending requests newest first with sender details and a count", async () => {
      const b = await makeUser("B");
      const a = await makeUser("Alice", "Madrid, España");
      const c = await makeUser("Carl");
      const older = await svc.sendRequest(a, b);
      await dbm.db
        .update(dbm.friendship)
        .set({ createdAt: new Date(Date.now() - 24 * 3600 * 1000) })
        .where((await import("drizzle-orm")).eq(dbm.friendship.id, older.request.id));
      await svc.sendRequest(c, b);
      // An outgoing request from B isn't incoming.
      await svc.sendRequest(b, await makeUser("Z"));

      const list = await svc.listIncoming(b);
      assert.equal(list.count, 2);
      assert.deepEqual(list.requests.map((r) => r.sender.id), [c, a]);
      const alice = list.requests[1].sender;
      assert.equal(alice.name, "Alice");
      assert.equal(alice.areaLocation, "Madrid, España");
      assert.equal(alice.country, "España");
      assert.deepEqual(list.requests[1].mutual, { count: 0, friends: [] });
      assert.equal(await svc.incomingCount(b), 2);
    });
  });

  describe("notifications", () => {
    test("request and accept notify; decline and cancel don't", async () => {
      const a = await makeUser("Ann");
      const b = await makeUser("Bob");
      const { request } = await svc.sendRequest(a, b);
      const forB = await notifications(b);
      assert.equal(forB.length, 1);
      assert.equal(forB[0].kind, "friend_request");
      assert.equal(forB[0].refType, "friendship");
      assert.equal(forB[0].refId, request.id);
      assert.match(forB[0].title, /Ann/);

      await svc.accept(request.id, b);
      const forA = await notifications(a);
      assert.equal(forA.length, 1);
      assert.equal(forA[0].kind, "friend_request_accepted");
      assert.equal(forA[0].refType, "user");
      assert.equal(forA[0].refId, b);

      const c = await makeUser("Cy");
      const d = await makeUser("Di");
      const r1 = await svc.sendRequest(c, d);
      await svc.decline(r1.request.id, d);
      const r2 = await svc.sendRequest(c, d);
      await svc.cancel(r2.request.id, c);
      assert.equal((await notifications(c)).length, 0);
      // D got one notification per request received, nothing for the decline or cancel.
      assert.equal((await notifications(d)).length, 2);
    });
  });

  describe("requestDetail", () => {
    test("returns the sender profile to the addressee only, while pending", async () => {
      const a = await makeUser("Dave", "Madrid, España");
      const b = await makeUser("B");
      const { eq } = await import("drizzle-orm");
      await dbm.db
        .update(dbm.userProfile)
        .set({ level: "intermediate", courtSide: "right" })
        .where(eq(dbm.userProfile.userId, a));
      const { request } = await svc.sendRequest(a, b);
      const d = await svc.requestDetail(request.id, b);
      assert.equal(d.sender.name, "Dave");
      assert.equal(d.sender.level, "intermediate");
      assert.equal(d.sender.courtSide, "right");
      assert.equal(d.sender.about, null);
      assert.equal(d.sender.overallScore, null);
      await expectStatus(svc.requestDetail(request.id, a), 404);
      await svc.accept(request.id, b);
      await expectStatus(svc.requestDetail(request.id, b), 404);
    });
  });

  describe("leaderboard Friends scope", () => {
    test("includes an accepted friend with XP", async () => {
      const { getXpLeaderboard, friendUserIds } = await import("../gamification/leaderboard");
      const a = await makeUser("A");
      const f = await makeUser("F");
      const stranger = await makeUser("S");
      await dbm.db.insert(dbm.userGamification).values([
        { userId: f, totalXp: 120 },
        { userId: stranger, totalXp: 999 },
      ]);
      assert.ok(!(await friendUserIds(a)).includes(f));
      await befriend(a, f);
      assert.ok((await friendUserIds(a)).includes(f));
      const board = await getXpLeaderboard(a, "friends");
      assert.deepEqual(board.map((r) => r.userId), [f]);
    });
  });
});
