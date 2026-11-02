/**
 * Rating ranking for the Friends tab (World / Club players, countries, country page).
 *
 * Rating = the player's overall technique score: the average of their completed analyses'
 * scores on 0–100 (the same number `getXpLeaderboard` returns as `overallScore`). Players are
 * ranked by Rating; unrated players follow every rated player. The XP leaderboard in
 * leaderboard.ts is a separate code path and is left alone.
 */
import { and, eq, gt, inArray, or, sql } from "drizzle-orm";
import { club, db, techniqueAnalysis, user, userGamification, userProfile } from "../db";
import { storedAiScoreToPercent } from "../technique/techniqueScoreScale";
import { countryByCode, resolveCountry } from "../lib/countryRegistry";
import { clubMemberUserIds, mainClubIdForUser } from "../club/clubMembership";
import { friendUserIds, parseAreaLocation } from "./leaderboard";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RatedPlayer = {
  userId: string;
  name: string;
  image: string | null;
  city: string;
  countryCode: string;
  countryName: string;
  /** null = no completed analysis with a score yet. */
  rating: number | null;
  totalXp: number;
};

export type RankedPlayer = RatedPlayer & { rank: number };

export type RankedCountry = {
  rank: number;
  code: string;
  name: string;
  rating: number;
  playerCount: number;
};

export type RankingScope = "world" | "club";

export type ClubRef = { id: string; slug: string; name: string };

export type CountryClub = {
  id: string;
  slug: string;
  name: string;
  city: string | null;
  logoImageUrl: string | null;
};

/** A club row as read for country matching; only approved clubs count. */
export type ClubCountryRow = CountryClub & { country: string | null; status: string };

export type CountryDetail = {
  country: {
    code: string;
    name: string;
    rank: number | null;
    totalCountries: number;
    playerCount: number;
    averageRating: number | null;
    clubCount: number;
  };
  topPlayers: RankedPlayer[];
  clubs: CountryClub[];
  topCities: Array<{ city: string; playerCount: number }>;
};

export const MIN_PLAYERS_PER_COUNTRY = 3;
export const MAX_ENTRIES = 100;
export const MAX_SEARCH_RESULTS = 50;
// Fakes-mode (e2e) servers skip the cache so seeded rows show up at once.
const CACHE_TTL_MS = process.env.XEVO_E2E_FAKES === "1" ? 0 : 60_000;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Lowercase and strip accents, so "Ruíz" matches "ruiz". */
export function normalizeSearch(text: string | null | undefined): string {
  return String(text ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

function byName(a: string, b: string): number {
  return a.localeCompare(b, "en", { sensitivity: "base" });
}

/** Rating desc, XP desc, name A–Z, user id; unrated players after all rated ones (XP desc, name). */
export function comparePlayers(a: RatedPlayer, b: RatedPlayer): number {
  const aRated = a.rating != null;
  const bRated = b.rating != null;
  if (aRated !== bRated) return aRated ? -1 : 1;
  if (aRated && bRated && a.rating !== b.rating) return (b.rating as number) - (a.rating as number);
  if (a.totalXp !== b.totalXp) return b.totalXp - a.totalXp;
  return byName(a.name, b.name) || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0);
}

/** Sorts by the ranking order and gives distinct ranks from 1. */
export function rankPlayers(list: RatedPlayer[]): RankedPlayer[] {
  return [...list].sort(comparePlayers).map((p, i) => ({ ...p, rank: i + 1 }));
}

/**
 * Name search over an already ranked list: matches keep their rank. Blank text returns the list
 * unchanged (the caller caps it).
 */
export function searchRanked<T extends { name: string }>(
  ranked: T[],
  q: string | null | undefined,
  limit = MAX_SEARCH_RESULTS
): T[] {
  const needle = normalizeSearch(q);
  if (!needle) return ranked;
  return ranked.filter((p) => normalizeSearch(p.name).includes(needle)).slice(0, limit);
}

/** Countries with at least 3 rated players, ranked by average Rating, player count, then name. */
export function rankCountries(players: RatedPlayer[]): RankedCountry[] {
  const groups = new Map<string, { name: string; total: number; count: number }>();
  for (const p of players) {
    if (p.rating == null || !p.countryCode) continue;
    const g = groups.get(p.countryCode) ?? { name: p.countryName, total: 0, count: 0 };
    g.total += p.rating;
    g.count += 1;
    groups.set(p.countryCode, g);
  }
  return [...groups.entries()]
    .filter(([, g]) => g.count >= MIN_PLAYERS_PER_COUNTRY)
    .map(([code, g]) => ({ code, name: g.name, rating: Math.round(g.total / g.count), playerCount: g.count }))
    .sort((a, b) => b.rating - a.rating || b.playerCount - a.playerCount || byName(a.name, b.name))
    .map((c, i) => ({ rank: i + 1, ...c }));
}

/** Country name/code search that keeps each country's rank. */
export function searchCountries(ranked: RankedCountry[], q: string | null | undefined): RankedCountry[] {
  const needle = normalizeSearch(q);
  if (!needle) return ranked;
  return ranked.filter((c) => normalizeSearch(c.name).includes(needle) || c.code.toLowerCase().includes(needle));
}

/** Score fields of one completed analysis (`metrics.ai_analysis`). */
export type AnalysisScoreRow = {
  userId: string;
  score: unknown;
  scoreScale: unknown;
  scoreModelRaw: unknown;
};

/** Average 0–100 score per user, rounded, using the same conversion as the leaderboard. */
export function averageRatings(rows: AnalysisScoreRow[]): Map<string, number> {
  const sums = new Map<string, { total: number; count: number }>();
  for (const row of rows) {
    const score = storedAiScoreToPercent({
      score: row.score,
      score_scale: row.scoreScale,
      score_model_raw: row.scoreModelRaw,
    });
    if (score == null) continue;
    const prev = sums.get(row.userId) ?? { total: 0, count: 0 };
    prev.total += score;
    prev.count += 1;
    sums.set(row.userId, prev);
  }
  const out = new Map<string, number>();
  for (const [id, { total, count }] of sums) out.set(id, Math.round(total / count));
  return out;
}

/** Country and city from a profile location ("City, Country", "Country" or free text). */
export function locationParts(area: string | null | undefined): {
  city: string;
  countryCode: string;
  countryName: string;
} {
  const country = resolveCountry(area);
  const { city, country: rest } = parseAreaLocation(area);
  // A bare country ("ES", "Spain") has no city part.
  const cityPart = country && !rest ? "" : city;
  return { city: cityPart, countryCode: country?.code ?? "", countryName: country?.name ?? "" };
}

/** Player list for one scope: filters first, then ranks, then searches (search keeps ranks). */
export function buildPlayerRanking(
  players: RatedPlayer[],
  opts: { onlyUserIds?: Set<string> | null; q?: string | null }
): RankedPlayer[] {
  const only = opts.onlyUserIds;
  const ranked = rankPlayers(only ? players.filter((p) => only.has(p.userId)) : players);
  const needle = normalizeSearch(opts.q);
  return needle ? searchRanked(ranked, needle, MAX_SEARCH_RESULTS) : ranked.slice(0, MAX_ENTRIES);
}

/** Country page data from the loaded players and club rows. Null for an unknown code. */
export function buildCountryDetail(
  code: string,
  players: RatedPlayer[],
  clubRows: ClubCountryRow[]
): CountryDetail | null {
  const country = countryByCode(code);
  if (!country) return null;
  const countries = rankCountries(players);
  const ranked = countries.find((c) => c.code === country.code) ?? null;

  const rated = players.filter((p) => p.rating != null && p.countryCode === country.code);
  const topPlayers = rankPlayers(rated).slice(0, MAX_ENTRIES);
  const averageRating = rated.length
    ? Math.round(rated.reduce((s, p) => s + (p.rating as number), 0) / rated.length)
    : null;

  const clubs = clubRows
    .filter((c) => c.status === "approved" && resolveCountry(c.country)?.code === country.code)
    .sort((a, b) => byName(a.name, b.name))
    .map(({ id, slug, name, city, logoImageUrl }) => ({ id, slug, name, city, logoImageUrl }));

  const cityCounts = new Map<string, number>();
  for (const p of rated) {
    if (p.city) cityCounts.set(p.city, (cityCounts.get(p.city) ?? 0) + 1);
  }
  const topCities = [...cityCounts.entries()]
    .map(([city, playerCount]) => ({ city, playerCount }))
    .sort((a, b) => b.playerCount - a.playerCount || byName(a.city, b.city))
    .slice(0, 3);

  return {
    country: {
      code: country.code,
      name: country.name,
      rank: ranked?.rank ?? null,
      totalCountries: countries.length,
      playerCount: rated.length,
      averageRating,
      clubCount: clubs.length,
    },
    topPlayers,
    clubs,
    topCities,
  };
}

// ---------------------------------------------------------------------------
// Database reads
// ---------------------------------------------------------------------------

let cache: { at: number; promise: Promise<RatedPlayer[]> } | null = null;

/** Drops the cached player list (tests, or after seeding). */
export function clearRankingCache(): void {
  cache = null;
}

async function queryRatedPlayers(): Promise<RatedPlayer[]> {
  const scoreRows = await db
    .select({
      userId: techniqueAnalysis.userId,
      score: sql<unknown>`${techniqueAnalysis.metrics}->'ai_analysis'->'score'`,
      scoreScale: sql<unknown>`${techniqueAnalysis.metrics}->'ai_analysis'->'score_scale'`,
      scoreModelRaw: sql<unknown>`${techniqueAnalysis.metrics}->'ai_analysis'->'score_model_raw'`,
    })
    .from(techniqueAnalysis)
    .where(eq(techniqueAnalysis.status, "completed"));
  const ratings = averageRatings(scoreRows);

  const ratedIds = [...ratings.keys()];
  const rows = await db
    .select({
      userId: user.id,
      name: user.name,
      image: user.image,
      areaLocation: userProfile.areaLocation,
      totalXp: userGamification.totalXp,
    })
    .from(user)
    .leftJoin(userGamification, eq(userGamification.userId, user.id))
    .leftJoin(userProfile, eq(userProfile.userId, user.id))
    .where(
      ratedIds.length
        ? or(gt(userGamification.totalXp, 0), inArray(user.id, ratedIds))
        : gt(userGamification.totalXp, 0)
    );

  return rows.map((r) => ({
    userId: r.userId,
    name: r.name,
    image: r.image,
    ...locationParts(r.areaLocation),
    rating: ratings.get(r.userId) ?? null,
    totalXp: Number(r.totalXp) || 0,
  }));
}

/**
 * Every rated player plus unrated players with XP, sorted by the ranking order. Cached in
 * memory for 60 s so switching scopes or searching doesn't re-scan the analysis table.
 */
export async function loadRatedPlayers(): Promise<RatedPlayer[]> {
  const now = Date.now();
  if (!cache || now - cache.at > CACHE_TTL_MS) {
    const promise = queryRatedPlayers().then((list) => list.sort(comparePlayers));
    cache = { at: now, promise };
    promise.catch(() => {
      if (cache?.promise === promise) cache = null;
    });
  }
  return cache.promise;
}

export async function getPlayerRanking(opts: {
  requesterId: string;
  scope: RankingScope;
  friendsOnly?: boolean;
  q?: string | null;
}): Promise<{ scope: RankingScope; club: ClubRef | null; entries: RankedPlayer[] }> {
  let only: Set<string> | null = null;
  let clubRef: ClubRef | null = null;

  if (opts.scope === "club") {
    const clubId = await mainClubIdForUser(opts.requesterId);
    if (!clubId) return { scope: "club", club: null, entries: [] };
    const [row] = await db
      .select({ id: club.id, slug: club.slug, name: club.name })
      .from(club)
      .where(and(eq(club.id, clubId), eq(club.status, "approved")))
      .limit(1);
    if (!row) return { scope: "club", club: null, entries: [] };
    clubRef = row;
    only = new Set(await clubMemberUserIds(clubId));
  }

  if (opts.friendsOnly) {
    const friends = new Set(await friendUserIds(opts.requesterId));
    only = only ? new Set([...only].filter((id) => friends.has(id))) : friends;
  }

  const players = await loadRatedPlayers();
  return { scope: opts.scope, club: clubRef, entries: buildPlayerRanking(players, { onlyUserIds: only, q: opts.q }) };
}

export async function getCountryRanking(q?: string | null): Promise<{ entries: RankedCountry[] }> {
  const countries = rankCountries(await loadRatedPlayers());
  return { entries: searchCountries(countries, q) };
}

export async function getCountryDetail(code: string): Promise<CountryDetail | null> {
  if (!countryByCode(code)) return null;
  const [players, clubRows] = await Promise.all([
    loadRatedPlayers(),
    db
      .select({
        id: club.id,
        slug: club.slug,
        name: club.name,
        city: club.city,
        logoImageUrl: club.logoImageUrl,
        country: club.country,
        status: club.status,
      })
      .from(club)
      .where(eq(club.status, "approved")),
  ]);
  return buildCountryDetail(code, players, clubRows);
}
