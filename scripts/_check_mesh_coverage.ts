import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { trainSample } from "../src/db/schema";

async function main() {
  const rows = await db
    .select({
      id: trainSample.id,
      status: trainSample.status,
      meta: trainSample.extractionMeta,
    })
    .from(trainSample)
    .where(eq(trainSample.status, "completed"));

  let withPe = 0;
  let withFrames = 0;
  let withVec = 0;

  for (const r of rows) {
    const m = r.meta as Record<string, unknown> | null;
    const pe = m?.pose_enrichment as Record<string, unknown> | undefined;
    if (pe) withPe++;
    const frames = pe?.frames as unknown[] | undefined;
    if (Array.isArray(frames) && frames.length) withFrames++;
    const last = frames?.[frames.length - 1] as Record<string, unknown> | undefined;
    if (
      Array.isArray(last?.feature_vector) &&
      (last.feature_vector as number[]).length === 128
    ) {
      withVec++;
    }
  }

  console.log(
    JSON.stringify(
      {
        totalCompleted: rows.length,
        withPoseEnrichment: withPe,
        withFrames,
        withFeatureVector128: withVec,
      },
      null,
      2
    )
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
