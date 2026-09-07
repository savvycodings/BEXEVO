/**
 * Resolution/length ladder for the Fun Control correction video.
 *
 * The render dials are read from process.env at request time, but the server process env is
 * fixed at boot, so each rung boots its own server on a spare port, forces one regeneration,
 * samples Comfy VRAM while it runs, then tears the server down.
 *
 * Usage: node scripts/funControlLadder.mjs [analysisId]
 */
import { spawn } from "child_process";
import dotenv from "dotenv";
import fs from "fs";
import http from "http";
import path from "path";
import pg from "pg";

dotenv.config();

const COMFY = process.env.COMFYUI_BASE_URL || "http://127.0.0.1:8188";
const PORT = 3060;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = path.join(process.cwd(), "..", "verify-out", "ladder");

const ALL_RUNGS = [
  { label: "624x768 / 33f", size: 768, length: 33 },
  { label: "736x896 / 33f", size: 896, length: 33 },
  { label: "848x1024 / 33f", size: 1024, length: 33 },
];
/** `--sizes=896,1024` reruns a subset without repeating rungs that already have numbers. */
const sizeFilter = process.argv
  .find((a) => a.startsWith("--sizes="))
  ?.slice("--sizes=".length)
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n));

function numArg(name) {
  const raw = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!raw) return null;
  const n = Number(raw.slice(name.length + 3));
  return Number.isFinite(n) ? n : null;
}

/** `--size=768 --length=17` runs a single ad-hoc rung, for checking one config end to end. */
const oneSize = numArg("size");
const oneLength = numArg("length");

const RUNGS = oneSize
  ? [{ label: `size ${oneSize} / ${oneLength ?? 33}f`, size: oneSize, length: oneLength ?? 33 }]
  : sizeFilter?.length
    ? ALL_RUNGS.filter((r) => sizeFilter.includes(r.size))
    : ALL_RUNGS;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Plain node:http rather than fetch. A large render holds the connection open for many
 * minutes and undici's default 300s headers timeout aborts it, which reads as a generation
 * failure when the render actually succeeded.
 */
function postJson(url, token, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const target = new URL(url);
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      }
    );
    req.setTimeout(0);
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function pickAnalysis(pool, wanted) {
  if (wanted) {
    const one = await pool.query(
      `SELECT a.id, a."userId" FROM technique_analysis a WHERE a.id LIKE $1 LIMIT 1`,
      [`${wanted}%`]
    );
    if (one.rows[0]) return one.rows[0];
  }
  // Any completed analysis that already has a retrieval neighbour, newest first.
  const rows = await pool.query(`
    SELECT id, "userId"
    FROM technique_analysis
    WHERE status = 'completed'
      AND metrics -> 'retrieval' -> 'neighbors' -> 0 -> 'train_sample_id' IS NOT NULL
    ORDER BY "createdAt" DESC
    LIMIT 1
  `);
  return rows.rows[0] ?? null;
}

async function sessionTokenFor(pool, userId) {
  const mine = await pool.query(
    `SELECT token FROM session WHERE "userId" = $1 AND "expiresAt" > NOW()
     ORDER BY "createdAt" DESC LIMIT 1`,
    [userId]
  );
  return mine.rows[0]?.token ?? null;
}

async function comfyVramUsedGb() {
  try {
    const res = await fetch(`${COMFY}/system_stats`);
    const json = await res.json();
    const dev = json.devices?.[0];
    if (!dev) return null;
    return (dev.vram_total - dev.vram_free) / 1024 ** 3;
  } catch {
    return null;
  }
}

function startServer(env) {
  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: process.cwd(),
    env: { ...process.env, ...env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines = [];
  const capture = (buf) => {
    const text = String(buf);
    lines.push(text);
    process.stdout.write(text.replace(/^/gm, "  | "));
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  return { child, lines };
}

async function waitForServer(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/technique/activities`, {
        headers: { Authorization: "Bearer probe" },
      });
      // Any HTTP answer, including 401, means the listener is up.
      if (res.status > 0) return true;
    } catch {
      /* not listening yet */
    }
    await sleep(1500);
  }
  return false;
}

async function runRung(rung, analysisId, token) {
  console.log(`\n=== ${rung.label} ===`);
  const env = {
    CORRECTION_CANVAS_SIZE: String(rung.size),
    CORRECTION_FUN_LENGTH: String(rung.length),
    // Generous, so a slow rung reports a real wall time instead of being killed.
    COMFYUI_TIMEOUT_MS: "1800000",
  };
  const { child, lines } = startServer(env);
  const up = await waitForServer();
  if (!up) {
    child.kill();
    return { ...rung, error: "server did not start" };
  }

  let peakVram = 0;
  const sampler = setInterval(async () => {
    const used = await comfyVramUsedGb();
    if (used && used > peakVram) peakVram = used;
  }, 2500);

  const t0 = Date.now();
  let status = 0;
  let payload = null;
  let error = null;
  try {
    const res = await postJson(`${BASE}/technique/correction-videos`, token, {
      analysisId,
      forceRegenerate: true,
    });
    status = res.status;
    try {
      payload = JSON.parse(res.text);
    } catch {
      error = res.text.slice(0, 400);
    }
  } catch (e) {
    error = e.message;
  }
  const elapsedMs = Date.now() - t0;
  clearInterval(sampler);
  // The route logs its success/error line before responding, but killing the child straight
  // after the fetch resolves loses the tail of the pipe. Give it a moment to flush.
  await sleep(1500);

  const log = lines.join("");
  const queue = log.match(/Fun Control queue \{[\s\S]{0,600}?\n\}/)?.[0] ?? null;
  const comfyMs = Number(log.match(/Fun Control done[\s\S]{0,400}?elapsedMs: (\d+)/)?.[1]) || null;

  // Copy the produced clip aside so rungs can be compared visually afterwards.
  let saved = null;
  if (payload?.video) {
    const src = path.join(process.cwd(), payload.video.replace(/^\//, ""));
    if (fs.existsSync(src)) {
      fs.mkdirSync(OUT_DIR, { recursive: true });
      saved = path.join(OUT_DIR, `${rung.size}-${rung.length}f.mp4`);
      fs.copyFileSync(src, saved);
    }
  }

  child.kill();
  await sleep(3000);

  return {
    ...rung,
    status,
    elapsedMs,
    comfyMs,
    peakVramGb: peakVram ? Number(peakVram.toFixed(1)) : null,
    window:
      payload?.windowStartMs != null
        ? `${Math.round(payload.windowStartMs)}-${Math.round(payload.windowEndMs)}ms`
        : null,
    saved,
    error: error ?? payload?.error ?? null,
    queue,
  };
}

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const wanted = process.argv[2]?.startsWith("--") ? undefined : process.argv[2];
  const analysis = await pickAnalysis(pool, wanted);
  if (!analysis) throw new Error("no usable analysis found");
  const token = await sessionTokenFor(pool, analysis.userId);
  await pool.end();
  if (!token) throw new Error(`no live session for user ${analysis.userId}`);
  console.log("analysis:", analysis.id, "user:", analysis.userId);

  const results = [];
  for (const rung of RUNGS) {
    results.push(await runRung(rung, analysis.id, token));
  }

  console.log("\n\n===== LADDER =====");
  for (const r of results) {
    console.log(
      [
        r.label.padEnd(16),
        `http ${r.status ?? "-"}`.padEnd(9),
        `wall ${r.elapsedMs ? (r.elapsedMs / 1000).toFixed(0) + "s" : "-"}`.padEnd(11),
        `comfy ${r.comfyMs ? (r.comfyMs / 1000).toFixed(0) + "s" : "-"}`.padEnd(12),
        `peakVram ${r.peakVramGb ?? "-"}GB`.padEnd(17),
        `window ${r.window ?? "-"}`.padEnd(20),
        r.error ? `ERR ${String(r.error).slice(0, 120)}` : "ok",
      ].join(" ")
    );
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "ladder.json"), JSON.stringify(results, null, 2));
  console.log("\nwrote", path.join(OUT_DIR, "ladder.json"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
