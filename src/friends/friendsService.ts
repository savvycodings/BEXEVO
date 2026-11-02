/**
 * Player-to-player friendships: requests, responses, friend lists and mutual friends.
 * Pure database logic; `friendsRouter.ts` exposes it over HTTP.
 *
 * One `friendship` row per pair of players (unique on the unordered pair). A row is a pending
 * request until the addressee accepts it; declining, cancelling and unfriending delete it.
 */
import { randomUUID } from "crypto";
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import {
  coachProfileSection,
  db,
  friendship,
  user,
  userNotification,
  userProfile,
} from "../db";
import { averageScoresForUsers } from "../gamification/leaderboard";

export type FriendshipRow = typeof friendship.$inferSelect;
export type FriendshipStatus = "pending" | "accepted";
export type RelationshipStatus = "none" | "outgoing_pending" | "incoming_pending" | "friends";

export type MutualFriend = { id: string; name: string; image: string | null };
export type MutualFriendsSummary = { count: number; friends: MutualFriend[] };

export class FriendsError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "FriendsError";
  }
}

const MUTUAL_PREVIEW = 3;
const EMPTY_MUTUAL: MutualFriendsSummary = { count: 0, friends: [] };

/** "Madrid, España" -> "España"; the app resolves the flag from the full string. */
export function countryFromAreaLocation(area: string | null | undefined): string | null {
  if (!area) return null;
  const parts = area.split(",").map((s) => s.trim()).filter(Boolean);
  return parts.length >= 2 ? parts.slice(1).join(", ") : null;
}

function pairCondition(a: string, b: string) {
  return or(
    and(eq(friendship.requesterUserId, a), eq(friendship.addresseeUserId, b)),
    and(eq(friendship.requesterUserId, b), eq(friendship.addresseeUserId, a))
  );
}

async function findPair(a: string, b: string): Promise<FriendshipRow | null> {
  const rows = await db.select().from(friendship).where(pairCondition(a, b)).limit(1);
  return rows[0] ?? null;
}

async function findById(id: string): Promise<FriendshipRow | null> {
  const rows = await db.select().from(friendship).where(eq(friendship.id, id)).limit(1);
  return rows[0] ?? null;
}

async function userName(id: string): Promise<string> {
  const rows = await db.select({ name: user.name }).from(user).where(eq(user.id, id)).limit(1);
  return rows[0]?.name?.trim() || "A player";
}

async function notifyRequest(row: FriendshipRow): Promise<void> {
  const name = await userName(row.requesterUserId);
  await db.insert(userNotification).values({
    id: randomUUID(),
    userId: row.addresseeUserId,
    kind: "friend_request",
    title: `${name} sent you a friend request`,
    body: null,
    refType: "friendship",
    refId: row.id,
  });
}

async function notifyAccepted(row: FriendshipRow): Promise<void> {
  const name = await userName(row.addresseeUserId);
  await db.insert(userNotification).values({
    id: randomUUID(),
    userId: row.requesterUserId,
    kind: "friend_request_accepted",
    title: `${name} accepted your friend request`,
    body: null,
    refType: "user",
    refId: row.addresseeUserId,
  });
}

/** Marks a pending row accepted and notifies the requester. */
async function acceptRow(row: FriendshipRow): Promise<FriendshipRow> {
  const [updated] = await db
    .update(friendship)
    .set({ status: "accepted", respondedAt: new Date() })
    .where(and(eq(friendship.id, row.id), eq(friendship.status, "pending")))
    .returning();
  if (!updated) {
    // Someone else changed it in between (accepted twice, or deleted).
    const fresh = await findById(row.id);
    if (fresh?.status === "accepted") return fresh;
    throw new FriendsError(404, "Request not found");
  }
  await notifyAccepted(updated);
  return updated;
}

function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string } } | null;
  return err?.code === "23505" || err?.cause?.code === "23505";
}

/**
 * Sends a request from `fromUserId` to `toUserId`.
 * - self -> 400, unknown user -> 404
 * - an existing pending request from the same sender, or a friendship, is returned as is
 * - a pending request the other way is accepted instead
 */
export async function sendRequest(
  fromUserId: string,
  toUserId: string
): Promise<{ request: FriendshipRow; status: FriendshipStatus }> {
  const to = String(toUserId || "").trim();
  if (!to) throw new FriendsError(400, "Missing toUserId");
  if (to === fromUserId) throw new FriendsError(400, "You can't send a friend request to yourself");

  const target = await db.select({ id: user.id }).from(user).where(eq(user.id, to)).limit(1);
  if (target.length === 0) throw new FriendsError(404, "User not found");

  const existing = await findPair(fromUserId, to);
  if (existing) {
    if (existing.status === "accepted") return { request: existing, status: "accepted" };
    if (existing.requesterUserId === fromUserId) return { request: existing, status: "pending" };
    // They already asked us: treat this as accepting their request.
    const accepted = await acceptRow(existing);
    return { request: accepted, status: "accepted" };
  }

  try {
    const [created] = await db
      .insert(friendship)
      .values({
        id: randomUUID(),
        requesterUserId: fromUserId,
        addresseeUserId: to,
        status: "pending",
      })
      .returning();
    await notifyRequest(created);
    return { request: created, status: "pending" };
  } catch (e) {
    // Lost a race with a concurrent request for the same pair: resolve against the winner.
    if (!isUniqueViolation(e)) throw e;
    const winner = await findPair(fromUserId, to);
    if (!winner) throw e;
    if (winner.status === "accepted" || winner.requesterUserId === fromUserId) {
      return { request: winner, status: winner.status as FriendshipStatus };
    }
    const accepted = await acceptRow(winner);
    return { request: accepted, status: "accepted" };
  }
}

async function pendingForAction(requestId: string): Promise<FriendshipRow> {
  const row = await findById(requestId);
  if (!row || row.status !== "pending") throw new FriendsError(404, "Request not found");
  return row;
}

/** Only the addressee can accept. */
export async function accept(requestId: string, actorUserId: string): Promise<FriendshipRow> {
  const row = await pendingForAction(requestId);
  if (row.addresseeUserId !== actorUserId) throw new FriendsError(403, "Only the recipient can accept");
  return acceptRow(row);
}

/** Only the addressee can decline. Deletes the row; the sender isn't told. */
export async function decline(requestId: string, actorUserId: string): Promise<void> {
  const row = await pendingForAction(requestId);
  if (row.addresseeUserId !== actorUserId) throw new FriendsError(403, "Only the recipient can decline");
  await db.delete(friendship).where(and(eq(friendship.id, row.id), eq(friendship.status, "pending")));
}

/** Only the requester can cancel. Deletes the row. */
export async function cancel(requestId: string, actorUserId: string): Promise<void> {
  const row = await pendingForAction(requestId);
  if (row.requesterUserId !== actorUserId) throw new FriendsError(403, "Only the sender can cancel");
  await db.delete(friendship).where(and(eq(friendship.id, row.id), eq(friendship.status, "pending")));
}

/** Ends a friendship from either side. Returns false when they weren't friends. */
export async function unfriend(userId: string, otherUserId: string): Promise<boolean> {
  const deleted = await db
    .delete(friendship)
    .where(and(pairCondition(userId, otherUserId), eq(friendship.status, "accepted")))
    .returning({ id: friendship.id });
  return deleted.length > 0;
}

/** Ids of everyone `userId` has an accepted friendship with. */
export async function acceptedFriendIds(userId: string): Promise<string[]> {
  const rows = await db
    .select({ requester: friendship.requesterUserId, addressee: friendship.addresseeUserId })
    .from(friendship)
    .where(
      and(
        eq(friendship.status, "accepted"),
        or(eq(friendship.requesterUserId, userId), eq(friendship.addresseeUserId, userId))
      )
    );
  return rows.map((r) => (r.requester === userId ? r.addressee : r.requester));
}

/** Accepted friends with display fields, sorted by name. */
export async function listFriends(userId: string) {
  const ids = await acceptedFriendIds(userId);
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      id: user.id,
      name: user.name,
      image: user.image,
      username: userProfile.username,
      areaLocation: userProfile.areaLocation,
    })
    .from(user)
    .leftJoin(userProfile, eq(userProfile.userId, user.id))
    .where(inArray(user.id, ids))
    .orderBy(asc(user.name));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    image: r.image ?? null,
    username: r.username ?? null,
    areaLocation: r.areaLocation ?? null,
  }));
}

/** How `viewerId` is connected to `otherId`, from the viewer's side. */
export async function relationship(
  viewerId: string,
  otherId: string
): Promise<{ status: RelationshipStatus; requestId?: string }> {
  if (viewerId === otherId) return { status: "none" };
  const row = await findPair(viewerId, otherId);
  if (!row) return { status: "none" };
  if (row.status === "accepted") return { status: "friends", requestId: row.id };
  return {
    status: row.requesterUserId === viewerId ? "outgoing_pending" : "incoming_pending",
    requestId: row.id,
  };
}

/**
 * Mutual friends between `viewerId` and each of `otherIds`, in one query: the count plus the
 * first few (by name). Only accepted friendships count; coach links don't.
 */
export async function mutualFriendsBatch(
  viewerId: string,
  otherIds: string[]
): Promise<Map<string, MutualFriendsSummary>> {
  const others = Array.from(new Set(otherIds.filter((id) => id && id !== viewerId)));
  const out = new Map<string, MutualFriendsSummary>();
  if (others.length === 0) return out;

  const othersArray = sql`ARRAY[${sql.join(
    others.map((id) => sql`${id}`),
    sql`, `
  )}]::text[]`;

  const result = await db.execute(sql`
    WITH viewer_friends AS (
      SELECT CASE WHEN f."requesterUserId" = ${viewerId} THEN f."addresseeUserId" ELSE f."requesterUserId" END AS fid
      FROM friendship f
      WHERE f.status = 'accepted' AND (f."requesterUserId" = ${viewerId} OR f."addresseeUserId" = ${viewerId})
    ),
    other_friends AS (
      SELECT o.oid,
             CASE WHEN f."requesterUserId" = o.oid THEN f."addresseeUserId" ELSE f."requesterUserId" END AS fid
      FROM unnest(${othersArray}) AS o(oid)
      JOIN friendship f
        ON f.status = 'accepted' AND (f."requesterUserId" = o.oid OR f."addresseeUserId" = o.oid)
    ),
    ranked AS (
      SELECT ofr.oid, u.id, u.name, u.image,
             count(*) OVER (PARTITION BY ofr.oid) AS total,
             row_number() OVER (PARTITION BY ofr.oid ORDER BY u.name, u.id) AS rn
      FROM other_friends ofr
      JOIN viewer_friends vf ON vf.fid = ofr.fid
      JOIN "user" u ON u.id = ofr.fid
      WHERE ofr.fid <> ${viewerId}
    )
    SELECT oid, id, name, image, total FROM ranked WHERE rn <= ${MUTUAL_PREVIEW} ORDER BY oid, rn
  `);

  for (const row of result.rows as Array<Record<string, unknown>>) {
    const oid = String(row.oid);
    const entry = out.get(oid) ?? { count: Number(row.total) || 0, friends: [] };
    entry.friends.push({
      id: String(row.id),
      name: String(row.name ?? ""),
      image: (row.image as string | null) ?? null,
    });
    out.set(oid, entry);
  }
  return out;
}

export async function mutualFriends(viewerId: string, otherId: string): Promise<MutualFriendsSummary> {
  return (await mutualFriendsBatch(viewerId, [otherId])).get(otherId) ?? EMPTY_MUTUAL;
}

export type IncomingRequest = {
  id: string;
  createdAt: Date;
  sender: {
    id: string;
    name: string;
    image: string | null;
    areaLocation: string | null;
    country: string | null;
  };
  mutual: MutualFriendsSummary;
};

/** Pending requests sent to `userId`, newest first, with sender details and mutual friends. */
export async function listIncoming(userId: string): Promise<{ requests: IncomingRequest[]; count: number }> {
  const rows = await db
    .select({
      id: friendship.id,
      createdAt: friendship.createdAt,
      senderId: user.id,
      name: user.name,
      image: user.image,
      areaLocation: userProfile.areaLocation,
    })
    .from(friendship)
    .innerJoin(user, eq(user.id, friendship.requesterUserId))
    .leftJoin(userProfile, eq(userProfile.userId, user.id))
    .where(and(eq(friendship.addresseeUserId, userId), eq(friendship.status, "pending")))
    .orderBy(desc(friendship.createdAt), desc(friendship.id));

  const mutual = await mutualFriendsBatch(
    userId,
    rows.map((r) => r.senderId)
  );

  const requests = rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt,
    sender: {
      id: r.senderId,
      name: r.name,
      image: r.image ?? null,
      areaLocation: r.areaLocation ?? null,
      country: countryFromAreaLocation(r.areaLocation),
    },
    mutual: mutual.get(r.senderId) ?? EMPTY_MUTUAL,
  }));
  return { requests, count: requests.length };
}

/** Pending incoming request count (for the Requests badge). */
export async function incomingCount(userId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(friendship)
    .where(and(eq(friendship.addresseeUserId, userId), eq(friendship.status, "pending")));
  return Number(row?.n) || 0;
}

/**
 * A pending request addressed to `viewerId`, with the sender's profile for the detail screen.
 * 404 when it isn't pending or isn't addressed to the viewer.
 */
export async function requestDetail(requestId: string, viewerId: string) {
  const row = await findById(requestId);
  if (!row || row.status !== "pending" || row.addresseeUserId !== viewerId) {
    throw new FriendsError(404, "Request not found");
  }
  const senderId = row.requesterUserId;
  const [sender] = await db
    .select({
      id: user.id,
      name: user.name,
      image: user.image,
      areaLocation: userProfile.areaLocation,
      level: userProfile.level,
      courtSide: userProfile.courtSide,
      dominantHand: userProfile.dominantHand,
    })
    .from(user)
    .leftJoin(userProfile, eq(userProfile.userId, user.id))
    .where(eq(user.id, senderId))
    .limit(1);
  if (!sender) throw new FriendsError(404, "Request not found");

  const [about] = await db
    .select({ body: coachProfileSection.body })
    .from(coachProfileSection)
    .where(eq(coachProfileSection.coachUserId, senderId))
    .orderBy(asc(coachProfileSection.sortOrder), asc(coachProfileSection.createdAt))
    .limit(1);

  const [scores, mutual] = await Promise.all([
    averageScoresForUsers([senderId]),
    mutualFriends(viewerId, senderId),
  ]);

  return {
    request: { id: row.id, createdAt: row.createdAt },
    sender: {
      id: sender.id,
      name: sender.name,
      image: sender.image ?? null,
      areaLocation: sender.areaLocation ?? null,
      country: countryFromAreaLocation(sender.areaLocation),
      level: sender.level?.trim() || null,
      courtSide: sender.courtSide?.trim() || null,
      dominantHand: sender.dominantHand?.trim() || null,
      overallScore: scores.get(senderId) ?? null,
      about: about?.body?.trim() || null,
    },
    mutual,
  };
}
