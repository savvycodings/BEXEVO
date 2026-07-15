/**
 * List train shots and front/behind/side angle counts.
 * Usage: pnpm exec tsx scripts/list-train-angle-coverage.ts
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, "../../shots-angle-coverage.json");

type Row = {
  stroke_label: string;
  category: string;
  skill_level: string;
  front: number;
  behind: number;
  side: number;
  total_videos: number;
};

async function main() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 20_000,
    query_timeout: 60_000,
  });
  await client.connect();

  const { rows } = await client.query<Row>(`
    SELECT
      tv."strokeLabel" AS stroke_label,
      tv.category,
      tv."skillLevel" AS skill_level,
      COUNT(*) FILTER (WHERE tvp."viewProfile" = 'front')::int AS front,
      COUNT(*) FILTER (WHERE tvp."viewProfile" = 'behind')::int AS behind,
      COUNT(*) FILTER (WHERE tvp."viewProfile" = 'side')::int AS side,
      COUNT(tv.id)::int AS total_videos
    FROM train_video tv
    LEFT JOIN train_video_view_profile tvp ON tvp."trainVideoId" = tv.id
    WHERE tv."strokeLabel" IS NOT NULL
    GROUP BY tv."strokeLabel", tv.category, tv."skillLevel"
    ORDER BY tv.category, tv."strokeLabel", tv."skillLevel"
  `);

  const shots = rows.map((r) => {
    const missing = [
      r.front === 0 ? "front" : null,
      r.behind === 0 ? "behind" : null,
      r.side === 0 ? "side" : null,
    ].filter(Boolean) as string[];
    const angles_present = 3 - missing.length;
    return {
      stroke_label: r.stroke_label,
      category: r.category,
      skill_level: r.skill_level,
      front: r.front,
      behind: r.behind,
      side: r.side,
      total_videos: r.total_videos,
      angles_present,
      has_all_3: angles_present === 3,
      missing,
    };
  });

  const payload = {
    generatedAt: new Date().toISOString(),
    shot_count: shots.length,
    complete_all_3: shots.filter((s) => s.has_all_3).length,
    incomplete: shots.filter((s) => !s.has_all_3).length,
    shots,
  };

  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2), "utf8");

  console.log("status | label                        | skill        | F  B  S | total | missing | category");
  console.log("-".repeat(100));
  for (const s of shots) {
    const mark = s.has_all_3 ? "OK  " : "GAP ";
    console.log(
      `${mark} | ${s.stroke_label.padEnd(28)} | ${s.skill_level.padEnd(12)} | ${String(s.front).padStart(1)}  ${String(s.behind).padStart(1)}  ${String(s.side).padStart(1)} | ${String(s.total_videos).padStart(5)} | ${(s.missing.join(",") || "-").padEnd(20)} | ${s.category}`
    );
  }
  console.log("-".repeat(100));
  console.log(
    `SHOTS: ${payload.shot_count} | ALL_3_ANGLES: ${payload.complete_all_3} | GAPS: ${payload.incomplete}`
  );
  console.log("Wrote", OUT);

  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
