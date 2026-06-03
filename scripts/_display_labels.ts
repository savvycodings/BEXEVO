import dotenv from "dotenv";
import pg from "pg";
import { deriveHumanShotLabelFromMetrics } from "../src/train/trainShotDisplay";

dotenv.config();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const exampleIds = [
  "0d7313a7-b9ca-41ea-91ca-b9dc59775905",
  "ee64a055-068e-4d43-a555-452f977f0d58",
  "5a3c3f89-d5ef-44c5-902e-ca58468dabe3",
  "7ff40f54-570a-4fb6-a26c-97a4a532bc28",
  "6534b76c-d6f3-46f5-a91c-ce9ad4ee465e",
];

async function main() {
  const { rows } = await pool.query(
    `SELECT id, metrics FROM technique_analysis WHERE id = ANY($1::text[])`,
    [exampleIds]
  );
  console.log(
    JSON.stringify(
      rows.map((row) => ({
        id: row.id,
        shotLabel: deriveHumanShotLabelFromMetrics(row.metrics),
        hyp_label: row.metrics?.retrieval?.shot_hypothesis?.stroke_label ?? null,
        hyp_preset: row.metrics?.retrieval?.shot_hypothesis?.stroke_preset ?? null,
        hyp_conf: row.metrics?.retrieval?.shot_hypothesis?.confidence ?? null,
        shot_context: row.metrics?.ai_analysis?.en?.shot_context ?? null,
        correction_shot_name:
          row.metrics?.correction_context?.shot_and_handedness?.shot?.shot_name ??
          row.metrics?.correction_context_comfy?.shot_and_handedness?.shot?.shot_name ??
          null,
      })),
      null,
      2
    )
  );
  await pool.end();
}

main();
