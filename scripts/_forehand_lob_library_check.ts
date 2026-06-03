import dotenv from "dotenv";
import pg from "pg";

dotenv.config();

const ANALYSIS_IDS = [
  "622056d0-1da6-407f-a273-ded9c4e9735a",
  "d6e63c01-969a-4811-b2ad-95d930864181",
];

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 15000,
});

async function lobTrainCatalog() {
  const { rows } = await pool.query(`
    SELECT
      tv.id AS train_video_id,
      tv."strokeName",
      tv."strokeLabel",
      tv."strokePreset"::text AS stroke_preset,
      tv.category::text AS category,
      tv."skillLevel"::text AS skill_level,
      ts.id AS train_sample_id,
      ts.status,
      ts."frameCount",
      ts."totalFrames",
      tse."specVersion" AS emb_spec,
      ts."extractionMeta"->'normalized_label' AS normalized_label,
      ts."extractionMeta"->'yolo_summary'->>'detected_frames' AS yolo_detected
    FROM train_video tv
    LEFT JOIN train_sample ts ON ts."trainVideoId" = tv.id
    LEFT JOIN train_sample_embedding tse ON tse."trainSampleId" = ts.id
    WHERE tv."strokePreset"::text = 'forehand_lob'
       OR tv."strokeLabel" ILIKE '%lob%'
       OR tv."strokeName" ILIKE '%lob%'
    ORDER BY tv."strokePreset", tv."strokeLabel", tv."createdAt" DESC
  `);

  const v2 = rows.filter((r) => r.emb_spec === "v2" && r.status === "completed");
  const byPreset = new Map<string, number>();
  for (const r of rows) {
    const k = `${r.stroke_preset}|${r.stroke_label ?? r.strokeName}`;
    byPreset.set(k, (byPreset.get(k) ?? 0) + 1);
  }

  return {
    total_rows: rows.length,
    with_v2_embedding: v2.length,
    by_label: Object.fromEntries(byPreset),
    samples: v2.map((r) => ({
      train_video_id: r.train_video_id,
      train_sample_id: r.train_sample_id,
      stroke_label: r.strokeLabel ?? r.strokeName,
      stroke_preset: r.stroke_preset,
      category: r.category,
      skill_level: r.skill_level,
      frameCount: r.frameCount,
      totalFrames: r.totalFrames,
      normalized_label: r.normalized_label,
      yolo_detected: r.yolo_detected,
    })),
  };
}

function rankLobNeighbors(
  neighbors: Array<{
    stroke_label: string;
    stroke_preset: string;
    distance: number;
  }>
) {
  const lobRows = neighbors
    .map((n, i) => ({ rank: i + 1, ...n }))
    .filter(
      (n) =>
        n.stroke_preset === "forehand_lob" ||
        (n.stroke_label?.toLowerCase().includes("lob") ?? false)
    );
  const forehandLobExact = neighbors.findIndex(
    (n) =>
      n.stroke_preset === "forehand_lob" ||
      n.stroke_label?.toLowerCase() === "forehand lob"
  );
  return {
    forehand_lob_rank: forehandLobExact >= 0 ? forehandLobExact + 1 : null,
    forehand_lob_distance:
      forehandLobExact >= 0 ? neighbors[forehandLobExact]!.distance : null,
    lob_related_in_top20: lobRows.slice(0, 10),
    top8: neighbors.slice(0, 8).map((n, i) => ({
      rank: i + 1,
      stroke_label: n.stroke_label,
      stroke_preset: n.stroke_preset,
      distance: Math.round(n.distance * 10000) / 10000,
    })),
  };
}

async function queryAnalysisRetrieval(
  analysisId: string,
  deps: {
    embedPoseForProRetrieval: (m: unknown) => number[] | null;
    findNearestTrainNeighbors: (q: number[], k: number) => Promise<
      Array<{ stroke_label: string; stroke_preset: string; distance: number }>
    >;
    selectLandmarksForRetrievalEmbedding: (input: unknown) => FrameLandmarks | null;
  }
) {
  const { rows } = await pool.query(
    `SELECT id, metrics FROM technique_analysis WHERE id = $1`,
    [analysisId]
  );
  const row = rows[0];
  if (!row) return { error: "not_found" };

  const metrics = row.metrics ?? {};
  const stored = metrics.retrieval?.neighbors?.slice?.(0, 8) ?? null;

  let live: ReturnType<typeof rankLobNeighbors> | { error: string } | null = null;
  try {
    const vec = deps.embedPoseForProRetrieval(metrics);
    if (!vec) {
      live = { error: "no_embedding_from_metrics" };
    } else {
      const neighbors = await deps.findNearestTrainNeighbors(vec, 20);
      live = rankLobNeighbors(neighbors);
    }
  } catch (e) {
    live = { error: e instanceof Error ? e.message : String(e) };
  }

  const impactFrame =
    metrics.impact_pose_sequence?.find((p: { phase: string }) => p.phase === "impact")
      ?.frame ?? null;

  const pd = metrics.pose_data as Array<{ frame: number; landmarks: FrameLandmarks }> | undefined;
  const impactLm =
    pd?.find((p) => p.frame === impactFrame)?.landmarks ??
    deps.selectLandmarksForRetrievalEmbedding({
      mode: "technique",
      pose_data: pd,
      impact_pose_sequence: metrics.impact_pose_sequence,
      user_clips: metrics.user_clips,
      video_duration_ms: metrics.video_duration_ms,
      total_frames: metrics.total_frames,
    });

  let altAt92: ReturnType<typeof rankLobNeighbors> | null = null;
  if (pd?.length && metrics.total_frames) {
    const lm92 = pd.find((p) => p.frame === 92)?.landmarks;
    if (lm92) {
      const altMetrics = {
        ...metrics,
        impact_pose_sequence: [
          { phase: "preparation", frame: 91, landmarks: pd.find((p) => p.frame === 91)?.landmarks },
          { phase: "impact", frame: 92, landmarks: lm92 },
          { phase: "follow_through", frame: 93, landmarks: pd.find((p) => p.frame === 93)?.landmarks },
        ].filter((x) => x.landmarks),
        user_clips: [{ startMs: 838, endMs: 1732 }],
      };
      const v = deps.embedPoseForProRetrieval(altMetrics);
      if (v) altAt92 = rankLobNeighbors(await deps.findNearestTrainNeighbors(v, 20));
    }
  }

  return {
    analysis_id: analysisId,
    user_clips: metrics.user_clips,
    impact_frame: impactFrame,
    stroke_label_stored: metrics.retrieval?.shot_hypothesis?.stroke_label,
    stored_neighbors_top5: stored?.slice(0, 5)?.map((n: { stroke_label: string; distance: number; stroke_preset: string }) => ({
      stroke_label: n.stroke_label,
      stroke_preset: n.stroke_preset,
      distance: n.distance,
    })),
    live_knn_v2: live,
    hypothetical_frame92_knn: altAt92,
  };
}

async function main() {
  const { embedPoseForProRetrieval, selectLandmarksForRetrievalEmbedding, POSE_EMBEDDING_SPEC_VERSION } =
    await import("../src/technique/poseEmbedding");
  const { findNearestTrainNeighbors } = await import("../src/technique/trainRetrieval");
  type FrameLandmarks = import("../src/technique/correctionPrompt").FrameLandmarks;

  console.log(
    JSON.stringify(
      {
        spec_version: POSE_EMBEDDING_SPEC_VERSION,
        train_library_forehand_lob: await lobTrainCatalog(),
        analyses: await Promise.all(
          ANALYSIS_IDS.map((id) =>
            queryAnalysisRetrieval(id, {
              embedPoseForProRetrieval,
              findNearestTrainNeighbors,
              selectLandmarksForRetrievalEmbedding,
            })
          )
        ),
      },
      null,
      2
    )
  );
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
