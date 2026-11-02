// ranking.ts imports ../db, which needs DATABASE_URL at module load (the pool connects lazily,
// so these pure tests never touch a database).
import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import {
  averageRatings,
  buildCountryDetail,
  buildPlayerRanking,
  locationParts,
  rankCountries,
  rankPlayers,
  searchCountries,
  searchRanked,
  type ClubCountryRow,
  type RatedPlayer,
} from "./ranking";

let seq = 0;
function player(p: Partial<RatedPlayer> & { name: string }): RatedPlayer {
  seq += 1;
  return {
    userId: p.userId ?? `u${String(seq).padStart(4, "0")}`,
    image: null,
    city: "",
    countryCode: "",
    countryName: "",
    rating: null,
    totalXp: 0,
    ...p,
  };
}

const ES = { countryCode: "ES", countryName: "Spain" };
const MX = { countryCode: "MX", countryName: "Mexico" };
const PE = { countryCode: "PE", countryName: "Peru" };

test("rankPlayers orders by Rating, unrated players last", () => {
  const a = player({ name: "A", rating: 70 });
  const b = player({ name: "B", rating: 90 });
  const c = player({ name: "C", rating: null, totalXp: 5000 });
  const ranked = rankPlayers([c, a, b]);
  assert.deepEqual(ranked.map((p) => p.name), ["B", "A", "C"]);
  assert.deepEqual(ranked.map((p) => p.rank), [1, 2, 3]);
  assert.equal(ranked[2].rating, null);
});

test("rankPlayers breaks a Rating tie by XP, then name", () => {
  const a = player({ name: "Zed", rating: 85, totalXp: 1200 });
  const b = player({ name: "Amy", rating: 85, totalXp: 900 });
  const c = player({ name: "Bob", rating: 85, totalXp: 900 });
  assert.deepEqual(rankPlayers([b, c, a]).map((p) => p.name), ["Zed", "Amy", "Bob"]);
});

test("unrated players are ordered by XP then name", () => {
  const ranked = rankPlayers([
    player({ name: "Low", totalXp: 10 }),
    player({ name: "High", totalXp: 500 }),
    player({ name: "Rated", rating: 1 }),
  ]);
  assert.deepEqual(ranked.map((p) => p.name), ["Rated", "High", "Low"]);
});

test("searchRanked keeps the real rank and ignores accents and case", () => {
  const list = rankPlayers([
    player({ name: "Top Player", rating: 99 }),
    player({ name: "Other", rating: 95 }),
    player({ name: "Alejandro Ruíz", rating: 50 }),
  ]);
  const hits = searchRanked(list, "ruiz");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].name, "Alejandro Ruíz");
  assert.equal(hits[0].rank, 3);
});

test("blank search returns the unsearched list", () => {
  const list = rankPlayers([player({ name: "A", rating: 1 }), player({ name: "B", rating: 2 })]);
  assert.equal(searchRanked(list, "   "), list);
  assert.equal(searchRanked(list, null), list);
});

test("rankCountries leaves out countries with fewer than 3 rated players", () => {
  const players = [
    player({ name: "e1", rating: 90, ...ES }),
    player({ name: "e2", rating: 85, ...ES }),
    player({ name: "e3", rating: 80, ...ES }),
    player({ name: "m1", rating: 60, ...MX }),
    player({ name: "m2", rating: 70, ...MX }),
    player({ name: "m3", rating: 80, ...MX }),
    player({ name: "p1", rating: 95, ...PE }),
    player({ name: "p2", rating: 95, ...PE }),
    player({ name: "unrated", rating: null, totalXp: 999, ...PE }),
  ];
  const countries = rankCountries(players);
  assert.deepEqual(countries, [
    { rank: 1, code: "ES", name: "Spain", rating: 85, playerCount: 3 },
    { rank: 2, code: "MX", name: "Mexico", rating: 70, playerCount: 3 },
  ]);
  assert.deepEqual(searchCountries(countries, "mex"), [countries[1]]);
  assert.deepEqual(searchCountries(countries, "ES").map((c) => c.code), ["ES"]);
});

test("averageRatings averages percent scores and converts legacy 0–10 scores", () => {
  const out = averageRatings([
    { userId: "a", score: 80, scoreScale: "percent", scoreModelRaw: null },
    { userId: "a", score: 85, scoreScale: "percent", scoreModelRaw: null },
    { userId: "a", score: 90, scoreScale: "percent", scoreModelRaw: null },
    { userId: "b", score: 7.2, scoreScale: null, scoreModelRaw: null },
    { userId: "c", score: null, scoreScale: "percent", scoreModelRaw: null },
  ]);
  assert.equal(out.get("a"), 85);
  assert.equal(out.get("b"), 72);
  assert.equal(out.has("c"), false);
});

test("locationParts reads country and city", () => {
  assert.deepEqual(locationParts("Barcelona, Spain"), { city: "Barcelona", countryCode: "ES", countryName: "Spain" });
  assert.deepEqual(locationParts("ES"), { city: "", countryCode: "ES", countryName: "Spain" });
  assert.deepEqual(locationParts("Springfield"), { city: "Springfield", countryCode: "", countryName: "" });
  assert.deepEqual(locationParts("Somewhere, Atlantis"), { city: "Somewhere", countryCode: "", countryName: "" });
  assert.deepEqual(locationParts(null), { city: "", countryCode: "", countryName: "" });
});

test("friends-only filters before ranking, so ranks are recounted from 1", () => {
  const me = player({ name: "Me", rating: 60 });
  const friends = [70, 65, 55, 50].map((r, i) => player({ name: `F${i}`, rating: r }));
  const strangers = [99, 98, 97].map((r, i) => player({ name: `S${i}`, rating: r }));
  const only = new Set([me, ...friends].map((p) => p.userId));
  const out = buildPlayerRanking([...strangers, me, ...friends], { onlyUserIds: only });
  assert.equal(out.length, 5);
  assert.deepEqual(out.map((p) => p.rank), [1, 2, 3, 4, 5]);
  assert.ok(out.every((p) => only.has(p.userId)));
});

test("player ranking caps at 100 entries and searches at 50", () => {
  const many = Array.from({ length: 250 }, (_, i) => player({ name: `Player ${i}`, rating: i % 100 }));
  const out = buildPlayerRanking(many, {});
  assert.equal(out.length, 100);
  assert.equal(out[99].rank, 100);
  const found = buildPlayerRanking(many, { q: "player" });
  assert.equal(found.length, 50);
  assert.equal(found[0].rank, 1);
  // A player far below the first page is still found with their real rank.
  const last = buildPlayerRanking([...many, player({ name: "Alejandro Ruíz", rating: null, totalXp: 0 })], { q: "ruiz" });
  assert.equal(last.length, 1);
  assert.equal(last[0].rank, 251);
});

function clubRow(p: Partial<ClubCountryRow> & { name: string }): ClubCountryRow {
  return {
    id: p.id ?? `club-${p.name}`,
    slug: p.slug ?? p.name.toLowerCase().replace(/\s+/g, "-"),
    city: null,
    logoImageUrl: null,
    country: "Spain",
    status: "approved",
    ...p,
  };
}

test("country detail: ranked country with players, clubs and top cities", () => {
  const players = [
    player({ name: "e1", rating: 90, city: "Madrid", ...ES }),
    player({ name: "e2", rating: 85, city: "Barcelona", ...ES }),
    player({ name: "e3", rating: 80, city: "Madrid", ...ES }),
    player({ name: "e4", rating: 70, city: "Valencia", ...ES }),
    player({ name: "e5", rating: 60, city: "Sevilla", ...ES }),
    player({ name: "eu", rating: null, totalXp: 500, city: "Madrid", ...ES }),
    ...[70, 70, 70].map((r, i) => player({ name: `m${i}`, rating: r, ...MX })),
  ];
  const clubs = [
    clubRow({ name: "Zeta Padel", country: "ES" }),
    clubRow({ name: "Alfa Padel", country: "spain" }),
    clubRow({ name: "Pending Padel", status: "pending" }),
    clubRow({ name: "Rejected Padel", status: "rejected" }),
    clubRow({ name: "Mexico Padel", country: "Mexico" }),
    clubRow({ name: "Nowhere Padel", country: "Atlantis" }),
  ];
  const d = buildCountryDetail("es", players, clubs);
  assert.ok(d);
  assert.deepEqual(d.country, {
    code: "ES",
    name: "Spain",
    rank: 1,
    totalCountries: 2,
    playerCount: 5,
    averageRating: 77,
    clubCount: 2,
  });
  assert.deepEqual(d.clubs.map((c) => c.name), ["Alfa Padel", "Zeta Padel"]);
  assert.deepEqual(d.topPlayers.map((p) => [p.rank, p.name]), [
    [1, "e1"],
    [2, "e2"],
    [3, "e3"],
    [4, "e4"],
    [5, "e5"],
  ]);
  assert.deepEqual(d.topCities, [
    { city: "Madrid", playerCount: 2 },
    { city: "Barcelona", playerCount: 1 },
    { city: "Sevilla", playerCount: 1 },
  ]);
});

test("country detail: clubs but no rated players", () => {
  const d = buildCountryDetail("PT", [player({ name: "x", rating: null, totalXp: 50, countryCode: "PT", countryName: "Portugal" })], [
    clubRow({ name: "Lisboa Padel", country: "Portugal" }),
    clubRow({ name: "Porto Pending", country: "PT", status: "pending" }),
  ]);
  assert.ok(d);
  assert.equal(d.country.rank, null);
  assert.equal(d.country.averageRating, null);
  assert.equal(d.country.playerCount, 0);
  assert.equal(d.country.clubCount, 1);
  assert.deepEqual(d.topPlayers, []);
  assert.deepEqual(d.clubs.map((c) => c.name), ["Lisboa Padel"]);
});

test("country detail: a country with fewer than 3 rated players has no rank but an average", () => {
  const d = buildCountryDetail("PE", [player({ name: "p1", rating: 95, ...PE }), player({ name: "p2", rating: 90, ...PE })], []);
  assert.ok(d);
  assert.equal(d.country.rank, null);
  assert.equal(d.country.averageRating, 93);
  assert.equal(d.country.playerCount, 2);
});

test("country detail: unknown code returns null", () => {
  assert.equal(buildCountryDetail("ZZ", [], []), null);
});
