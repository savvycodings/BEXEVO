/**
 * Player-side club membership routes, mounted at `/club-memberships` and
 * `/api/auth/club-memberships` (a separate mount keeps them clear of the club router's `/:slug`
 * catch-all). Owner-side routes live under `/club/mine/:id/...` in `clubRouter.ts`.
 */
import express from "express";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "../auth";
import { db } from "../db";
import {
  MembershipError,
  acceptInvite,
  cancelRequest,
  clubsForUser,
  declineInvite,
  leaveClub,
  listInvitesForUser,
  memberCountForClub,
  membershipErrorStatus,
  requestToJoin,
  serializeMembership,
  setMainClub,
  type MembershipResult,
} from "./clubMembership";

const router = express.Router();
router.use(express.json());

async function resolveUserId(req: express.Request): Promise<string | null> {
  const session = await auth.api
    .getSession({ headers: fromNodeHeaders(req.headers) })
    .catch(() => null);
  if (session?.user?.id) return session.user.id;

  const authHeader = req.headers.authorization;
  const bearerToken =
    typeof authHeader === "string" && authHeader.toLowerCase().startsWith("bearer ")
      ? authHeader.slice(7).trim()
      : null;
  if (!bearerToken) return null;

  const sessionRow = await db.query.session.findFirst({
    where: (s, { eq: _eq }) => _eq(s.token, bearerToken),
  });
  return sessionRow?.userId ?? null;
}

type Handler = (req: express.Request, res: express.Response, userId: string) => Promise<unknown>;

function authed(label: string, handler: Handler): express.RequestHandler {
  return async (req, res) => {
    try {
      const userId = await resolveUserId(req);
      if (!userId) return res.status(401).json({ error: "Unauthorized" });
      await handler(req, res, userId);
    } catch (e) {
      if (e instanceof MembershipError) {
        return res.status(membershipErrorStatus(e)).json({ error: e.message, code: e.code });
      }
      console.error(`[ClubMembership] ${label} error`, e);
      return res.status(500).json({ error: "Something went wrong" });
    }
  };
}

function param(req: express.Request, name: string): string {
  return String(req.params?.[name] ?? "").trim();
}

/** Result plus the club's fresh member count, so the app can update without a refetch. */
async function resultBody(result: MembershipResult, clubId: string) {
  return {
    membership: serializeMembership(result.membership),
    state: result.state,
    isMain: result.membership?.isMain ?? false,
    memberCount: await memberCountForClub(clubId),
  };
}

router.get(
  "/invites",
  authed("invites", async (_req, res, userId) => {
    res.json(await listInvitesForUser(userId));
  })
);

router.post(
  "/invites/:id/accept",
  authed("accept invite", async (req, res, userId) => {
    const result = await acceptInvite(userId, param(req, "id"));
    res.json(await resultBody(result, result.membership!.clubId));
  })
);

router.post(
  "/invites/:id/decline",
  authed("decline invite", async (req, res, userId) => {
    await declineInvite(userId, param(req, "id"));
    res.json({ ok: true });
  })
);

router.post(
  "/requests",
  authed("request", async (req, res, userId) => {
    const clubId = String(req.body?.clubId ?? "").trim();
    if (!clubId) return res.status(400).json({ error: "Missing clubId" });
    const result = await requestToJoin(userId, clubId);
    res.status(result.created ? 201 : 200).json(await resultBody(result, clubId));
  })
);

router.delete(
  "/requests/:id",
  authed("cancel request", async (req, res, userId) => {
    await cancelRequest(userId, param(req, "id"));
    res.json({ ok: true });
  })
);

router.get(
  "/mine",
  authed("mine", async (_req, res, userId) => {
    res.json({ clubs: await clubsForUser(userId) });
  })
);

router.get(
  "/users/:userId",
  authed("user clubs", async (req, res) => {
    res.json({ clubs: await clubsForUser(param(req, "userId")) });
  })
);

router.post(
  "/clubs/:clubId/main",
  authed("set main", async (req, res, userId) => {
    const clubId = param(req, "clubId");
    const result = await setMainClub(userId, clubId);
    res.json(await resultBody(result, clubId));
  })
);

router.delete(
  "/clubs/:clubId",
  authed("leave", async (req, res, userId) => {
    const clubId = param(req, "clubId");
    const result = await leaveClub(userId, clubId);
    res.json(await resultBody(result, clubId));
  })
);

export default router;
