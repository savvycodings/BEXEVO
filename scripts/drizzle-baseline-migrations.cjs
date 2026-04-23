/**
 * Mark historical Drizzle migrations as already applied (insert into drizzle.__drizzle_migrations)
 * without running their SQL. Use when the Neon DB was created outside `drizzle-kit migrate` so
 * `pnpm run db:migrate` would otherwise replay 0000 and fail on "relation already exists".
 *
 * Hashes match drizzle-orm readMigrationFiles: sha256 of the entire .sql file bytes (UTF-8).
 *
 * Usage (from server/):
 *   node scripts/drizzle-baseline-migrations.cjs --through 0023_ordinary_junta
 *
 * Then:
 *   pnpm run db:migrate
 *
 * Optional: only insert missing hashes (idempotent).
 */

require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Client } = require("pg");

function parseThroughTag() {
  const idx = process.argv.indexOf("--through");
  if (idx === -1 || !process.argv[idx + 1]) {
    console.error(
      'Missing --through <migration_tag>\nExample:\n  node scripts/drizzle-baseline-migrations.cjs --through 0023_ordinary_junta\n\nThis marks every journal entry up to and including that tag as applied.'
    );
    process.exit(1);
  }
  return process.argv[idx + 1].trim();
}

async function main() {
  const throughTag = parseThroughTag();
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }

  const drizzleDir = path.join(__dirname, "..", "drizzle");
  const journalPath = path.join(drizzleDir, "meta", "_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  const entries = journal.entries;
  const endIdx = entries.findIndex((e) => e.tag === throughTag);
  if (endIdx === -1) {
    console.error(`Tag "${throughTag}" not found in meta/_journal.json`);
    process.exit(1);
  }

  const toApply = entries.slice(0, endIdx + 1);
  const metas = toApply.map((entry) => {
    const filePath = path.join(drizzleDir, `${entry.tag}.sql`);
    const query = fs.readFileSync(filePath, "utf8");
    const hash = crypto.createHash("sha256").update(query).digest("hex");
    return { tag: entry.tag, when: entry.when, hash };
  });

  const client = new Client({ connectionString: url });
  await client.connect();

  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS "drizzle"`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )
    `);

    let inserted = 0;
    let skipped = 0;
    for (const m of metas) {
      const r = await client.query(
        `INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")
         SELECT $1::text, $2::bigint
         WHERE NOT EXISTS (SELECT 1 FROM "drizzle"."__drizzle_migrations" WHERE "hash" = $1)
         RETURNING id`,
        [m.hash, m.when]
      );
      if (r.rowCount) {
        inserted++;
        console.log("Inserted", m.tag, m.hash.slice(0, 12) + "…");
      } else {
        skipped++;
        console.log("Skip (already recorded)", m.tag);
      }
    }

    console.log(`\nDone. inserted=${inserted} skipped=${skipped}`);
    console.log("Next: pnpm run db:migrate");
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
