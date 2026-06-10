import { and, desc, eq, gt, inArray } from "drizzle-orm";
import {
  coachStudent,
  db,
  techniqueAnalysis,
  user,
  userGamification,
  userProfile,
} from "../db";
import { storedAiScoreToPercent } from "../technique/techniqueScoreScale";

export type LeaderboardScope = "global" | "country" | "city" | "friends";

export type LeaderboardEntry = {
  rank: number;
  userId: string;
  name: string;
  image: string | null;
  areaLocation: string | null;
  totalXp: number;
  overallScore: number | null;
};

function parseAreaLocation(area: string | null | undefined): {
  city: string;
  country: string;
} {
  if (!area) return { city: "", country: "" };
  const parts = area.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return { city: parts[0], country: parts.slice(1).join(", ") };
  }
  return { city: parts[0] ?? "", country: "" };
}

async function friendUserIds(userId: string): Promise<string[]> {
  const links = await db.query.coachStudent.findMany({
    where: (row, { or, eq: _eq }) =>
      or(_eq(row.coachUserId, userId), _eq(row.studentUserId, userId)),
  });
  const ids = new Set<string>([userId]);
  for (const link of links) {
    ids.add(link.coachUserId);
    ids.add(link.studentUserId);
  }
  return Array.from(ids);
}

async function averageScoresForUsers(
  userIds: string[]
): Promise<Map<string, number>> {
  if (userIds.length === 0) return new Map();

  const rows = await db
    .select({
      userId: techniqueAnalysis.userId,
      metrics: techniqueAnalysis.metrics,
      status: techniqueAnalysis.status,
    })
    .from(techniqueAnalysis)
    .where(
      and(
        inArray(techniqueAnalysis.userId, userIds),
        eq(techniqueAnalysis.status, "completed")
      )
    );

  const sums = new Map<string, { total: number; count: number }>();
  for (const row of rows) {
    const ai = (row.metrics as Record<string, unknown> | null | undefined)
      ?.ai_analysis as Record<string, unknown> | undefined;
    const score = storedAiScoreToPercent(ai);
    if (score == null) continue;
    const prev = sums.get(row.userId) ?? { total: 0, count: 0 };
    prev.total += score;
    prev.count += 1;
    sums.set(row.userId, prev);
  }

  const out = new Map<string, number>();
  for (const [id, { total, count }] of sums) {
    if (count > 0) out.set(id, Math.round(total / count));
  }
  return out;
}

export async function getXpLeaderboard(
  requesterId: string,
  scope: LeaderboardScope,
  limit = 50
): Promise<LeaderboardEntry[]> {
  const requesterProfile = await db.query.userProfile.findFirst({
    where: (p, { eq: _eq }) => _eq(p.userId, requesterId),
  });
  const requesterLoc = parseAreaLocation(requesterProfile?.areaLocation);

  let friendIds: string[] | null = null;
  if (scope === "friends") {
    friendIds = await friendUserIds(requesterId);
    if (friendIds.length === 0) return [];
  }

  const baseRows = await db
    .select({
      userId: user.id,
      totalXp: userGamification.totalXp,
      name: user.name,
      image: user.image,
      areaLocation: userProfile.areaLocation,
    })
    .from(userGamification)
    .innerJoin(user, eq(user.id, userGamification.userId))
    .leftJoin(userProfile, eq(userProfile.userId, user.id))
    .where(gt(userGamification.totalXp, 0))
    .orderBy(
      desc(userGamification.totalXp),
      desc(userGamification.updatedAt),
      desc(user.name)
    );

  const filtered = baseRows.filter((row) => {
    if (friendIds && !friendIds.includes(row.userId)) return false;
    const loc = parseAreaLocation(row.areaLocation);
    if (scope === "country") {
      if (!requesterLoc.country) return true;
      if (!loc.country) return false;
      return (
        loc.country.localeCompare(requesterLoc.country, undefined, {
          sensitivity: "accent",
        }) === 0
      );
    }
    if (scope === "city") {
      if (!requesterLoc.city) return true;
      if (!loc.city) return false;
      return (
        loc.city.localeCompare(requesterLoc.city, undefined, {
          sensitivity: "accent",
        }) === 0
      );
    }
    return true;
  });

  const top = filtered.slice(0, limit);
  const scoreByUser = await averageScoresForUsers(top.map((r) => r.userId));

  return top.map((row, index) => ({
    rank: index + 1,
    userId: row.userId,
    name: row.name,
    image: row.image,
    areaLocation: row.areaLocation,
    totalXp: Number(row.totalXp) || 0,
    overallScore: scoreByUser.get(row.userId) ?? null,
  }));
}
