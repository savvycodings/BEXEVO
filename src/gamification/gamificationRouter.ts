import express from "express";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "../auth";
import {
  claimDailyQuest,
  claimAchievement,
  getGamificationState,
  trackClientQuest,
} from "./service";
import { localDateKey } from "./stats";

const router = express.Router();
router.use(express.json());

async function resolveUserId(req: express.Request): Promise<string | null> {
  try {
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });
    return session?.user?.id ?? null;
  } catch {
    return null;
  }
}

router.get("/state", async (req, res) => {
  try {
    const userId = await resolveUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const dateKey =
      typeof req.query.dateKey === "string" && req.query.dateKey.trim()
        ? req.query.dateKey.trim()
        : localDateKey();

    const state = await getGamificationState(userId, dateKey);
    return res.json(state);
  } catch (e: unknown) {
    console.error("[Gamification] state GET error", e);
    return res.status(500).json({ error: "Failed to load gamification state" });
  }
});

router.post("/daily-quests/:questKey/claim", async (req, res) => {
  try {
    const userId = await resolveUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const questKey = String(req.params.questKey || "").trim();
    if (!questKey) return res.status(400).json({ error: "Missing quest key" });

    const dateKey =
      typeof req.body?.dateKey === "string" && req.body.dateKey.trim()
        ? req.body.dateKey.trim()
        : localDateKey();

    const result = await claimDailyQuest(userId, questKey, dateKey);
    if (!result.ok) {
      return res.status(400).json({ error: result.error });
    }

    return res.json({
      ok: true,
      xpAwarded: result.xpAwarded,
      ...result.state,
    });
  } catch (e: unknown) {
    console.error("[Gamification] claim POST error", e);
    return res.status(500).json({ error: "Failed to claim quest" });
  }
});

router.post("/achievements/:achievementKey/claim", async (req, res) => {
  try {
    const userId = await resolveUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const achievementKey = String(req.params.achievementKey || "").trim();
    if (!achievementKey) {
      return res.status(400).json({ error: "Missing achievement key" });
    }

    const result = await claimAchievement(userId, achievementKey);
    if (!result.ok) {
      return res.status(400).json({ error: result.error });
    }

    return res.json({ ok: true, ...result.state });
  } catch (e: unknown) {
    console.error("[Gamification] achievement claim POST error", e);
    return res.status(500).json({ error: "Failed to claim achievement" });
  }
});

router.post("/track", async (req, res) => {
  try {
    const userId = await resolveUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const questKey =
      typeof req.body?.questKey === "string" ? req.body.questKey.trim() : "";
    if (!questKey) return res.status(400).json({ error: "Missing questKey" });

    const dateKey =
      typeof req.body?.dateKey === "string" && req.body.dateKey.trim()
        ? req.body.dateKey.trim()
        : localDateKey();

    const state = await trackClientQuest(userId, questKey, dateKey);
    if (!state) {
      return res.status(400).json({ error: "Quest cannot be tracked" });
    }

    return res.json({ ok: true, ...state });
  } catch (e: unknown) {
    console.error("[Gamification] track POST error", e);
    return res.status(500).json({ error: "Failed to track quest" });
  }
});

export default router;
