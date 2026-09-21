# Backend E2E tests

Real HTTP requests against a real running BEXevo server.

- `technique.flow.e2e.ts` — sign in → upload a video → analyze → read the analysis → confirm it
  shows up in `/activities` → (optional) generate Comfy correction images.
- `achievements.flow.e2e.ts` — every achievement in `gamification/definitions.ts`'
  `ACHIEVEMENT_KEYS`, seeded progressively from a clean two-account slate (a throwaway student +
  coach) and driven through the real `/gamification/state` and `/gamification/achievements/:key/claim`
  endpoints: locked → claimable → claimed, for all 22 keys, finishing with an audit that nothing
  was missed. It seeds the underlying DB rows directly (technique videos/analyses, coach reviews,
  friend links, login streak) rather than driving the real AI pipeline or 30 real days of
  logins — see the file's header comment for why, and `lib/achievementSeed.ts` for what each
  helper seeds. `gamification/achievementCatalogParity.test.ts` (a plain unit test, run by
  `pnpm test`, not part of this suite) separately guards that the server's key list and the
  FEXevo client catalog haven't drifted apart.

This is separate from the existing unit tests (`src/**/*.test.ts`, run by `pnpm test`) — those
test pure functions in isolation; this exercises the real routes, real DB, and (mostly) real
upstream services.

## Running

1. Start the server against a real database: `pnpm run dev` (or point `E2E_BASE_URL` at an
   already-running instance, e.g. staging).
2. In another terminal: `pnpm run test:e2e`

## Env vars

| Var | Default | Notes |
|---|---|---|
| `E2E_BASE_URL` | `http://localhost:3050` | |
| `E2E_TEST_EMAIL` | `e2e-bexevo@xevo.test` | auto-created via sign-up on first run, re-used after |
| `E2E_TEST_PASSWORD` | `E2E-test-password-1!` | |
| `E2E_ANALYZE_TIMEOUT_MS` | `120000` | `/analyze` is synchronous and blocks until the whole pipeline (pose + AI text) finishes |
| `E2E_INCLUDE_COMFY` | unset (skipped) | set to `1` to also call `/correction-images`, which needs a reachable Comfy instance behind the server's own `COMFYUI_BASE_URL` |

## What's real vs. fixture

- **Real**: Express routing, auth (better-auth sign-up/sign-in via cookie session), Postgres
  writes, multipart video upload + local storage, the full `/analyze` pipeline including its
  external calls.
- **Fixture**: the uploaded video is a synthetic 2s clip generated at test time via `ffmpeg`'s
  `testsrc` pattern (`lib/fixtureVideo.ts`) — no binary checked into git. It satisfies the
  MP4-container check on `/upload`; it does **not** contain a real human pose, so the analysis
  frequently comes back `status: 'failed'` (no pose found) rather than `'completed'`. The test
  asserts on either — the point of this suite is "the pipeline ran and returned a coherent
  result," not "the AI coach approved this specific swing." If you need a `'completed'` result
  end-to-end, swap in a real short swing clip locally and point `makeFixtureVideo` calls at it,
  or add a second, opt-in test that reads a real fixture file from disk.

## Known limitation: no mocking layer

`/analyze`, `/correction-images`, and `/correction-videos` call fal.ai, an LLM (Gemini), and Comfy
directly and inline — there's no injectable client/interface to swap in a stub. That means:

- Every full run of this suite costs real API usage and takes real wall-clock time (expect tens
  of seconds for `/analyze` alone).
- Output isn't deterministic run-to-run (LLM text, retrieval neighbors, etc. vary).

If you want a fast, deterministic, zero-cost suite to run on every PR, the real fix is extracting
those calls behind a small interface (`AnalysisProvider`, `CorrectionRenderer`, etc.) that this
suite can point at a fake implementation — that's a bigger refactor of `techniqueRouter.ts` /
`comfyCorrection.ts` / `comfyVideo.ts`, not something bolted on here. Until then, treat this
suite as a manual/nightly smoke test, not a required PR gate.
