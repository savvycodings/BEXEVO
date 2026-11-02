// Backend E2E flow for the Friends-tab Rating ranking over real HTTP with real sessions:
// World (order, unrated last, search keeps rank, friends-only recount), Country (the 3-player
// rule, search), the country page (stats, clubs, pending club ignored, 404) and the Club scope
// (member vs no club). Analyses and locations are seeded straight into the database, so the
// whole flow only runs when this process's DATABASE_URL is the fakes-mode server's database:
//   DATABASE_URL=<the server's DATABASE_URL> E2E_BASE_URL=http://localhost:3061 \
//     pnpm exec tsx --test src/e2e/ranking.flow.e2e.ts
// Every user it creates is deleted at the end (their clubs and analyses go with them).

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import { E2EClient, E2E_BASE_URL } from "./lib/http";

const ADMIN_HUB_GATE_PASSWORD = process.env.ADMIN_HUB_GATE_PASSWORD || "xevodev";
const RUN = randomUUID().slice(0, 6);

type Player = { client: E2EClient; id: string; email: string; name: string };

async function call(client: E2EClient, method: string, path: string, body?: unknown) {
  const res = await client.request(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, text };
}

async function serverUsesOurDb(): Promise<boolean> {
  const health = await fetch(`${E2E_BASE_URL}/__e2e/health`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  const url = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;
  return !!health?.fakes && !!url && health.dbEndpoint === url.hostname;
}

test("ranking: world, country, country page, club", async (t) => {
  if (!(await serverUsesOurDb())) {
    t.skip("server is not in fakes mode on this process's DATABASE_URL host");
    return;
  }
  const { db, user, userProfile, userGamification } = await import("../db");
  const { inArray } = await import("drizzle-orm");
  const { seedCompletedAnalysis } = await import("./lib/achievementSeed");

  const created: string[] = [];
  t.after(async () => {
    if (created.length) await db.delete(user).where(inArray(user.id, created));
  });

  async function freshPlayer(label: string, opts: { location?: string; scores?: number[]; xp?: number } = {}) {
    const client = new E2EClient();
    const slug = label.normalize("NFD").replace(/[^A-Za-z0-9]+/g, "").toLowerCase();
    const email = `e2e-rank-${slug}-${RUN}@xevo.test`;
    const name = `Rank ${label} ${RUN}`;
    const password = "E2E-test-password-1!";
    const up = await client.postJson("/api/auth/sign-up/email", { email, password, name });
    assert.ok(up.ok, `sign-up failed: ${await up.text()}`);
    const inn = await client.postJson("/api/auth/sign-in/email", { email, password });
    assert.ok(inn.ok, `sign-in failed: ${await inn.text()}`);
    const id = (await client.getJson("/api/auth/get-session")).body.user.id as string;
    created.push(id);
    if (opts.location) {
      await db
        .insert(userProfile)
        .values({ userId: id, areaLocation: opts.location })
        .onConflictDoUpdate({ target: userProfile.userId, set: { areaLocation: opts.location } });
    }
    if (opts.xp) await db.insert(userGamification).values({ userId: id, totalXp: opts.xp });
    for (const s of opts.scores ?? []) await seedCompletedAnalysis(id, s);
    return { client, id, email, name } as Player;
  }

  // Tuvalu: 3 rated players + 1 unrated. Nauru: 2 rated players (not ranked as a country).
  const tv1 = await freshPlayer("Tiva", { location: "Funafuti, Tuvalu", scores: [90, 92] });
  const tv2 = await freshPlayer("Tomás Ruíz", { location: "Funafuti, TV", scores: [80], xp: 500 });
  const tv3 = await freshPlayer("Teo", { location: "Vaitupu, tuvalu", scores: [70] });
  const tvUnrated = await freshPlayer("Tunrated", { location: "Funafuti, Tuvalu", xp: 9999 });
  await freshPlayer("Nara", { location: "Yaren, Nauru", scores: [99] });
  await freshPlayer("Nori", { location: "Nauru", scores: [97] });
  const me = tv3;

  await t.test("needs a session", async () => {
    const anon = new E2EClient();
    assert.equal((await anon.getJson("/profile/gamification/ranking/players")).status, 401);
    assert.equal((await anon.getJson("/api/auth/profile/gamification/ranking/countries")).status, 401);
    assert.equal((await anon.getJson("/profile/gamification/ranking/countries/ES")).status, 401);
  });

  await t.test("world: rated by Rating, unrated after every rated player", async () => {
    for (const base of ["/profile/gamification", "/api/auth/profile/gamification"]) {
      const r = await me.client.getJson(`${base}/ranking/players?scope=nonsense`);
      assert.equal(r.status, 200);
      assert.equal(r.body.scope, "world");
      assert.equal(r.body.club, null);
      const entries = r.body.entries as any[];
      assert.ok(entries.length <= 100);
      assert.deepEqual(entries.map((e) => e.rank), entries.map((_, i) => i + 1));
      const firstUnrated = entries.findIndex((e) => e.rating == null);
      if (firstUnrated >= 0) assert.ok(entries.slice(firstUnrated).every((e) => e.rating == null));
      const ours = entries.filter((e) => [tv1.id, tv2.id, tv3.id].includes(e.userId));
      assert.deepEqual(ours.map((e) => e.userId), [tv1.id, tv2.id, tv3.id]);
      const top = ours[0];
      assert.equal(top.rating, 91);
      assert.equal(top.countryCode, "TV");
      assert.equal(top.countryName, "Tuvalu");
      assert.equal(top.city, "Funafuti");
      assert.deepEqual(Object.keys(top).sort(), [
        "city",
        "countryCode",
        "countryName",
        "image",
        "name",
        "rank",
        "rating",
        "totalXp",
        "userId",
      ]);
    }
  });

  await t.test("world search ignores accents and keeps the real rank", async () => {
    const all = (await me.client.getJson("/profile/gamification/ranking/players")).body.entries as any[];
    const realRank = all.find((e) => e.userId === tv2.id)?.rank;
    const r = await me.client.getJson(`/profile/gamification/ranking/players?q=${encodeURIComponent(`tomas ruiz ${RUN}`)}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.entries.length, 1);
    assert.equal(r.body.entries[0].userId, tv2.id);
    if (realRank) assert.equal(r.body.entries[0].rank, realRank);
    const none = await me.client.getJson(`/profile/gamification/ranking/players?q=zz-no-one-${RUN}`);
    assert.deepEqual(none.body.entries, []);
    const unrated = await me.client.getJson(`/profile/gamification/ranking/players?q=${encodeURIComponent(`Tunrated ${RUN}`)}`);
    assert.equal(unrated.body.entries[0].userId, tvUnrated.id);
    assert.equal(unrated.body.entries[0].rating, null);
  });

  await t.test("friends only: me and my friends, ranked from 1", async () => {
    const req = await call(me.client, "POST", "/friends/requests", { toUserId: tv1.id });
    assert.equal(req.status, 201, req.text);
    const acc = await call(tv1.client, "POST", `/friends/requests/${req.body.request.id}/accept`);
    assert.equal(acc.status, 200, acc.text);
    const r = await me.client.getJson("/profile/gamification/ranking/players?scope=world&friendsOnly=1");
    assert.deepEqual(
      r.body.entries.map((e: any) => [e.rank, e.userId]),
      [
        [1, tv1.id],
        [2, me.id],
      ]
    );
  });

  let ranked: any[] = [];
  await t.test("countries: only countries with 3+ rated players", async () => {
    const r = await me.client.getJson("/profile/gamification/ranking/countries");
    assert.equal(r.status, 200);
    ranked = r.body.entries;
    const tv = ranked.find((c) => c.code === "TV");
    assert.ok(tv, "Tuvalu should be ranked");
    assert.equal(tv.name, "Tuvalu");
    assert.equal(tv.rating, 80); // (91 + 80 + 70) / 3
    assert.equal(tv.playerCount, 3);
    assert.equal(ranked.find((c) => c.code === "NR"), undefined, "Nauru has only 2 rated players");
    const s = await me.client.getJson("/api/auth/profile/gamification/ranking/countries?q=tuv");
    assert.deepEqual(s.body.entries, [tv]);
  });

  await t.test("country page: stats, players, clubs (pending ignored), top cities", async () => {
    const owner = tvUnrated;
    const mk = async (name: string, country: string, approve: boolean) => {
      const r = await call(owner.client, "POST", "/api/auth/club", {
        name: `${name} ${RUN}`,
        address: "1 Test Rd",
        city: "Funafuti",
        country,
      });
      assert.equal(r.status, 201, r.text);
      if (approve) {
        const a = await owner.client.request(`/club/admin/${r.body.club.id}/approve`, {
          method: "POST",
          headers: { "x-xevo-admin-hub-password": ADMIN_HUB_GATE_PASSWORD },
        });
        assert.equal(a.status, 200, await a.text());
      }
      return r.body.club as { id: string; slug: string; name: string };
    };
    const b = await mk("Bravo Padel", "TV", true);
    const a = await mk("Alpha Padel", "tuvalu", true);
    await mk("Pending Padel", "Tuvalu", false);

    const r = await me.client.getJson("/profile/gamification/ranking/countries/tv");
    assert.equal(r.status, 200);
    const tvRank = ranked.find((c) => c.code === "TV").rank;
    assert.deepEqual(r.body.country, {
      code: "TV",
      name: "Tuvalu",
      rank: tvRank,
      totalCountries: ranked.length,
      playerCount: 3,
      averageRating: 80,
      clubCount: 2,
    });
    assert.deepEqual(r.body.topPlayers.map((p: any) => [p.rank, p.userId]), [
      [1, tv1.id],
      [2, tv2.id],
      [3, tv3.id],
    ]);
    assert.deepEqual(r.body.clubs.map((c: any) => c.id), [a.id, b.id]);
    assert.deepEqual(Object.keys(r.body.clubs[0]).sort(), ["city", "id", "logoImageUrl", "name", "slug"]);
    assert.deepEqual(r.body.topCities, [
      { city: "Funafuti", playerCount: 2 },
      { city: "Vaitupu", playerCount: 1 },
    ]);

    const nr = await me.client.getJson("/api/auth/profile/gamification/ranking/countries/NR");
    assert.equal(nr.status, 200);
    assert.equal(nr.body.country.rank, null);
    assert.equal(nr.body.country.playerCount, 2);
    assert.equal(nr.body.country.averageRating, 98);

    assert.equal((await me.client.getJson("/profile/gamification/ranking/countries/ZZ")).status, 404);
    assert.equal((await me.client.getJson("/api/auth/profile/gamification/ranking/countries/ZZ")).status, 404);
  });

  await t.test("club scope: member sees club members; no club gets an empty list", async () => {
    const before = await tv2.client.getJson("/profile/gamification/ranking/players?scope=club");
    assert.equal(before.status, 200);
    assert.deepEqual(before.body, { scope: "club", club: null, entries: [] });

    const owner = await freshPlayer("Owner", { scores: [60] });
    const r = await call(owner.client, "POST", "/api/auth/club", {
      name: `Rank Club ${RUN}`,
      address: "1 Test Rd",
      city: "Funafuti",
      country: "Tuvalu",
    });
    assert.equal(r.status, 201, r.text);
    const club = r.body.club;
    const ok = await owner.client.request(`/club/admin/${club.id}/approve`, {
      method: "POST",
      headers: { "x-xevo-admin-hub-password": ADMIN_HUB_GATE_PASSWORD },
    });
    assert.equal(ok.status, 200);
    for (const p of [tv2, tvUnrated]) {
      const inv = await call(owner.client, "POST", `/api/auth/club/mine/${club.id}/invites`, { email: p.email });
      assert.equal(inv.status, 201, inv.text);
      const acc = await call(p.client, "POST", `/club-memberships/invites/${inv.body.membership.id}/accept`);
      assert.equal(acc.status, 200, acc.text);
    }

    const after = await tv2.client.getJson("/profile/gamification/ranking/players?scope=club");
    assert.equal(after.status, 200);
    assert.deepEqual(after.body.club, { id: club.id, slug: club.slug, name: club.name });
    assert.deepEqual(
      after.body.entries.map((e: any) => [e.rank, e.userId, e.rating]),
      [
        [1, tv2.id, 80],
        [2, tvUnrated.id, null],
      ]
    );
    // Friends only inside the club: tv2 has no friends there, so only tv2.
    const fo = await tv2.client.getJson("/profile/gamification/ranking/players?scope=club&friendsOnly=true");
    assert.deepEqual(fo.body.entries.map((e: any) => e.userId), [tv2.id]);

    // The requester with no club still gets the empty contract.
    const none = await tv1.client.getJson("/api/auth/profile/gamification/ranking/players?scope=club");
    assert.deepEqual(none.body, { scope: "club", club: null, entries: [] });
  });
});
