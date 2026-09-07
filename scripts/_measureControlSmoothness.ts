/**
 * Measures jerk in the control-clip wrist track.
 *
 * The metric is peak/mean of the per-frame wrist displacement. A track with one frame that
 * jumps much further than the rest scores high, which is what "jerky" looks like numerically.
 * The athlete's own motion is the reference: matching it means the control clip is no less
 * smooth than real human movement.
 *
 * Usage: npx tsx scripts/_measureControlSmoothness.ts [analysisIdPrefix]
 */
import "dotenv/config";
import { db } from "../src/db";
import { estimateFps } from "../src/technique/impactPoseContext";
import {
  alignedProLandmarksByImpact,
  alignedProLandmarksForUserFrames,
  coachedControlLandmarkFrames,
  controlCanvasSize,
  correctionFunLength,
  inferSwingSideFromLandmarks,
  sampleImpactWindowFrameIndices,
  smoothLandmarkTrack,
  userLandmarksForFrames,
  type NamedLandmarks,
} from "../src/technique/openPoseVideo";
import {
  getTrainSampleImpactMeta,
  getTrainSamplePoseSequence,
} from "../src/technique/trainRetrieval";

const WRISTS = ["RIGHT_WRIST", "LEFT_WRIST"] as const;

function stepStats(frames: NamedLandmarks[], joint: string) {
  const steps: number[] = [];
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1]?.[joint];
    const b = frames[i]?.[joint];
    if (!a || !b) continue;
    steps.push(Math.hypot(b.x - a.x, b.y - a.y));
  }
  if (!steps.length) return null;
  const mean = steps.reduce((s, n) => s + n, 0) / steps.length;
  const peak = Math.max(...steps);
  return { n: steps.length, mean, peak, ratio: mean > 0 ? peak / mean : 0 };
}

function report(label: string, frames: NamedLandmarks[]) {
  for (const joint of WRISTS) {
    const s = stepStats(frames, joint);
    if (!s) continue;
    console.log(
      `${label.padEnd(34)} ${joint.padEnd(12)} steps=${String(s.n).padStart(2)}  ` +
        `mean=${s.mean.toFixed(4)}  peak=${s.peak.toFixed(4)}  peak/mean=${s.ratio.toFixed(2)}`
    );
  }
}

async function main() {
  const prefix = process.argv[2] ?? "4491f6e9";
  const rows = await db.query.techniqueAnalysis.findMany({ limit: 500 });
  const analysis = rows.find((r) => r.id.startsWith(prefix));
  if (!analysis) throw new Error(`no analysis starting with ${prefix}`);

  const metrics = (analysis.metrics ?? {}) as any;
  const totalFrames = Number(metrics.total_frames) || 60;
  const videoDurationMs = Number(metrics.video_duration_ms) || undefined;
  const impactFrame = Number(metrics.impact_frame ?? metrics.impact_frame_resolved ?? 40);
  const trainSampleId = metrics?.retrieval?.neighbors?.[0]?.train_sample_id;
  if (!trainSampleId) throw new Error("analysis has no retrieval neighbour");

  const userFrameIndices = sampleImpactWindowFrameIndices({
    impactFrame,
    totalFrames,
    videoDurationMs,
    count: correctionFunLength(),
  });
  const userFps = videoDurationMs != null ? estimateFps(totalFrames, videoDurationMs) : 30;

  const proSeq = await getTrainSamplePoseSequence(trainSampleId);
  const proMeta = await getTrainSampleImpactMeta(trainSampleId);
  if (!proSeq?.length) throw new Error("pro pose sequence empty");

  const proLandmarks =
    proMeta?.impactFrame != null
      ? alignedProLandmarksByImpact({
          userFrameIndices,
          userImpactFrame: impactFrame,
          userFps,
          proSeq,
          proImpactFrame: proMeta.impactFrame,
          proFps: userFps,
        })
      : alignedProLandmarksForUserFrames(userFrameIndices, totalFrames, proSeq);

  const canvas = controlCanvasSize(368, 448);
  const aspect = canvas.width / canvas.height;
  const userFrames = userLandmarksForFrames(
    userFrameIndices,
    Array.isArray(metrics.pose_data) ? metrics.pose_data : []
  );
  const proSide = inferSwingSideFromLandmarks(proLandmarks, aspect);
  const userSide = inferSwingSideFromLandmarks(userFrames, aspect);
  const mirror = Boolean(proSide && userSide && proSide !== userSide);

  console.log(
    `analysis=${analysis.id}  frames=${userFrameIndices.length}  canvas=${canvas.width}x${canvas.height}  mirror=${mirror}\n`
  );

  // Baseline: what the athlete actually did.
  report("user's own motion", userFrames);
  report("raw pro (old behaviour)", proLandmarks);

  // coachedControlLandmarkFrames smooths at the configured radius, so disable it via env to
  // isolate the moving average's contribution.
  process.env.CORRECTION_POSE_SMOOTHING = "0";
  const rawBlend = coachedControlLandmarkFrames({
    userFrames,
    proFrames: proLandmarks,
    aspect,
    mirror,
    blend: 0.4,
  });

  report("blend 0.4, no smoothing", rawBlend);
  report("blend 0.4 + smoothing r=1", smoothLandmarkTrack(rawBlend, 1));
  report("blend 0.4 + smoothing r=2", smoothLandmarkTrack(rawBlend, 2));

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
