import "dotenv/config";
import { runBenchStep } from "../src/adminAccuracy/retrievalBench";
import { pool } from "../src/db";

async function main() {
  const loocv = await runBenchStep("2_loocv");
  console.log("=== LOOCV ===");
  console.log("score%:", loocv.scorePercent, "|", loocv.summary);
  const byShot = (loocv.tables as any)?.by_shot ?? [];
  for (const r of byShot.sort((a: any, b: any) => a.top1_pct - b.top1_pct)) {
    console.log(
      `  ${String(r.label).padEnd(26)} top1 ${String(r.top1_pct).padStart(3)}%  top3 ${String(r.top3_pct).padStart(3)}%  (n=${r.total})`
    );
  }
  const fails = (loocv.failures ?? []) as any[];
  console.log(`\nFAILURES (${fails.length}):`);
  for (const f of fails.slice(0, 40)) {
    console.log(`  ${f.id}: ${f.reason}`, f.used ? JSON.stringify(f.used) : "");
  }
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
