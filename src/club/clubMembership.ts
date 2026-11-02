/**
 * Club memberships: invites, join requests, members and each player's main club.
 * The state rules live in `clubMembershipRules.ts`; this module loads the current record,
 * asks the rules, and applies the outcome in a transaction. The routes in `clubRouter.ts`
 * (owner) and `clubMembershipRouter.ts` (player) only parse requests and map errors.
 *
 * Every write runs inside a transaction holding a per-player advisory lock, so the two sides
 * of a pair (or two joins racing for the main club) are serialized. The unique (club, user)
 * index stays the backstop.
 */
import { randomUUID } from "crypto";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { club, clubMembership, db, user, userNotification, userProfile } from "../db";
import {
  decideMembership,
  normalizeInviteEmail,
  pickNextMain,
  type CurrentState,
  type MembershipAction,
  type MembershipErrorCode,
  type MembershipNotification,
  type MembershipState,
} from "./clubMembershipRules";

export type ClubMembershipRow = typeof clubMembership.$inferSelect;
type ClubRow = typeof club.$inferSelect;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Exec = typeof db | Tx;

export class MembershipError extends Error {
  constructor(
    public readonly code: MembershipErrorCode,
    message: string
  ) {
    super(message);
    this.name = "MembershipError";
  }
}

const STATUS_FOR_CODE: Record<MembershipErrorCode, number> = {
  bad_request: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
};

export function membershipErrorStatus(e: MembershipError): number {
  return STATUS_FOR_CODE[e.code];
}

export type MembershipResult = {
  membership: ClubMembershipRow | null;
  state: CurrentState;
  /** A new record was inserted (vs. an existing one returned or changed). */
  created?: boolean;
};

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function loadClub(exec: Exec, clubId: string): Promise<ClubRow | null> {
  const id = String(clubId || "").trim();
  if (!id) return null;
  const rows = await exec.select().from(club).where(eq(club.id, id)).limit(1);
  return rows[0] ?? null;
}

async function loadClubOrThrow(exec: Exec, clubId: string): Promise<ClubRow> {
  const row = await loadClub(exec, clubId);
  if (!row) throw new MembershipError("not_found", "Club not found");
  return row;
}

/** Approved-club check shared by the player routes. */
export function isClubApproved(row: Pick<ClubRow, "status">): boolean {
  return row.status === "approved";
}

/**
 * The club, if `userId` owns it. 404 when the club doesn't exist, 403 when someone else owns it.
 */
export async function ownedClubOrThrow(userId: string, clubId: string): Promise<ClubRow> {
  const row = await loadClubOrThrow(db, clubId);
  if (row.ownerUserId !== userId) {
    throw new MembershipError("forbidden", "Only the club owner can manage members");
  }
  return row;
}

async function findPair(exec: Exec, clubId: string, userId: string) {
  const rows = await exec
    .select()
    .from(clubMembership)
    .where(and(eq(clubMembership.clubId, clubId), eq(clubMembership.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

async function findById(exec: Exec, id: string) {
  const mid = String(id || "").trim();
  if (!mid) return null;
  const rows = await exec.select().from(clubMembership).where(eq(clubMembership.id, mid)).limit(1);
  return rows[0] ?? null;
}

/** Serializes all membership writes for one player. Released when the transaction ends. */
async function lockPlayer(tx: Tx, userId: string) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"club_membership:" + userId}))`);
}

function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string } } | null;
  return err?.code === "23505" || err?.cause?.code === "23505";
}

// ---------------------------------------------------------------------------
// Applying a decision
// ---------------------------------------------------------------------------

async function playerHasMain(tx: Tx, userId: string, exceptId?: string): Promise<boolean> {
  const conds = [eq(clubMembership.userId, userId), eq(clubMembership.isMain, true)];
  if (exceptId) conds.push(ne(clubMembership.id, exceptId));
  const rows = await tx.select({ id: clubMembership.id }).from(clubMembership).where(and(...conds)).limit(1);
  return rows.length > 0;
}

/** After a main membership is deleted, promote the earliest-joined remaining one. */
async function promoteNextMain(tx: Tx, userId: string) {
  if (await playerHasMain(tx, userId)) return;
  const rest = await tx
    .select({ id: clubMembership.id, joinedAt: clubMembership.joinedAt })
    .from(clubMembership)
    .where(and(eq(clubMembership.userId, userId), eq(clubMembership.state, "member")));
  const next = pickNextMain(rest);
  if (next) {
    await tx
      .update(clubMembership)
      .set({ isMain: true, updatedAt: new Date() })
      .where(eq(clubMembership.id, next.id));
  }
}

async function insertRow(
  tx: Tx,
  values: {
    clubId: string;
    userId: string;
    state: MembershipState;
    createdByUserId: string;
    invitedEmail?: string | null;
  }
): Promise<ClubMembershipRow> {
  const now = new Date();
  const isMember = values.state === "member";
  const isMain = isMember ? !(await playerHasMain(tx, values.userId)) : false;
  const [row] = await tx
    .insert(clubMembership)
    .values({
      id: randomUUID(),
      clubId: values.clubId,
      userId: values.userId,
      state: values.state,
      invitedEmail: values.state === "invited" ? values.invitedEmail ?? null : null,
      createdByUserId: values.createdByUserId,
      isMain,
      createdAt: now,
      joinedAt: isMember ? now : null,
      updatedAt: now,
    })
    .returning();
  return row;
}

async function makeMember(tx: Tx, row: ClubMembershipRow): Promise<ClubMembershipRow> {
  const isMain = !(await playerHasMain(tx, row.userId, row.id));
  const now = new Date();
  const [updated] = await tx
    .update(clubMembership)
    .set({ state: "member", isMain, joinedAt: now, updatedAt: now })
    .where(eq(clubMembership.id, row.id))
    .returning();
  return updated;
}

async function deleteRow(tx: Tx, row: ClubMembershipRow) {
  await tx.delete(clubMembership).where(eq(clubMembership.id, row.id));
  if (row.isMain) await promoteNextMain(tx, row.userId);
}

async function setMain(tx: Tx, row: ClubMembershipRow): Promise<ClubMembershipRow> {
  if (row.isMain) return row;
  await tx
    .update(clubMembership)
    .set({ isMain: false, updatedAt: new Date() })
    .where(and(eq(clubMembership.userId, row.userId), eq(clubMembership.isMain, true)));
  const [updated] = await tx
    .update(clubMembership)
    .set({ isMain: true, updatedAt: new Date() })
    .where(eq(clubMembership.id, row.id))
    .returning();
  return updated;
}

async function notify(
  exec: Exec,
  kind: MembershipNotification,
  clubRow: ClubRow,
  membership: ClubMembershipRow
) {
  const name = clubRow.name.trim() || "A club";
  await exec.insert(userNotification).values({
    id: randomUUID(),
    userId: membership.userId,
    kind,
    title: kind === "club_invite" ? `${name} invited you to join` : `${name} approved your request`,
    body: null,
    refType: kind === "club_invite" ? "club_membership" : "club",
    refId: kind === "club_invite" ? membership.id : clubRow.slug,
  });
}

type RunArgs = {
  action: MembershipAction;
  actorUserId: string;
  clubRow: ClubRow;
  /** The player the record is (or would be) about. */
  subjectUserId: string;
  /** For record actions: the record must exist, belong to this club and be this id. */
  expectedId?: string;
  invitedEmail?: string | null;
};

/**
 * Loads the pair inside a locked transaction, decides, applies, and writes any notification in
 * the same transaction.
 */
async function run(args: RunArgs): Promise<MembershipResult> {
  const { action, actorUserId, clubRow, subjectUserId, expectedId } = args;

  const attempt = () =>
    db.transaction(async (tx) => {
      await lockPlayer(tx, subjectUserId);
      let row: ClubMembershipRow | null = await findPair(tx, clubRow.id, subjectUserId);
      if (expectedId && row?.id !== expectedId) row = null;
      const current: CurrentState = (row?.state as MembershipState | undefined) ?? "none";

      const decision = decideMembership({
        action,
        isOwner: clubRow.ownerUserId === actorUserId,
        isSubject: subjectUserId === actorUserId,
        current,
        clubApproved: isClubApproved(clubRow),
      });
      if (!decision.ok) throw new MembershipError(decision.error, decision.message);

      let result: MembershipResult;
      switch (decision.outcome) {
        case "create_invited":
          result = {
            membership: await insertRow(tx, {
              clubId: clubRow.id,
              userId: subjectUserId,
              state: "invited",
              createdByUserId: actorUserId,
              invitedEmail: args.invitedEmail,
            }),
            state: "invited",
            created: true,
          };
          break;
        case "create_requested":
          result = {
            membership: await insertRow(tx, {
              clubId: clubRow.id,
              userId: subjectUserId,
              state: "requested",
              createdByUserId: actorUserId,
            }),
            state: "requested",
            created: true,
          };
          break;
        case "create_member":
          result = {
            membership: await insertRow(tx, {
              clubId: clubRow.id,
              userId: subjectUserId,
              state: "member",
              createdByUserId: actorUserId,
            }),
            state: "member",
            created: true,
          };
          break;
        case "make_member":
          result = { membership: await makeMember(tx, row!), state: "member" };
          break;
        case "delete":
          await deleteRow(tx, row!);
          result = { membership: null, state: "none" };
          break;
        case "set_main":
          result = { membership: await setMain(tx, row!), state: "member" };
          break;
        case "unchanged":
        default:
          result = { membership: row, state: current };
      }

      if (decision.notify && result.membership) {
        await notify(tx, decision.notify, clubRow, result.membership);
      }
      return result;
    });

  try {
    return await attempt();
  } catch (e) {
    // The lock makes this unlikely; if a concurrent insert still won, re-read and re-decide.
    if (!isUniqueViolation(e)) throw e;
    return attempt();
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** The club owner invites the account with `email`. */
export async function inviteToClub(ownerUserId: string, clubId: string, email: unknown) {
  const clubRow = await loadClubOrThrow(db, clubId);
  if (clubRow.ownerUserId !== ownerUserId) {
    throw new MembershipError("forbidden", "Only the club owner can invite players");
  }
  const normalized = normalizeInviteEmail(email);
  if (!normalized) throw new MembershipError("bad_request", "Enter a valid email address");
  const target = await db
    .select({ id: user.id })
    .from(user)
    .where(sql`lower(${user.email}) = ${normalized}`)
    .limit(1);
  if (target.length === 0) throw new MembershipError("not_found", "No Axevo player with that email");
  return run({
    action: "invite",
    actorUserId: ownerUserId,
    clubRow,
    subjectUserId: target[0].id,
    invitedEmail: normalized,
  });
}

/** A player asks to join a club. */
export async function requestToJoin(userId: string, clubId: string) {
  const clubRow = await loadClubOrThrow(db, clubId);
  return run({ action: "request", actorUserId: userId, clubRow, subjectUserId: userId });
}

/** Record actions addressed by membership id (player side). */
async function runOnRecord(action: MembershipAction, actorUserId: string, membershipId: string) {
  const row = await findById(db, membershipId);
  if (!row) throw new MembershipError("not_found", notFoundMessage(action));
  const clubRow = await loadClubOrThrow(db, row.clubId);
  return run({ action, actorUserId, clubRow, subjectUserId: row.userId, expectedId: row.id });
}

/** Record actions addressed by membership id under a club (owner side). */
async function runOnClubRecord(
  action: MembershipAction,
  ownerUserId: string,
  clubId: string,
  membershipId: string
) {
  const clubRow = await ownedClubOrThrow(ownerUserId, clubId);
  const row = await findById(db, membershipId);
  if (!row || row.clubId !== clubRow.id) throw new MembershipError("not_found", notFoundMessage(action));
  return run({ action, actorUserId: ownerUserId, clubRow, subjectUserId: row.userId, expectedId: row.id });
}

function notFoundMessage(action: MembershipAction): string {
  if (action.includes("Invite")) return "Invite not found";
  if (action.includes("Request")) return "Join request not found";
  return "Membership not found";
}

export const acceptInvite = (userId: string, membershipId: string) =>
  runOnRecord("acceptInvite", userId, membershipId);
export const declineInvite = (userId: string, membershipId: string) =>
  runOnRecord("declineInvite", userId, membershipId);
export const cancelRequest = (userId: string, membershipId: string) =>
  runOnRecord("cancelRequest", userId, membershipId);

export const cancelInvite = (ownerUserId: string, clubId: string, membershipId: string) =>
  runOnClubRecord("cancelInvite", ownerUserId, clubId, membershipId);
export const approveRequest = (ownerUserId: string, clubId: string, membershipId: string) =>
  runOnClubRecord("approveRequest", ownerUserId, clubId, membershipId);
export const declineRequest = (ownerUserId: string, clubId: string, membershipId: string) =>
  runOnClubRecord("declineRequest", ownerUserId, clubId, membershipId);
export const removeMember = (ownerUserId: string, clubId: string, membershipId: string) =>
  runOnClubRecord("remove", ownerUserId, clubId, membershipId);

/** A member leaves a club. */
export async function leaveClub(userId: string, clubId: string) {
  const clubRow = await loadClubOrThrow(db, clubId);
  return run({ action: "leave", actorUserId: userId, clubRow, subjectUserId: userId });
}

/** A member makes this club their main club. */
export async function setMainClub(userId: string, clubId: string) {
  const clubRow = await loadClubOrThrow(db, clubId);
  return run({ action: "setMain", actorUserId: userId, clubRow, subjectUserId: userId });
}

// ---------------------------------------------------------------------------
// Reads (also used by the later ranking and country features)
// ---------------------------------------------------------------------------

/** Member counts for many clubs in one grouped query. Clubs with no members map to 0. */
export async function memberCountsForClubs(clubIds: string[]): Promise<Map<string, number>> {
  const ids = Array.from(new Set(clubIds.filter(Boolean)));
  const out = new Map<string, number>(ids.map((id) => [id, 0]));
  if (ids.length === 0) return out;
  const rows = await db
    .select({ clubId: clubMembership.clubId, n: sql<number>`count(*)::int` })
    .from(clubMembership)
    .where(and(inArray(clubMembership.clubId, ids), eq(clubMembership.state, "member")))
    .groupBy(clubMembership.clubId);
  for (const r of rows) out.set(r.clubId, Number(r.n) || 0);
  return out;
}

export async function memberCountForClub(clubId: string): Promise<number> {
  return (await memberCountsForClubs([clubId])).get(clubId) ?? 0;
}

/** User ids of a club's members (approved clubs only; invites and requests don't count). */
export async function clubMemberUserIds(clubId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: clubMembership.userId })
    .from(clubMembership)
    .innerJoin(club, eq(club.id, clubMembership.clubId))
    .where(
      and(
        eq(clubMembership.clubId, clubId),
        eq(clubMembership.state, "member"),
        eq(club.status, "approved")
      )
    );
  return rows.map((r) => r.userId);
}

/** The player's main club id, or null (approved clubs only). */
export async function mainClubIdForUser(userId: string): Promise<string | null> {
  const rows = await db
    .select({ clubId: clubMembership.clubId })
    .from(clubMembership)
    .innerJoin(club, eq(club.id, clubMembership.clubId))
    .where(
      and(
        eq(clubMembership.userId, userId),
        eq(clubMembership.isMain, true),
        eq(clubMembership.state, "member"),
        eq(club.status, "approved")
      )
    )
    .limit(1);
  return rows[0]?.clubId ?? null;
}

export type ClubSummary = {
  id: string;
  slug: string;
  name: string;
  logoImageUrl: string | null;
  city: string | null;
  country: string | null;
  memberCount: number;
};

function clubSummary(row: ClubRow, counts: Map<string, number>): ClubSummary {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    logoImageUrl: row.logoImageUrl ?? null,
    city: row.city ?? null,
    country: row.country ?? null,
    memberCount: counts.get(row.id) ?? 0,
  };
}

/** Approved clubs the player belongs to: the main club first, then the rest in order joined. */
export async function clubsForUser(userId: string) {
  const rows = await db
    .select({ m: clubMembership, c: club })
    .from(clubMembership)
    .innerJoin(club, eq(club.id, clubMembership.clubId))
    .where(
      and(
        eq(clubMembership.userId, userId),
        eq(clubMembership.state, "member"),
        eq(club.status, "approved")
      )
    )
    .orderBy(desc(clubMembership.isMain), asc(clubMembership.joinedAt), asc(clubMembership.id));
  const counts = await memberCountsForClubs(rows.map((r) => r.c.id));
  return rows.map((r) => ({
    ...clubSummary(r.c, counts),
    membershipId: r.m.id,
    isMain: r.m.isMain,
    joinedAt: r.m.joinedAt ? r.m.joinedAt.toISOString() : null,
  }));
}

/** The player's pending club invites, newest first (approved clubs only). */
export async function listInvitesForUser(userId: string) {
  const rows = await db
    .select({ m: clubMembership, c: club })
    .from(clubMembership)
    .innerJoin(club, eq(club.id, clubMembership.clubId))
    .where(
      and(
        eq(clubMembership.userId, userId),
        eq(clubMembership.state, "invited"),
        eq(club.status, "approved")
      )
    )
    .orderBy(desc(clubMembership.createdAt), desc(clubMembership.id));
  const counts = await memberCountsForClubs(rows.map((r) => r.c.id));
  const invites = rows.map((r) => ({
    id: r.m.id,
    createdAt: r.m.createdAt.toISOString(),
    club: clubSummary(r.c, counts),
  }));
  return { invites, count: invites.length };
}

export type MyMembership = {
  state: CurrentState;
  id: string | null;
  isMain: boolean;
};

/** The viewer's record with a club, for the club detail. */
export async function myMembership(userId: string, clubId: string): Promise<MyMembership> {
  const row = await findPair(db, clubId, userId);
  if (!row) return { state: "none", id: null, isMain: false };
  return { state: row.state as MembershipState, id: row.id, isMain: row.isMain };
}

/** The owner's Members view. Email appears only on invite rows. */
export async function ownerMembersView(clubId: string) {
  const rows = await db
    .select({
      id: clubMembership.id,
      state: clubMembership.state,
      invitedEmail: clubMembership.invitedEmail,
      createdAt: clubMembership.createdAt,
      joinedAt: clubMembership.joinedAt,
      userId: user.id,
      name: user.name,
      image: user.image,
      areaLocation: userProfile.areaLocation,
    })
    .from(clubMembership)
    .innerJoin(user, eq(user.id, clubMembership.userId))
    .leftJoin(userProfile, eq(userProfile.userId, user.id))
    .where(eq(clubMembership.clubId, clubId))
    .orderBy(desc(clubMembership.createdAt), desc(clubMembership.id));

  const player = (r: (typeof rows)[number]) => ({
    id: r.userId,
    name: r.name,
    image: r.image ?? null,
    areaLocation: r.areaLocation ?? null,
  });

  const requests = rows
    .filter((r) => r.state === "requested")
    .map((r) => ({ id: r.id, createdAt: r.createdAt.toISOString(), player: player(r) }));
  const invites = rows
    .filter((r) => r.state === "invited")
    .map((r) => ({
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      invitedEmail: r.invitedEmail ?? null,
      player: player(r),
    }));
  const members = rows
    .filter((r) => r.state === "member")
    .sort((a, b) => (a.joinedAt?.getTime() ?? 0) - (b.joinedAt?.getTime() ?? 0))
    .map((r) => ({
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      joinedAt: r.joinedAt ? r.joinedAt.toISOString() : null,
      player: player(r),
    }));
  return { requests, invites, members };
}

/** Wire shape of a membership row for API responses (no email). */
export function serializeMembership(row: ClubMembershipRow | null) {
  if (!row) return null;
  return {
    id: row.id,
    clubId: row.clubId,
    userId: row.userId,
    state: row.state,
    isMain: row.isMain,
    createdAt: row.createdAt.toISOString(),
    joinedAt: row.joinedAt ? row.joinedAt.toISOString() : null,
  };
}
