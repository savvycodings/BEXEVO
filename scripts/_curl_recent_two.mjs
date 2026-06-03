import dotenv from "dotenv";
import pg from "pg";
import fs from "fs";

dotenv.config();

const RECENT_IDS = process.argv.slice(2);
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 15000,
});

const API_BASE = (process.env.API_BASE || "http://127.0.0.1:3050").replace(/\/+$/, "");

async function getTokenForUser(userId) {
  const { rows } = await pool.query(
    `SELECT token FROM session
     WHERE "userId" = $1 AND "expiresAt" > NOW()
     ORDER BY "createdAt" DESC LIMIT 1`,
    [userId]
  );
  return rows[0]?.token ?? null;
}

async function main() {
  let ids = RECENT_IDS;
  if (ids.length === 0) {
    const { rows } = await pool.query(`
      SELECT id, "userId"
      FROM technique_analysis_overview
      ORDER BY "createdAt" DESC
      LIMIT 2
    `);
    ids = rows.map((r) => r.id);
  }

  const owners = await pool.query(
    `SELECT id, "userId", status, "createdAt",
            "strokeLabel", "retrievalConfidence", "strokePreset", category, "skillLevel",
            "correctionContext"
     FROM technique_analysis_overview
     WHERE id = ANY($1::text[])`,
    [ids]
  );

  const userId = owners.rows[0]?.userId;
  const token = userId ? await getTokenForUser(userId) : null;

  const curlResults = [];
  if (token) {
    const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
    for (const row of owners.rows) {
      const id = row.id;
      const analysisRes = await fetch(`${API_BASE}/technique/analysis/${id}`, { headers });
      const corrRes = await fetch(`${API_BASE}/technique/analysis/${id}/correction-images`, {
        headers,
      });
      let analysisPayload = null;
      let corrPayload = null;
      if (analysisRes.ok) analysisPayload = await analysisRes.json();
      if (corrRes.ok) corrPayload = await corrRes.json();

      const frames = corrPayload?.correction_context?.frames ?? [];
      curlResults.push({
        id,
        analysisStatus: analysisRes.status,
        corrStatus: corrRes.status,
        hyp: analysisPayload?.metrics?.retrieval?.shot_hypothesis ?? null,
        top_neighbors: analysisPayload?.metrics?.retrieval?.top_neighbors?.slice?.(0, 3) ?? null,
        shot_context: analysisPayload?.metrics?.ai_analysis?.en?.shot_context ?? null,
        score: analysisPayload?.metrics?.ai_analysis?.score ?? null,
        correction_shot:
          corrPayload?.correction_context?.shot_and_handedness?.shot ?? null,
        frame_insights: frames.map((f) => ({
          frame: f.frame,
          label: f.label,
          pro_match: f.stats?.pro_match,
          summary: f.summary?.slice?.(0, 120),
        })),
      });
    }

    const actRes = await fetch(`${API_BASE}/technique/activities`, { headers });
    let activities = [];
    if (actRes.ok) {
      const all = await actRes.json();
      activities = (Array.isArray(all) ? all : [])
        .filter((a) => ids.includes(a.analysisId))
        .map((a) => ({
          analysisId: a.analysisId,
          shotLabel: a.shotLabel,
          createdAt: a.createdAt,
        }));
    }

    const out = {
      api_base: API_BASE,
      tokenUsed: true,
      userId,
      db_overview: owners.rows.map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        strokeLabel: r.strokeLabel,
        retrievalConfidence: r.retrievalConfidence,
        strokePreset: r.strokePreset,
        category: r.category,
        skillLevel: r.skillLevel,
        correction_shot:
          r.correctionContext?.shot_and_handedness?.shot?.shot_name ?? null,
        frame_insights_n: Array.isArray(r.correctionContext?.frames)
          ? r.correctionContext.frames.length
          : 0,
      })),
      activitiesStatus: actRes.status,
      activities,
      curlResults,
    };

    const path = new URL("./_curl_recent_two.json", import.meta.url);
    fs.writeFileSync(path, JSON.stringify(out, null, 2));
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log(
      JSON.stringify(
        { error: "no_session_token", db_overview: owners.rows },
        null,
        2
      )
    );
  }

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
