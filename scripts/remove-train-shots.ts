/**
 * Remove train library clips by strokeLabel (dry-run + confirm).
 *
 * Usage:
 *   pnpm exec tsx scripts/remove-train-shots.ts --dry-run
 *   pnpm exec tsx scripts/remove-train-shots.ts --confirm
 *   pnpm exec tsx scripts/remove-train-shots.ts --confirm --labels "Flat Serve,Slice Serve"
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "../src/db";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const XEVO_ROOT = path.resolve(__dirname, "../..");
const OUT_AUDIT = path.resolve(XEVO_ROOT, "shots-remove-serves-audit.json");

const DEFAULT_LABELS = ["Flat Serve", "Slice Serve"];

type Row = {
  train_video_id: string;
  stroke_label: string | null;
  stroke_name: string;
  stroke_preset: string;
  view_profile: string | null;
  sample_id: string | null;
  sample_status: string | null;
  emb_v2: number;
  emb_sam: number;
  disk_path: string | null;
  disk_exists: boolean;
};

function parseLabelsArg(): string[] {
  const idx = process.argv.indexOf("--labels");
  if (idx >= 0 && process.argv[idx + 1]) {
    return process.argv[idx + 1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return DEFAULT_LABELS;
}

async function fetchMatches(labels: string[]): Promise<Row[]> {
  const { rows } = await pool.query<Row>(
    `
    SELECT
      tv.id AS train_video_id,
      tv."strokeLabel" AS stroke_label,
      tv."strokeName" AS stroke_name,
      tv."strokePreset" AS stroke_preset,
      tvp."viewProfile" AS view_profile,
      ts.id AS sample_id,
      ts.status AS sample_status,
      COALESCE(emb.v2, 0)::int AS emb_v2,
      COALESCE(emb.sam, 0)::int AS emb_sam,
      tv."cloudinaryPublicId" AS disk_path,
      false AS disk_exists
    FROM train_video tv
    LEFT JOIN train_video_view_profile tvp ON tvp."trainVideoId" = tv.id
    LEFT JOIN train_sample ts ON ts."trainVideoId" = tv.id
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*) FILTER (WHERE "specVersion" = 'v2') AS v2,
        COUNT(*) FILTER (WHERE "specVersion" = 'sam_v1') AS sam
      FROM train_sample_embedding tse
      WHERE tse."trainSampleId" = ts.id
    ) emb ON true
    WHERE tv."strokeLabel" = ANY($1::text[])
       OR EXISTS (
         SELECT 1 FROM unnest($1::text[]) AS lbl(label)
         WHERE tv."strokeName" ILIKE lbl.label || '%'
       )
    ORDER BY tv."strokeLabel", tvp."viewProfile", tv.id
    `,
    [labels]
  );

  return rows.map((r) => ({
    ...r,
    disk_exists: Boolean(r.disk_path && fs.existsSync(r.disk_path)),
  }));
}

async function countRemaining(labels: string[]): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM train_video
     WHERE "strokeLabel" = ANY($1::text[])
        OR EXISTS (
          SELECT 1 FROM unnest($1::text[]) AS lbl(label)
          WHERE "strokeName" ILIKE lbl.label || '%'
        )`,
    [labels]
  );
  return rows[0]?.n ?? 0;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const confirm = process.argv.includes("--confirm");
  const labels = parseLabelsArg();

  if (!dryRun && !confirm) {
    console.log(`
Usage:
  pnpm exec tsx scripts/remove-train-shots.ts --dry-run
  pnpm exec tsx scripts/remove-train-shots.ts --confirm
  pnpm exec tsx scripts/remove-train-shots.ts --confirm --labels "Flat Serve,Slice Serve"
`);
    process.exit(1);
  }

  console.log(`Labels: ${labels.join(", ")}`);
  const rows = await fetchMatches(labels);

  const uniqueVideoIds = [...new Set(rows.map((r) => r.train_video_id))];
  const payload = {
    auditedAt: new Date().toISOString(),
    labels,
    train_videos: uniqueVideoIds.length,
    rows,
    disk_files_to_remove: rows
      .filter((r) => r.disk_exists && r.disk_path)
      .map((r) => r.disk_path),
  };

  fs.writeFileSync(OUT_AUDIT, JSON.stringify(payload, null, 2), "utf8");
  console.log(`Wrote ${OUT_AUDIT}`);
  console.log(`Found ${uniqueVideoIds.length} train_video row(s):\n`);

  for (const r of rows) {
    console.log(
      [
        r.stroke_label ?? "?",
        r.view_profile ?? "?",
        r.train_video_id.slice(0, 8),
        r.sample_status ?? "-",
        `v2=${r.emb_v2}`,
        `sam=${r.emb_sam}`,
        r.disk_exists ? "disk:yes" : "disk:no",
      ].join(" | ")
    );
  }

  if (dryRun) {
    console.log("\nDry run only — no deletes. Use --confirm to remove.");
    await pool.end();
    return;
  }

  let unlinked = 0;
  const paths = [...new Set(rows.map((r) => r.disk_path).filter(Boolean))] as string[];
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) {
        await fs.promises.unlink(p);
        unlinked++;
        console.log("Unlinked", p);
      }
    } catch (e) {
      console.warn("Failed to unlink", p, e);
    }
  }

  const del = await pool.query(
    `DELETE FROM train_video
     WHERE "strokeLabel" = ANY($1::text[])
        OR EXISTS (
          SELECT 1 FROM unnest($1::text[]) AS lbl(label)
          WHERE "strokeName" ILIKE lbl.label || '%'
        )
     RETURNING id`,
    [labels]
  );

  const remaining = await countRemaining(labels);
  console.log("\nDeleted train_video rows:", del.rowCount);
  console.log("Disk files removed:", unlinked);
  console.log("Remaining matching rows:", remaining);

  await pool.end();
  if (remaining > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
