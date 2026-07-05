/** Run retrieval bench steps locally (same logic as admin curl). */
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { withNeonRetry } from "./_neon_retry.mjs";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const analysisId = process.env.ANALYSIS_ID ?? process.argv[2] ?? "";

const { runBenchStep } = await import("../src/adminAccuracy/retrievalBench.ts");

const steps = (process.env.BENCH_STEPS ?? "1_library_ready,5_analysis_audit")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const out = await withNeonRetry(async () => {
  const result = { queried_at: new Date().toISOString(), steps: {} };
  for (const stepId of steps) {
    const opts = stepId === "5_analysis_audit" && analysisId ? { analysisId } : undefined;
    result.steps[stepId] = await runBenchStep(stepId, opts);
  }
  return result;
});

const outPath = path.join(__dirname, "_e2e_bench_results.json");
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
