import dotenv from "dotenv";
import pg from "pg";

dotenv.config();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const target = await pool.query(
  `SELECT id, "userId", status,
          metrics -> 'retrieval' -> 'neighbors' -> 0 ->> 'train_sample_id' AS pro,
          metrics ->> 'video_duration_ms' AS dur,
          metrics ->> 'total_frames' AS frames,
          "techniqueVideoId"
   FROM technique_analysis WHERE id LIKE '4491f6e9%' LIMIT 1`
);
console.log("target 4491f6e9:", JSON.stringify(target.rows[0] ?? null, null, 2));

if (target.rows[0]) {
  const s = await pool.query(
    `SELECT count(*)::int AS n FROM session WHERE "userId" = $1 AND "expiresAt" > NOW()`,
    [target.rows[0].userId]
  );
  console.log("live sessions for owner:", s.rows[0].n);
  const v = await pool.query(
    `SELECT "cloudinaryPublicId" FROM technique_video WHERE id = $1`,
    [target.rows[0].techniqueVideoId]
  );
  console.log("source video:", v.rows[0]?.cloudinaryPublicId ?? null);
}

const anySession = await pool.query(
  `SELECT count(*)::int AS n FROM session WHERE "expiresAt" > NOW()`
);
console.log("live sessions total:", anySession.rows[0].n);
await pool.end();
