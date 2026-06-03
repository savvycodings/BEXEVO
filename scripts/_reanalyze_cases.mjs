/**
 * Re-run POST /technique/analyze for v9 Case A–D videos (creates new analysis rows).
 * Requires: server on :3050, MODAL_WEBHOOK_URL, video files on disk, valid owner session.
 */
import dotenv from "dotenv";
import pg from "pg";
import fs from "fs";

dotenv.config();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const CASE_IDS = [
  "0d7313a7-b9ca-41ea-91ca-b9dc59775905",
  "ee64a055-068e-4d43-a555-452f977f0d58",
  "5a3c3f89-d5ef-44c5-902e-ca58468dabe3",
  "6534b76c-d6f3-46f5-a91c-ce9ad4ee465e",
];

const BASE = (process.env.PUBLIC_BASE_URL || "http://127.0.0.1:3050").replace(/\/$/, "");
const ANALYZE_TIMEOUT_MS = 15 * 60 * 1000;

async function sessionForUser(userId) {
  const { rows } = await pool.query(
    `SELECT token FROM session
     WHERE "userId" = $1 AND "expiresAt" > NOW()
     ORDER BY "createdAt" DESC LIMIT 1`,
    [userId]
  );
  return rows[0]?.token ?? null;
}

async function main() {
  const { rows } = await pool.query(
    `SELECT ta.id AS old_analysis_id, ta."userId", ta."techniqueVideoId", ta.metrics,
            tv."cloudinaryPublicId" AS video_path
     FROM technique_analysis ta
     JOIN technique_video tv ON tv.id = ta."techniqueVideoId"
     WHERE ta.id = ANY($1::text[])`,
    [CASE_IDS]
  );

  const results = [];

  for (const row of rows) {
    const metrics = row.metrics ?? {};
    const clips = metrics.user_clips;
    const videoDurationMs = metrics.video_duration_ms;
    const token = await sessionForUser(row.userId);

    if (!token) {
      results.push({
        old_analysis_id: row.old_analysis_id,
        error: "no_session_for_user",
        userId: row.userId,
      });
      continue;
    }

    const videoPath = row.video_path;
    if (videoPath && !fs.existsSync(videoPath)) {
      results.push({
        old_analysis_id: row.old_analysis_id,
        error: "video_missing_on_disk",
        videoPath,
      });
      continue;
    }

    const body = {
      techniqueVideoId: row.techniqueVideoId,
      ...(Array.isArray(clips) && clips.length ? { clips, videoDurationMs } : {}),
    };

    console.log("[reanalyze] starting", row.old_analysis_id, "video", row.techniqueVideoId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ANALYZE_TIMEOUT_MS);

    let res;
    try {
      res = await fetch(`${BASE}/technique/analyze`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      results.push({
        old_analysis_id: row.old_analysis_id,
        error: e instanceof Error ? e.message : String(e),
      });
      continue;
    }
    clearTimeout(timer);

    const text = await res.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text.slice(0, 500) };
    }

    const newId = payload?.analysisId ?? null;
    let status = null;
    if (newId) {
      const st = await pool.query(
        `SELECT status,
                metrics->'retrieval'->>'spec_version' AS spec_version,
                metrics->'retrieval'->'shot_hypothesis' AS hyp
         FROM technique_analysis WHERE id = $1`,
        [newId]
      );
      status = st.rows[0] ?? null;
    }

    results.push({
      old_analysis_id: row.old_analysis_id,
      new_analysis_id: newId,
      httpStatus: res.status,
      userId: row.userId,
      techniqueVideoId: row.techniqueVideoId,
      analyzeResponse: payload,
      dbStatus: status,
    });
    console.log("[reanalyze] done", row.old_analysis_id, "->", newId, res.status);
  }

  const outPath = new URL("./_reanalyze_results.json", import.meta.url);
  fs.writeFileSync(outPath, JSON.stringify({ base: BASE, results }, null, 2));
  console.log("wrote", outPath.pathname || outPath);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
