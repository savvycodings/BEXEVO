/**
 * Re-run Modal pose extraction (now with player-crop) for existing pro-library clips, in
 * small chunks so progress is visible and one failure doesn't sink the whole run.
 *
 * Reads sample ids from scripts/_reextract_ids.json (clips whose source file is present on
 * THIS machine). Auth + base URL reuse the train-upload helpers.
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  resolveTrainUploadAuth,
  resolveTrainUploadBaseUrl,
  type TrainUploadAuth,
} from "./train-upload-auth";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IDS_FILE = path.resolve(__dirname, "_reextract_ids.json");
const CHUNK = Number(process.env.REEXTRACT_CHUNK || 5);

function adminSecret(): string {
  return (process.env.ADMIN_TRAIN_SECRET || "xevodev").trim();
}

function headers(auth: TrainUploadAuth): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Admin-Train-Secret": adminSecret(),
  };
  if (auth.authorization) h.Authorization = auth.authorization;
  if (auth.cookie) h.Cookie = auth.cookie;
  return h;
}

async function main() {
  const ids: string[] = JSON.parse(fs.readFileSync(IDS_FILE, "utf8"));
  console.log(`Re-extracting ${ids.length} clips in chunks of ${CHUNK}…`);

  const base = await resolveTrainUploadBaseUrl();
  const auth = await resolveTrainUploadAuth(base);
  console.log("Base:", base);

  let processed = 0;
  let failed = 0;
  const allFailures: Array<{ sampleId: string; error: string }> = [];

  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const label = `[${i + 1}-${i + chunk.length}/${ids.length}]`;
    const t0 = Date.now();
    try {
      const res = await fetch(`${base}/api/auth/train/reextract`, {
        method: "POST",
        headers: headers(auth),
        body: JSON.stringify({ ids: chunk }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        processed?: number;
        failed?: number;
        failures?: Array<{ sampleId: string; error: string }>;
        error?: string;
      };
      if (!res.ok) {
        console.error(`${label} HTTP ${res.status}: ${data.error ?? "error"}`);
        failed += chunk.length;
        continue;
      }
      processed += data.processed ?? 0;
      failed += data.failed ?? 0;
      if (data.failures?.length) allFailures.push(...data.failures);
      console.log(
        `${label} ok processed=${data.processed ?? 0} failed=${data.failed ?? 0} (${((Date.now() - t0) / 1000).toFixed(0)}s)`
      );
    } catch (e) {
      failed += chunk.length;
      console.error(`${label} EXCEPTION:`, e instanceof Error ? e.message : e);
    }
  }

  console.log(`\nDONE processed=${processed} failed=${failed}`);
  if (allFailures.length) {
    console.log("Failures (first 25):");
    for (const f of allFailures.slice(0, 25)) console.log(`  ${f.sampleId}: ${f.error}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
