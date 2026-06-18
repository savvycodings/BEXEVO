import express from "express";
import { randomUUID } from "crypto";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "../auth";
import { db, adminAccuracyTestRun } from "../db";
import { desc } from "drizzle-orm";
import {
  ACCURACY_TEST_CATALOG,
  getAccuracyTest,
  runAccuracyTest,
  runAllAccuracyTests,
} from "./tests";
import {
  BENCH_STEP_CATALOG,
  isBenchStepId,
  listBenchSubmissions,
  runBenchStep,
} from "./retrievalBench";
import { ACCURACY_PASS_PERCENT } from "./constants";

const router = express.Router();

const ADMIN_SECRET = () =>
  (process.env.ADMIN_TRAIN_SECRET || "xevodev").trim();

function assertAdminTrain(req: express.Request, res: express.Response): boolean {
  const expected = ADMIN_SECRET();
  const raw = req.headers["x-admin-train-secret"];
  const provided = typeof raw === "string" ? raw : raw?.[0] ?? "";
  if (!provided || provided !== expected) {
    res.status(403).json({ error: "Forbidden" });
    return false;
  }
  return true;
}

async function resolveUserId(req: express.Request): Promise<string | null> {
  const authSession = await auth.api
    .getSession({ headers: fromNodeHeaders(req.headers) })
    .catch(() => null);
  if (authSession?.user?.id) return authSession.user.id;

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

async function persistRun(
  testId: string,
  result: Awaited<ReturnType<typeof runAccuracyTest>>,
  userId: string | null
) {
  const id = randomUUID();
  await db.insert(adminAccuracyTestRun).values({
    id,
    testId,
    scorePercent: result.scorePercent,
    passed: result.passed,
    summary: result.summary,
    detail: result.detail,
    triggeredByUserId: userId,
  });
  return id;
}

router.get("/tests", async (req, res) => {
  if (!assertAdminTrain(req, res)) return;
  return res.json({
    passThresholdPercent: ACCURACY_PASS_PERCENT,
    tests: ACCURACY_TEST_CATALOG,
  });
});

router.get("/history", async (req, res) => {
  if (!assertAdminTrain(req, res)) return;
  const testId = typeof req.query.testId === "string" ? req.query.testId : undefined;
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));

  const rows = await db.query.adminAccuracyTestRun.findMany({
    ...(testId
      ? { where: (t, { eq: _eq }) => _eq(t.testId, testId) }
      : {}),
    orderBy: [desc(adminAccuracyTestRun.createdAt)],
    limit,
  });

  const latestByTest: Record<string, (typeof rows)[0]> = {};
  for (const row of rows) {
    if (!latestByTest[row.testId]) latestByTest[row.testId] = row;
  }

  return res.json({ runs: rows, latestByTest });
});

router.post("/run/:testId", async (req, res) => {
  try {
    if (!assertAdminTrain(req, res)) return;
    const userId = await resolveUserId(req);
    const { testId } = req.params;
    if (!testId || !getAccuracyTest(testId)) {
      return res.status(400).json({ error: "Unknown test id" });
    }
    const result = await runAccuracyTest(testId);
    const runId = await persistRun(testId, result, userId);
    return res.json({ runId, testId, ...result });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[AdminAccuracy] run error:", e);
    return res.status(500).json({ error: msg || "Test failed" });
  }
});

router.post("/run-all", async (req, res) => {
  try {
    if (!assertAdminTrain(req, res)) return;
    const userId = await resolveUserId(req);
    const results = await runAllAccuracyTests();
    const saved: { testId: string; runId: string; scorePercent: number; passed: boolean }[] =
      [];
    for (const { testId, result } of results) {
      const runId = await persistRun(testId, result, userId);
      saved.push({
        testId,
        runId,
        scorePercent: result.scorePercent,
        passed: result.passed,
      });
    }
    return res.json({ results: saved });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[AdminAccuracy] run-all error:", e);
    return res.status(500).json({ error: msg || "Run all failed" });
  }
});

router.get("/bench/steps", async (req, res) => {
  if (!assertAdminTrain(req, res)) return;
  return res.json({ passThresholdPercent: ACCURACY_PASS_PERCENT, steps: BENCH_STEP_CATALOG });
});

router.get("/bench/submissions", async (req, res) => {
  try {
    if (!assertAdminTrain(req, res)) return;
    const limit = Number(req.query.limit) || 50;
    const search = typeof req.query.search === "string" ? req.query.search : undefined;
    const items = await listBenchSubmissions({ limit, search });
    return res.json({ items });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[AdminAccuracy] bench submissions error:", e);
    return res.status(500).json({ error: msg || "Failed to load submissions" });
  }
});

router.post("/bench/run/:stepId", async (req, res) => {
  try {
    if (!assertAdminTrain(req, res)) return;
    const userId = await resolveUserId(req);
    const { stepId } = req.params;
    if (!stepId || !isBenchStepId(stepId)) {
      return res.status(400).json({ error: "Unknown bench step id" });
    }
    const body = (req.body ?? {}) as { analysisId?: string; blendMeshWeight?: number };
    const result = await runBenchStep(stepId, {
      analysisId: body.analysisId,
      blendMeshWeight: body.blendMeshWeight,
    });
    const runId = await persistRun(
      `bench_${stepId}`,
      {
        scorePercent: result.scorePercent,
        passed: result.passed,
        summary: result.summary,
        detail: {
          stepId: result.stepId,
          title: result.title,
          evidence: result.evidence,
          failures: result.failures,
          tables: result.tables,
          charts: result.charts,
        },
      },
      userId
    );
    return res.json({ runId, ...result });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[AdminAccuracy] bench run error:", e);
    return res.status(500).json({ error: msg || "Bench step failed" });
  }
});

export default router;
