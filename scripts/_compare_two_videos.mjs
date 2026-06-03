import dotenv from "dotenv";
import pg from "pg";

dotenv.config();

const IDS = [
  "622056d0-1da6-407f-a273-ded9c4e9735a",
  "d6e63c01-969a-4811-b2ad-95d930864181",
];

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 15000,
  query_timeout: 60000,
});

async function main() {
  const { rows } = await pool.query(
    `
    SELECT
      ta.id AS analysis_id,
      ta."createdAt" AS analysis_at,
      ta."techniqueVideoId",
      tv."createdAt" AS video_uploaded_at,
      tv."cloudinaryPublicId",
      tv."cloudinaryUrl",
      tv."secureUrl",
      tv.bytes,
      tv.format,
      ta.metrics->>'total_frames' AS total_frames,
      ta.metrics->>'analyzed_frames' AS analyzed_frames,
      ta.metrics->'retrieval'->'shot_hypothesis'->>'stroke_label' AS stroke_label,
      ta.metrics->'correction_context'->'frame_indices' AS correction_frame_indices,
      ta.metrics->'user_clips' AS user_clips,
      ta.metrics->>'video_duration_ms' AS video_duration_ms
    FROM technique_analysis ta
    JOIN technique_video tv ON tv.id = ta."techniqueVideoId"
    WHERE ta.id = ANY($1::text[])
    ORDER BY ta."createdAt" ASC
    `,
    [IDS]
  );

  const sameVideo =
    rows.length === 2 && rows[0].techniqueVideoId === rows[1].techniqueVideoId;
  const sameCloudinary =
    rows.length === 2 &&
    rows[0].cloudinaryPublicId === rows[1].cloudinaryPublicId;
  const sameFrames =
    rows.length === 2 && rows[0].total_frames === rows[1].total_frames;

  console.log(
    JSON.stringify(
      {
        same_technique_video_id: sameVideo,
        same_cloudinary_asset: sameCloudinary,
        same_total_frames: sameFrames,
        rows,
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
