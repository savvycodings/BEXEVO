import dotenv from "dotenv";
import pg from "pg";
import fs from "fs";

dotenv.config();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const FLAGGED_IDS = [
  "0d7313a7-b9ca-41ea-91ca-b9dc59775905",
  "ee64a055-068e-4d43-a555-452f977f0d58",
  "5a3c3f89-d5ef-44c5-902e-ca58468dabe3",
  "6534b76c-d6f3-46f5-a91c-ce9ad4ee465e",
];

async function main() {
  const owners = await pool.query(
    `SELECT id, "userId", "techniqueVideoId", status
     FROM technique_analysis
     WHERE id = ANY($1::text[])`,
    [FLAGGED_IDS]
  );

  const ownerIds = [...new Set(owners.rows.map((r) => r.userId).filter(Boolean))];
  let token = null;
  let tokenUserId = null;

  if (ownerIds.length > 0) {
    const sessions = await pool.query(
      `SELECT token, "userId", "expiresAt"
       FROM session
       WHERE "expiresAt" > NOW() AND "userId" = ANY($1::text[])
       ORDER BY "createdAt" DESC
       LIMIT 1`,
      [ownerIds]
    );
    token = sessions.rows[0]?.token ?? null;
    tokenUserId = sessions.rows[0]?.userId ?? null;
  }

  if (!token) {
    const fallback = await pool.query(`
      SELECT token, "userId", "expiresAt"
      FROM session
      WHERE "expiresAt" > NOW()
      ORDER BY "createdAt" DESC
      LIMIT 1
    `);
    token = fallback.rows[0]?.token ?? null;
    tokenUserId = fallback.rows[0]?.userId ?? null;
  }

  const curlResults = [];

  if (token) {
    for (const id of FLAGGED_IDS) {
      const ownerRow = owners.rows.find((r) => r.id === id);
      let rowToken = token;
      if (ownerRow?.userId && ownerRow.userId !== tokenUserId) {
        const perUser = await pool.query(
          `SELECT token FROM session
           WHERE "userId" = $1 AND "expiresAt" > NOW()
           ORDER BY "createdAt" DESC LIMIT 1`,
          [ownerRow.userId]
        );
        rowToken = perUser.rows[0]?.token ?? token;
      }

      const headers = { Authorization: `Bearer ${rowToken}` };
      const base = "http://127.0.0.1:3050";

      const analysisRes = await fetch(`${base}/technique/analysis/${id}`, { headers });
      const analysisStatus = analysisRes.status;
      let analysisPayload = null;
      if (analysisRes.ok) {
        analysisPayload = await analysisRes.json();
      }

      const corrRes = await fetch(`${base}/technique/analysis/${id}/correction-images`, { headers });
      const corrStatus = corrRes.status;
      let corrPayload = null;
      if (corrRes.ok) {
        corrPayload = await corrRes.json();
      }

      curlResults.push({
        id,
        analysisStatus,
        corrStatus,
        hyp: analysisPayload?.metrics?.retrieval?.shot_hypothesis ?? null,
        shot_context: analysisPayload?.metrics?.ai_analysis?.en?.shot_context ?? null,
        correction_shot:
          corrPayload?.correction_context_comfy?.shot_and_handedness?.shot ??
          corrPayload?.correction_context?.shot_and_handedness?.shot ??
          null,
      });
    }

    const actRes = await fetch("http://localhost:3050/technique/activities", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const activitiesStatus = actRes.status;
    let activitiesForFlagged = [];
    if (actRes.ok) {
      const all = await actRes.json();
      activitiesForFlagged = (Array.isArray(all) ? all : [])
        .filter((a) => FLAGGED_IDS.includes(a.analysisId))
        .map((a) => ({ analysisId: a.analysisId, shotLabel: a.shotLabel }));
    }

    fs.writeFileSync(
      new URL("./_curl_verify.json", import.meta.url),
      JSON.stringify(
        {
          tokenUsed: !!token,
          tokenUserId,
          ownerIds,
          owners: owners.rows,
          activitiesStatus,
          activitiesForFlagged,
          curlResults,
        },
        null,
        2
      )
    );
  } else {
    fs.writeFileSync(
      new URL("./_curl_verify.json", import.meta.url),
      JSON.stringify({ error: "No valid session token in DB", sessions: sessions.rows.length }, null, 2)
    );
  }

  console.log("curl verify written", FLAGGED_IDS.length, "analyses");
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
