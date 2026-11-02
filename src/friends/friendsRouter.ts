import express from "express";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "../auth";
import { db } from "../db";
import {
  FriendsError,
  accept,
  cancel,
  decline,
  listFriends,
  listIncoming,
  mutualFriends,
  relationship,
  requestDetail,
  sendRequest,
  unfriend,
} from "./friendsService";

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

/** Auth + error mapping shared by every route. */
function authed(label: string, handler: Handler): express.RequestHandler {
  return async (req, res) => {
    try {
      const userId = await resolveUserId(req);
      if (!userId) return res.status(401).json({ error: "Unauthorized" });
      await handler(req, res, userId);
    } catch (e) {
      if (e instanceof FriendsError) return res.status(e.status).json({ error: e.message });
      console.error(`[Friends] ${label} error`, e);
      return res.status(500).json({ error: "Something went wrong" });
    }
  };
}

function param(req: express.Request, name: string): string {
  return String(req.params?.[name] ?? "").trim();
}

router.post(
  "/requests",
  authed("send request", async (req, res, userId) => {
    const toUserId = String(req.body?.toUserId ?? "").trim();
    const result = await sendRequest(userId, toUserId);
    res.status(result.status === "pending" ? 201 : 200).json(result);
  })
);

router.get(
  "/requests/incoming",
  authed("incoming", async (_req, res, userId) => {
    res.json(await listIncoming(userId));
  })
);

router.get(
  "/requests/:id",
  authed("request detail", async (req, res, userId) => {
    res.json(await requestDetail(param(req, "id"), userId));
  })
);

router.post(
  "/requests/:id/accept",
  authed("accept", async (req, res, userId) => {
    const request = await accept(param(req, "id"), userId);
    res.json({ request, status: "accepted" });
  })
);

router.post(
  "/requests/:id/decline",
  authed("decline", async (req, res, userId) => {
    await decline(param(req, "id"), userId);
    res.json({ ok: true });
  })
);

router.delete(
  "/requests/:id",
  authed("cancel", async (req, res, userId) => {
    await cancel(param(req, "id"), userId);
    res.json({ ok: true });
  })
);

router.get(
  "/relationship/:userId",
  authed("relationship", async (req, res, userId) => {
    const other = param(req, "userId");
    const [rel, mutual] = await Promise.all([relationship(userId, other), mutualFriends(userId, other)]);
    res.json({ ...rel, mutual });
  })
);

router.get(
  "/",
  authed("list", async (_req, res, userId) => {
    res.json({ friends: await listFriends(userId) });
  })
);

router.delete(
  "/:userId",
  authed("unfriend", async (req, res, userId) => {
    const removed = await unfriend(userId, param(req, "userId"));
    if (!removed) return res.status(404).json({ error: "Not friends" });
    res.json({ ok: true });
  })
);

export default router;
