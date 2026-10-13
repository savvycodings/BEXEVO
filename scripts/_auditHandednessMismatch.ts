/**
 * Read-only audit of the Magic Shot handedness guard against stored analyses.
 *
 * Replays the racket-hand evidence the Fun Control branch of `runCorrectionVideoJob` computes
 * (impact window, outlier guard, gap fill, facing, racket boxes near contact) and reports which
 * analyses `isConfidentHandMismatch` would block, next to the profile's hand and the votes.
 * Distances are measured in source space with the source aspect; the router's square crop is a
 * uniform scale of that, so the votes come out the same.
 *
 * Usage:
 *   npx tsx scripts/_auditHandednessMismatch.ts [analysisIdPrefix] [--limit N] [--src WxH] [--all]
 * `--src` is the clip size when the file is not on disk (default 1080x1920). `--all` also prints
 * analyses that pass.
 */
import "dotenv/config";
import fs from "fs";
import { execFile } from "child_process";
import { sql } from "drizzle-orm";
import { db } from "../src/db";
import { estimateFps } from "../src/technique/impactPoseContext";
import { profileTextToDominantHand } from "../src/technique/correctionPrompt";
import {
  CORRECTION_FUN_LENGTH,
  fillJointGaps,
  inferFacing,
  isConfidentHandMismatch,
  racketHandEvidence,
  rejectBodySizeOutliers,
  sampleImpactWindowFrameIndices,
  userLandmarksForFrames,
  type PoseYoloRow,
} from "../src/technique/openPoseVideo";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function probeDims(file: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    execFile(
      process.env.FFPROBE_PATH || "ffprobe",
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file],
      (err, out) => {
        const m = !err && String(out).trim().match(/^(\d+),(\d+)/);
        resolve(m ? { width: Number(m[1]), height: Number(m[2]) } : null);
      }
    );
  });
}

async function main() {
  const prefix = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : null;
  const limit = Number(arg("--limit") ?? 200);
  const srcArg = arg("--src")?.match(/^(\d+)x(\d+)$/);
  const fallbackSrc = srcArg ? { width: Number(srcArg[1]), height: Number(srcArg[2]) } : { width: 1080, height: 1920 };
  const showAll = process.argv.includes("--all");

  const res: any = await db.execute(sql`
    select a.id, a."userId" as "userId", a.metrics, p."dominantHand" as "dominantHand", v."cloudinaryPublicId" as "videoPath"
    from technique_analysis a
    left join user_profile p on p."userId" = a."userId"
    left join technique_video v on v.id = a."techniqueVideoId"
    where a.status = 'completed'
    order by a."createdAt" desc
    limit ${prefix ? 5000 : limit}`);
  const rows: Array<{ id: string; userId: string; metrics: any; dominantHand: string | null; videoPath: string | null }> = (
    res.rows ?? res
  ).filter((r: { id: string }) => !prefix || r.id.startsWith(prefix));

  let checked = 0;
  let flagged = 0;
  const skipped = new Map<string, number>();
  const skip = (why: string) => skipped.set(why, (skipped.get(why) ?? 0) + 1);

  for (const row of rows) {
    const m = row.metrics ?? {};
    const poseData: Array<PoseYoloRow & { landmarks?: unknown }> = Array.isArray(m.pose_data) ? m.pose_data : [];
    if (!poseData.length) { skip("no pose data"); continue; }
    if (!poseData.some((r) => r.racket_bbox)) { skip("no racket boxes"); continue; }
    const impact = Number(
      m.impact_frame_resolved ?? m.correction_videos_comfy?.frame ?? m.correction_context_videos_comfy?.frame ?? NaN
    );
    if (!Number.isFinite(impact)) { skip("no impact frame"); continue; }

    const handedness = profileTextToDominantHand(row.dominantHand) || "unknown";
    const totalFrames = Number(m.total_frames) || poseData.length;
    const videoDurationMs = Number(m.video_duration_ms) || undefined;
    const userFrameIndices = sampleImpactWindowFrameIndices({
      impactFrame: impact,
      totalFrames,
      videoDurationMs,
      count: CORRECTION_FUN_LENGTH,
    });
    const userFps = videoDurationMs != null ? estimateFps(totalFrames, videoDurationMs) : 30;
    const src = (row.videoPath && fs.existsSync(row.videoPath) && (await probeDims(row.videoPath))) || fallbackSrc;
    const aspect = src.width / src.height;

    const lo = Math.min(...userFrameIndices);
    const hi = Math.max(...userFrameIndices);
    const windowRows = poseData.filter((r) => typeof r.frame === "number" && r.frame >= lo && r.frame <= hi);
    const guarded = rejectBodySizeOutliers(userLandmarksForFrames(userFrameIndices, poseData), { aspect });
    const frames = fillJointGaps(guarded.frames).frames;
    const facing = inferFacing(frames);
    const evidence = racketHandEvidence({
      userFrames: frames,
      poseRows: windowRows.length ? windowRows : poseData,
      userFrameIndices,
      contactFrame: impact,
      fps: userFps,
      handedness,
      aspect,
    });
    const blocked = isConfidentHandMismatch(evidence, handedness, facing);
    checked++;
    if (blocked) flagged++;
    if (blocked || showAll || prefix) {
      const v = evidence.contactVotes;
      console.log(
        `${blocked ? "BLOCK" : "ok   "}  ${row.id}  user=${String(row.userId).slice(0, 8)}  profile=${handedness.padEnd(12)} racket=${evidence.side.padEnd(5)} ` +
          `source=${evidence.source.padEnd(7)} votes L${v.left}/R${v.right}  facing=${facing ?? "?"}  ` +
          `shot=${m?.retrieval?.neighbors?.[0]?.stroke_preset ?? "?"}`
      );
    }
  }

  console.log(`\n${flagged}/${checked} analyses would be blocked.`);
  for (const [why, n] of skipped) console.log(`  skipped ${n}: ${why}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
