import "dotenv/config";
import { runTrainEmbeddingBackfill } from "../src/technique/trainRetrieval";
import { MESH_EMBEDDING_SPEC_VERSION } from "../src/technique/meshEmbedding";

async function main() {
  const out = await runTrainEmbeddingBackfill();
  console.log(
    JSON.stringify(
      { ok: true, samSpecVersion: MESH_EMBEDDING_SPEC_VERSION, ...out },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
