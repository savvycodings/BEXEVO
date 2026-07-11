import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { ShotManifestEntry } from "./shotUploadMapping";
import {
  printTrainUploadAuthHelp,
  resolveTrainUploadAuth,
  resolveTrainUploadBaseUrl,
  type TrainUploadAuth,
} from "./train-upload-auth";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const XEVO_ROOT = path.resolve(__dirname, "../..");
const MANIFEST_JSON = path.resolve(XEVO_ROOT, "shots-upload-manifest.json");
const LOG_MD = path.resolve(XEVO_ROOT, "shots-upload-log.md");
const MAX_BYTES = 50 * 1024 * 1024;

type ManifestFile = {
  entries: ShotManifestEntry[];
};

type LogRow = {
  at: string;
  relativePath: string;
  httpStatus: number;
  ok: boolean;
  trainVideoId?: string;
  sampleId?: string;
  error?: string;
  skipped?: boolean;
  skipReason?: string;
};

function adminSecret(): string {
  return (process.env.ADMIN_TRAIN_SECRET || "xevodev").trim();
}

function authHeaders(auth: TrainUploadAuth): Record<string, string> {
  const h: Record<string, string> = {
    "X-Admin-Train-Secret": adminSecret(),
  };
  if (auth.authorization) h.Authorization = auth.authorization;
  if (auth.cookie) h.Cookie = auth.cookie;
  return h;
}

function loadManifest(): ManifestFile {
  if (!fs.existsSync(MANIFEST_JSON)) {
    throw new Error(`Missing ${MANIFEST_JSON} — run: pnpm exec tsx scripts/scan-shots-manifest.ts`);
  }
  return JSON.parse(fs.readFileSync(MANIFEST_JSON, "utf8")) as ManifestFile;
}

function loadCompletedPaths(): Set<string> {
  const done = new Set<string>();
  if (!fs.existsSync(LOG_MD)) return done;
  const text = fs.readFileSync(LOG_MD, "utf8");
  for (const line of text.split("\n")) {
    const m = line.match(/^\| [^|]+ \| `([^`]+)` \| .* \| (ok|skipped) \|/);
    if (m && (m[2] === "ok" || m[2] === "skipped")) done.add(m[1]);
  }
  return done;
}

function appendLogHeaderIfNeeded(): void {
  if (fs.existsSync(LOG_MD) && fs.statSync(LOG_MD).size > 0) return;
  const header = [
    "# Shots upload log",
    "",
    `Started: ${new Date().toISOString()}`,
    "",
    "| time | file | status | trainVideoId | sampleId | note |",
    "|------|------|--------|--------------|----------|------|",
    "",
  ].join("\n");
  fs.writeFileSync(LOG_MD, header, "utf8");
}

function appendLogRow(row: LogRow): void {
  appendLogHeaderIfNeeded();
  const status = row.skipped ? "skipped" : row.ok ? "ok" : "fail";
  const note = row.skipReason || row.error || "";
  const line = `| ${row.at} | \`${row.relativePath}\` | ${status} | ${row.trainVideoId ?? ""} | ${row.sampleId ?? ""} | ${note.replace(/\|/g, "\\|")} |`;
  fs.appendFileSync(LOG_MD, line + "\n", "utf8");
}

function curlExample(entry: ShotManifestEntry, url: string): string {
  const filePath = entry.filePath.replace(/\\/g, "/");
  return [
    `curl -X POST "${url}/api/auth/train/upload" \\`,
    `  -H "X-Admin-Train-Secret: ${adminSecret()}" \\`,
    `  -H "Authorization: Bearer $TRAIN_UPLOAD_SESSION_TOKEN" \\`,
    `  -F "category=${entry.category}" \\`,
    `  -F "strokePreset=${entry.strokePreset}" \\`,
    `  -F 'strokeLabel=${entry.strokeLabel}' \\`,
    `  -F "skillLevel=${entry.skillLevel}" \\`,
    `  -F "viewProfile=${entry.viewProfile}" \\`,
    `  -F "video=@${filePath};type=video/mp4"`,
  ].join("\n");
}

async function uploadOne(
  entry: ShotManifestEntry,
  auth: TrainUploadAuth,
  url: string
): Promise<LogRow> {
  const at = new Date().toISOString();
  if (entry.sizeBytes > MAX_BYTES) {
    return {
      at,
      relativePath: entry.relativePath,
      httpStatus: 0,
      ok: false,
      error: `File exceeds 50MB (${(entry.sizeBytes / 1024 / 1024).toFixed(1)} MB)`,
    };
  }

  const buf = fs.readFileSync(entry.filePath);
  const fileName = path.basename(entry.filePath);
  const form = new FormData();
  form.append("category", entry.category);
  form.append("strokePreset", entry.strokePreset);
  form.append("strokeLabel", entry.strokeLabel);
  form.append("skillLevel", entry.skillLevel);
  form.append("viewProfile", entry.viewProfile);
  form.append("video", new Blob([buf], { type: "video/mp4" }), fileName);

  const headers = authHeaders(auth);
  const res = await fetch(`${url}/api/auth/train/upload`, {
    method: "POST",
    headers,
    body: form,
  });

  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    data = { raw: text.slice(0, 500) };
  }

  const ok = res.ok && !data.error;
  return {
    at,
    relativePath: entry.relativePath,
    httpStatus: res.status,
    ok,
    trainVideoId: typeof data.id === "string" ? data.id : undefined,
    sampleId: typeof data.sampleId === "string" ? data.sampleId : undefined,
    error: ok
      ? entry.diagonalMappedToSide
        ? "diagonal folder → viewProfile side"
        : undefined
      : String(data.error ?? data.raw ?? res.statusText),
  };
}

/** Upload with one re-auth retry on 401 (session expired mid-batch). */
async function uploadOneWithAuthRetry(
  entry: ShotManifestEntry,
  auth: TrainUploadAuth,
  url: string,
  refreshAuth: () => Promise<TrainUploadAuth>
): Promise<{ row: LogRow; auth: TrainUploadAuth }> {
  let row = await uploadOne(entry, auth, url);
  if (row.httpStatus === 401) {
    console.warn("  Session expired (401) — re-signing in and retrying once…");
    const fresh = await refreshAuth();
    row = await uploadOne(entry, fresh, url);
    return { row, auth: fresh };
  }
  return { row, auth };
}

async function fetchCoverage(auth: TrainUploadAuth, url: string): Promise<unknown> {
  const res = await fetch(`${url}/api/auth/train/admin/pose-landmarks-coverage`, {
    headers: authHeaders(auth),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { status: res.status, raw: text.slice(0, 2000) };
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Usage:
  pnpm exec tsx scripts/upload-shots-batch.ts [--dry-run] [--help-auth] [--limit N] [--from N]

  --dry-run     Print curl commands only (no uploads)
  --help-auth   Print session env var options
  --limit N     Attempt at most N uploads this run (success or fail)
  --from N      Start at manifest index N (1-based)
  --force       Re-upload even if path already logged ok/skipped

Steps:
  1. pnpm exec tsx scripts/scan-shots-manifest.ts
  2. Set auth in server/.env (see --help-auth)
  3. pnpm exec tsx scripts/upload-shots-batch.ts --dry-run
  4. pnpm exec tsx scripts/upload-shots-batch.ts
`);
    return;
  }

  if (args.includes("--help-auth")) {
    printTrainUploadAuthHelp();
    return;
  }

  const dryRun = args.includes("--dry-run");
  const force = args.includes("--force");
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : undefined;
  const fromIdx = args.indexOf("--from");
  const from = fromIdx >= 0 ? Math.max(1, Number(args[fromIdx + 1])) : 1;

  const manifest = loadManifest();
  let entries = manifest.entries.map((e) => ({
    ...e,
    filePath: e.filePath || path.join(XEVO_ROOT, "shots", e.relativePath),
  }));

  const completed = force ? new Set<string>() : loadCompletedPaths();
  const url = dryRun
    ? (
        process.env.TRAIN_UPLOAD_BASE_URL ||
        process.env.BETTER_AUTH_URL ||
        "http://127.0.0.1:3050"
      ).replace(/\/+$/, "")
    : await resolveTrainUploadBaseUrl();

  if (!dryRun) {
    let auth = await resolveTrainUploadAuth(url);
    const refreshAuth = () => resolveTrainUploadAuth(url);
    console.log("Auth OK. Base URL:", url);
    console.log("Uploading", entries.length, "clips (sequential, blocks until Modal completes each)…\n");

    let attempts = 0;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (i + 1 < from) continue;
      if (limit != null && attempts >= limit) break;

      if (completed.has(entry.relativePath)) {
        console.log(`[skip] ${entry.relativePath} (already in log)`);
        appendLogRow({
          at: new Date().toISOString(),
          relativePath: entry.relativePath,
          httpStatus: 0,
          ok: true,
          skipped: true,
          skipReason: "already logged",
        });
        continue;
      }

      console.log(`[${i + 1}/${entries.length}] ${entry.relativePath} …`);
      attempts++;
      const { row, auth: nextAuth } = await uploadOneWithAuthRetry(entry, auth, url, refreshAuth);
      auth = nextAuth;
      appendLogRow(row);
      if (row.ok) {
        console.log(`  OK video=${row.trainVideoId} sample=${row.sampleId}`);
      } else {
        console.error(`  FAIL (${row.httpStatus}): ${row.error}`);
      }
    }

    console.log("\nFetching pose-landmarks-coverage…");
    const coverage = await fetchCoverage(auth, url);
    const coveragePath = path.resolve(XEVO_ROOT, "shots-upload-coverage.json");
    fs.writeFileSync(coveragePath, JSON.stringify(coverage, null, 2), "utf8");
    console.log("Wrote", coveragePath);

    appendLogHeaderIfNeeded();
    fs.appendFileSync(
      LOG_MD,
      `\n## Coverage snapshot ${new Date().toISOString()}\n\nSee \`shots-upload-coverage.json\`.\n`,
      "utf8"
    );
    return;
  }

  console.log(`Dry run — ${entries.length} curl commands (base: ${url})\n`);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (i + 1 < from) continue;
    if (limit != null && i - (from - 1) >= limit) break;
    console.log(`# ${i + 1} ${entry.relativePath}`);
    console.log(curlExample(entry, url));
    console.log("");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
