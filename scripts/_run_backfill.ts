import "dotenv/config";
import { runTrainEmbeddingBackfill } from "../src/technique/trainRetrieval";
import { POSE_EMBEDDING_SPEC_VERSION } from "../src/technique/poseEmbedding";

async function main() {
  const out = await runTrainEmbeddingBackfill();
  console.log(
    JSON.stringify({ ok: true, specVersion: POSE_EMBEDDING_SPEC_VERSION, ...out }, null, 2)
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
