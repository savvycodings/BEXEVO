# Admin accuracy tests

Clickable checks in **Admin → Training accuracy** mirror the investigation scripts under `server/scripts/`.

| Test id | Scripts |
|---------|---------|
| `recent_uploads` | `_recent_submissions.mjs` |
| `hypothesis_vs_neighbor` | `_dist_to_forehand_lob.mjs` (neighbor vs stored winner) |
| `display_vs_suggestion` | `_curl_recent_two.mjs` |
| `train_coverage` | `audit_retrieval_coverage.mjs` |

Runs are stored in `admin_accuracy_test_run` (migration `0031`). Green liquid = score ≥ 60%.

Apply migration: `cd server && pnpm db:migrate`
