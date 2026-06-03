import dotenv from "dotenv";
import pg from "pg";

dotenv.config();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const ext = await pool.query(
    `SELECT extname FROM pg_extension WHERE extname = 'vector'`
  );
  const emb = await pool.query(
    `SELECT "specVersion", COUNT(*)::int AS n FROM train_sample_embedding GROUP BY 1 ORDER BY 1`
  );
  const total = await pool.query(`SELECT COUNT(*)::int AS n FROM train_sample_embedding`);
  const migrations = await pool.query(
    `SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 3`
  ).catch(() => ({ rows: [] }));
  console.log(
    JSON.stringify(
      {
        vector_extension: ext.rows[0]?.extname ?? null,
        train_sample_embedding_total: total.rows[0]?.n ?? 0,
        by_spec_version: emb.rows,
        latest_migrations: migrations.rows,
      },
      null,
      2
    )
  );
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
