// One case per scenario in openspec/changes/add-club-memberships/specs/club-memberships, plus
// the edge rules the scenarios imply. Pure: no database.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import {
  decideMembership,
  normalizeInviteEmail,
  pickNextMain,
  type MembershipInput,
} from "./clubMembershipRules";

const base: MembershipInput = {
  action: "invite",
  isOwner: false,
  isSubject: false,
  current: "none",
  clubApproved: true,
};

function decide(over: Partial<MembershipInput>) {
  return decideMembership({ ...base, ...over });
}

function expectOk(over: Partial<MembershipInput>, outcome: string, notify: string | null = null) {
  const d = decide(over);
  assert.equal(d.ok, true, JSON.stringify(d));
  if (d.ok) {
    assert.equal(d.outcome, outcome);
    assert.equal(d.notify, notify);
  }
}

function expectErr(over: Partial<MembershipInput>, error: string) {
  const d = decide(over);
  assert.equal(d.ok, false, JSON.stringify(d));
  if (!d.ok) assert.equal(d.error, error);
}

const owner = { isOwner: true, isSubject: false };
const player = { isOwner: false, isSubject: true };
const other = { isOwner: false, isSubject: false };

describe("Membership states", () => {
  test("member of two clubs: accepting an invite is per club (no cross-club conflict)", () => {
    expectOk({ action: "acceptInvite", ...player, current: "invited" }, "make_member");
  });
  test("no duplicate records: re-inviting an invited player returns the existing invite", () => {
    expectOk({ action: "invite", ...owner, current: "invited" }, "unchanged");
  });
  test("re-requesting returns the existing request", () => {
    expectOk({ action: "request", ...player, current: "requested" }, "unchanged");
  });
});

describe("Only approved clubs take members", () => {
  test("pending club: join request is a 409", () => {
    expectErr({ action: "request", ...player, clubApproved: false }, "conflict");
  });
  test("pending club: invite is a 409", () => {
    expectErr({ action: "invite", ...owner, clubApproved: false }, "conflict");
  });
  test("pending club: accepting or approving is a 409", () => {
    expectErr({ action: "acceptInvite", ...player, current: "invited", clubApproved: false }, "conflict");
    expectErr(
      { action: "approveRequest", ...owner, current: "requested", clubApproved: false },
      "conflict"
    );
  });
  test("declining and cancelling still work on a club that is no longer approved", () => {
    expectOk({ action: "declineInvite", ...player, current: "invited", clubApproved: false }, "delete");
    expectOk({ action: "cancelRequest", ...player, current: "requested", clubApproved: false }, "delete");
  });
});

describe("Club owner invites a player", () => {
  test("new invite creates an invited record and notifies", () => {
    expectOk({ action: "invite", ...owner, current: "none" }, "create_invited", "club_invite");
  });
  test("not the owner: 403", () => {
    expectErr({ action: "invite", ...other }, "forbidden");
    expectErr({ action: "invite", ...player }, "forbidden");
  });
  test("already a member: 409", () => {
    expectErr({ action: "invite", ...owner, current: "member" }, "conflict");
  });
  test("invite meets a pending request: member, counts as approval", () => {
    expectOk({ action: "invite", ...owner, current: "requested" }, "make_member", "club_join_approved");
  });
  test("owner inviting their own email joins right away, without a notification", () => {
    expectOk({ action: "invite", isOwner: true, isSubject: true, current: "none" }, "create_member");
  });
});

describe("Player asks to join a club", () => {
  test("new join request creates a requested record, no notification", () => {
    expectOk({ action: "request", ...player, current: "none" }, "create_requested");
  });
  test("join request meets a pending invite: member, no notification", () => {
    expectOk({ action: "request", ...player, current: "invited" }, "make_member");
  });
  test("owner joins own club right away", () => {
    expectOk({ action: "request", isOwner: true, isSubject: true, current: "none" }, "create_member");
  });
  test("already a member: 409", () => {
    expectErr({ action: "request", ...player, current: "member" }, "conflict");
  });
});

describe("Respond to an invite or join request", () => {
  test("player accepts invite", () => {
    expectOk({ action: "acceptInvite", ...player, current: "invited" }, "make_member");
  });
  test("player declines invite: record deleted", () => {
    expectOk({ action: "declineInvite", ...player, current: "invited" }, "delete");
  });
  test("owner approves join request: member, notifies", () => {
    expectOk(
      { action: "approveRequest", ...owner, current: "requested" },
      "make_member",
      "club_join_approved"
    );
  });
  test("owner declines join request: deleted, no notification", () => {
    expectOk({ action: "declineRequest", ...owner, current: "requested" }, "delete");
  });
  test("owner cancels invite", () => {
    expectOk({ action: "cancelInvite", ...owner, current: "invited" }, "delete");
  });
  test("player cancels own request", () => {
    expectOk({ action: "cancelRequest", ...player, current: "requested" }, "delete");
  });
  test("wrong user acts: 403", () => {
    expectErr({ action: "acceptInvite", ...other, current: "invited" }, "forbidden");
    expectErr({ action: "acceptInvite", ...owner, current: "invited" }, "forbidden");
    expectErr({ action: "declineInvite", ...other, current: "invited" }, "forbidden");
    expectErr({ action: "cancelInvite", ...player, current: "invited" }, "forbidden");
    expectErr({ action: "approveRequest", ...player, current: "requested" }, "forbidden");
    expectErr({ action: "declineRequest", ...other, current: "requested" }, "forbidden");
    expectErr({ action: "cancelRequest", ...owner, current: "requested" }, "forbidden");
  });
  test("wrong state: 409", () => {
    expectErr({ action: "acceptInvite", ...player, current: "requested" }, "conflict");
    expectErr({ action: "acceptInvite", ...player, current: "member" }, "conflict");
    expectErr({ action: "cancelInvite", ...owner, current: "member" }, "conflict");
    expectErr({ action: "approveRequest", ...owner, current: "invited" }, "conflict");
    expectErr({ action: "cancelRequest", ...player, current: "member" }, "conflict");
  });
  test("no record: 404", () => {
    for (const action of [
      "acceptInvite",
      "declineInvite",
      "cancelInvite",
      "approveRequest",
      "declineRequest",
      "cancelRequest",
      "leave",
      "remove",
      "setMain",
    ] as const) {
      expectErr({ action, isOwner: true, isSubject: true, current: "none" }, "not_found");
    }
  });
});

describe("Leave or remove a member", () => {
  test("member leaves", () => {
    expectOk({ action: "leave", ...player, current: "member" }, "delete");
  });
  test("leaving when only invited: 409", () => {
    expectErr({ action: "leave", ...player, current: "invited" }, "conflict");
  });
  test("owner removes member, no notification", () => {
    expectOk({ action: "remove", ...owner, current: "member" }, "delete");
  });
  test("non-owner can't remove", () => {
    expectErr({ action: "remove", ...player, current: "member" }, "forbidden");
  });
});

describe("Main club", () => {
  test("change main club: members only", () => {
    expectOk({ action: "setMain", ...player, current: "member" }, "set_main");
    expectErr({ action: "setMain", ...player, current: "requested" }, "conflict");
    expectErr({ action: "setMain", ...other, current: "member" }, "forbidden");
  });
  test("leaving the main club promotes the earliest joined", () => {
    const y = { id: "y", joinedAt: new Date("2026-01-01") };
    const z = { id: "z", joinedAt: new Date("2026-03-01") };
    assert.equal(pickNextMain([z, y])?.id, "y");
  });
  test("ties break by id, missing joinedAt goes last", () => {
    const t = new Date("2026-01-01");
    assert.equal(pickNextMain([{ id: "b", joinedAt: t }, { id: "a", joinedAt: t }])?.id, "a");
    assert.equal(pickNextMain([{ id: "a", joinedAt: null }, { id: "b", joinedAt: t }])?.id, "b");
  });
  test("no memberships left: no main club", () => {
    assert.equal(pickNextMain([]), null);
  });
});

describe("Invite email", () => {
  test("lowercases and trims", () => {
    assert.equal(normalizeInviteEmail("  Ana@Example.COM "), "ana@example.com");
  });
  test("rejects non-emails", () => {
    assert.equal(normalizeInviteEmail(""), null);
    assert.equal(normalizeInviteEmail("nope"), null);
    assert.equal(normalizeInviteEmail(42), null);
  });
});
