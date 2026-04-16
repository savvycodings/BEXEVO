# Xevo API server

## Local development

From this directory:

```bash
pnpm install
pnpm run dev
```

`pnpm run dev` runs a one-shot `tsc` build, then starts `tsc --watch` and `nodemon` together. The initial build avoids a race where `nodemon` started before `dist/index.js` existed.

- **Entry:** compiled output is `dist/index.js` (see `tsconfig.json` `outDir`).
- **Nodemon:** reads `nodemon.json` in this folder; it watches `dist/` only and runs `node dist/index.js` when output changes.

Production-style run after a full compile:

```bash
pnpm run build
pnpm start
```

## Database schema updates

If Postgres returns `column "areaLocation" does not exist` (or similar) after pulling new code, the ORM schema is ahead of your database.

- **Typical dev fix:** from `server/`, with `DATABASE_URL` set in `.env`, run:

  `pnpm exec drizzle-kit push`

  That compares `src/db/schema.ts` to the live database and applies only the delta.

- **If `pnpm run db:migrate` fails** on `relation "account" already exists`, your database was not created purely from the Drizzle migration journal (common for older sandboxes). Prefer `drizzle-kit push` for local dev, or run the new migration SQL manually (e.g. `drizzle/0020_user_profile_area_location.sql`) in `psql`.

## Environment

Copy and edit `.env` (not committed). Required variables depend on which routes you exercise; see `src/auth.ts`, `src/technique/techniqueRouter.ts`, and `src/index.ts` for reads of `process.env`.
