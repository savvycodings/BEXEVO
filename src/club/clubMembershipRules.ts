/**
 * Pure state rules for club memberships: who may do what from which state, and what happens.
 * `clubMembership.ts` loads the current record, asks `decideMembership`, then applies the
 * outcome in a transaction. Keeping the rules here lets `tsx --test` cover them without a DB.
 */

export type MembershipState = "invited" | "requested" | "member";
/** `none` = there is no record for this (club, player) pair. */
export type CurrentState = MembershipState | "none";

export type MembershipAction =
  /** The club owner invites a player (the subject). */
  | "invite"
  /** A player (the subject) asks to join. */
  | "request"
  | "acceptInvite"
  | "declineInvite"
  | "cancelInvite"
  | "approveRequest"
  | "declineRequest"
  | "cancelRequest"
  | "leave"
  | "remove"
  | "setMain";

export type MembershipErrorCode = "not_found" | "forbidden" | "conflict" | "bad_request";

export type MembershipOutcome =
  /** Insert a new `invited` record. */
  | "create_invited"
  /** Insert a new `requested` record. */
  | "create_requested"
  /** Insert a new `member` record (owner joining their own club). */
  | "create_member"
  /** Turn the existing record into `member`. */
  | "make_member"
  /** Delete the record. */
  | "delete"
  /** Leave the record as it is and return it. */
  | "unchanged"
  /** Make this club the player's main club. */
  | "set_main";

export type MembershipNotification = "club_invite" | "club_join_approved";

export type MembershipDecision =
  | { ok: true; outcome: MembershipOutcome; notify: MembershipNotification | null }
  | { ok: false; error: MembershipErrorCode; message: string };

export type MembershipInput = {
  action: MembershipAction;
  /** The actor owns the club. */
  isOwner: boolean;
  /** The actor is the player the record is (or would be) about. */
  isSubject: boolean;
  current: CurrentState;
  /** The club's status is `approved`. Only needed for actions that add or accept. */
  clubApproved: boolean;
};

const ok = (
  outcome: MembershipOutcome,
  notify: MembershipNotification | null = null
): MembershipDecision => ({ ok: true, outcome, notify });

const fail = (error: MembershipErrorCode, message: string): MembershipDecision => ({
  ok: false,
  error,
  message,
});

const NOT_APPROVED = "This club isn't taking members yet";

export function decideMembership(input: MembershipInput): MembershipDecision {
  const { action, isOwner, isSubject, current, clubApproved } = input;

  switch (action) {
    case "invite": {
      if (!isOwner) return fail("forbidden", "Only the club owner can invite players");
      if (!clubApproved) return fail("conflict", NOT_APPROVED);
      // The owner inviting themselves is the same as joining their own club.
      if (isSubject) {
        if (current === "member") return fail("conflict", "Already a member");
        return ok(current === "none" ? "create_member" : "make_member");
      }
      if (current === "none") return ok("create_invited", "club_invite");
      if (current === "invited") return ok("unchanged");
      if (current === "requested") return ok("make_member", "club_join_approved");
      return fail("conflict", "That player is already a member");
    }

    case "request": {
      if (!isSubject) return fail("forbidden", "You can only ask to join for yourself");
      if (!clubApproved) return fail("conflict", NOT_APPROVED);
      if (current === "member") return fail("conflict", "You're already a member");
      // The owner joining their own club is accepted right away, without a notification.
      if (isOwner) return ok(current === "none" ? "create_member" : "make_member");
      if (current === "none") return ok("create_requested");
      if (current === "requested") return ok("unchanged");
      // A pending invite meets the request: accept it.
      return ok("make_member");
    }

    case "acceptInvite":
    case "declineInvite": {
      if (current === "none") return fail("not_found", "Invite not found");
      if (!isSubject) return fail("forbidden", "Only the invited player can answer this invite");
      if (current !== "invited") return fail("conflict", "This invite is no longer pending");
      if (action === "declineInvite") return ok("delete");
      if (!clubApproved) return fail("conflict", NOT_APPROVED);
      return ok("make_member");
    }

    case "cancelInvite": {
      if (current === "none") return fail("not_found", "Invite not found");
      if (!isOwner) return fail("forbidden", "Only the club owner can cancel an invite");
      if (current !== "invited") return fail("conflict", "This invite is no longer pending");
      return ok("delete");
    }

    case "approveRequest":
    case "declineRequest": {
      if (current === "none") return fail("not_found", "Join request not found");
      if (!isOwner) return fail("forbidden", "Only the club owner can answer join requests");
      if (current !== "requested") return fail("conflict", "This join request is no longer pending");
      if (action === "declineRequest") return ok("delete");
      if (!clubApproved) return fail("conflict", NOT_APPROVED);
      return ok("make_member", "club_join_approved");
    }

    case "cancelRequest": {
      if (current === "none") return fail("not_found", "Join request not found");
      if (!isSubject) return fail("forbidden", "Only the player who asked can cancel");
      if (current !== "requested") return fail("conflict", "This join request is no longer pending");
      return ok("delete");
    }

    case "leave": {
      if (current === "none") return fail("not_found", "You're not a member of this club");
      if (!isSubject) return fail("forbidden", "You can only leave a club yourself");
      if (current !== "member") return fail("conflict", "You're not a member of this club");
      return ok("delete");
    }

    case "remove": {
      if (current === "none") return fail("not_found", "Member not found");
      if (!isOwner) return fail("forbidden", "Only the club owner can remove members");
      if (current !== "member") return fail("conflict", "That player is not a member");
      return ok("delete");
    }

    case "setMain": {
      if (current === "none") return fail("not_found", "You're not a member of this club");
      if (!isSubject) return fail("forbidden", "You can only choose your own main club");
      if (current !== "member") return fail("conflict", "You're not a member of this club");
      return ok("set_main");
    }
  }
}

/**
 * Which remaining membership becomes the main club after the main one goes away: the earliest
 * `joinedAt` (ties broken by id so the choice is stable). Returns null when none remain.
 */
export function pickNextMain<T extends { id: string; joinedAt: Date | null }>(rows: T[]): T | null {
  let best: T | null = null;
  for (const row of rows) {
    if (!best) {
      best = row;
      continue;
    }
    const a = row.joinedAt?.getTime() ?? Number.POSITIVE_INFINITY;
    const b = best.joinedAt?.getTime() ?? Number.POSITIVE_INFINITY;
    if (a < b || (a === b && row.id < best.id)) best = row;
  }
  return best;
}

/** Lowercased, trimmed email, or null when it doesn't look like one. */
export function normalizeInviteEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (!email || email.length > 320) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}
