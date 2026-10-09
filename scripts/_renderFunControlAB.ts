/**
 * A/B Fun Control renders for one analysis, without the HTTP route or any DB write.
 *
 * Replays the fun-control branch of `POST /technique/correction-videos` (same window, alignment,
 * crop, outlier guard, gap fill, mirror, blend, overlays, coaching prompt and ComfyUI call) once
 * per variant, all at one fixed seed, and writes each start image, control clip and generated
 * clip under --out. Point COMFYUI_BASE_URL at the ComfyUI under test.
 *
 * Variants:
 *   base         production pipeline, racket outline off
 *   outline      same, CORRECTION_DRAW_RACKET_OUTLINE=true
 *   plan         pro from --pro, oriented by proOrientationPlan (outline on)
 *   old          same pro, the old rule: flip x on any swing-side mismatch, names kept
 * Pro-specific outputs are named <variant>-<pro id prefix>.
 *
 * Usage:
 *   COMFYUI_BASE_URL=https://<pod>-8188.proxy.runpod.net \
 *   npx tsx scripts/_renderFunControlAB.ts <analysisIdPrefix> --video <local.mp4> \
 *     [--pro <trainSampleId>] [--variants base,outline,plan,old] [--seed 42] [--out dir] [--tag name]
 *
 * Local mode (no DB): clips analyzed with `_ingestAnalyzerMetrics.ts`.
 *   npx tsx scripts/_renderFunControlAB.ts <label> --video bad.mp4 --user-metrics bad.json \
 *     --pro-metrics pro.json [--user-impact 64] [--pro-impact 40] --variants base,outline
 * The pro's own frame rate is used for alignment; the route assumes the user's.
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { sql } from "drizzle-orm";
import { db } from "../src/db";
import { extractFrame } from "../src/technique/frameExtractor";
import { estimateFps } from "../src/technique/impactPoseContext";
import { readImageDimensions } from "../src/technique/poseMask";
import { profileTextToDominantHand } from "../src/technique/correctionPrompt";
import { resolveCanonicalShotFromMetrics } from "../src/train/trainShotDisplay";
import { buildCorrectionVideoCoachingContext } from "../src/technique/techniqueRouter";
import { generatePoseRetargetVideoComfy } from "../src/technique/comfyVideo";
import {
  RACKET_HAND_CONTACT_S,
  racketSideFromBoxes,
  inferFacing,
  proOrientationPlan,
  alignedProLandmarksByImpact,
  alignedProLandmarksForUserFrames,
  boxToCanvas,
  coachedControlLandmarkFrames,
  controlCanvasSize,
  controlOverlaysForWindow,
  correctionFunLength,
  correctionPoseBlend,
  fillJointGaps,
  framesToCanvas,
  inferSwingSideFromLandmarks,
  pickControlCrop,
  rejectBodySizeOutliers,
  renderOpenPoseMp4,
  sampleImpactWindowFrameIndices,
  userLandmarksForFrames,
  windowRetargetScale,
  type NamedLandmarks,
  type PoseYoloRow,
} from "../src/technique/openPoseVideo";
import type { TrainPoseFrame } from "../src/db/schema";
import {
  getTrainSampleImpactMeta,
  getTrainSamplePoseSequence,
} from "../src/technique/trainRetrieval";

type Variant = "base" | "outline" | "plan" | "old";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const prefix = process.argv[2];
  const videoPath = arg("--video");
  if (!prefix || prefix.startsWith("--") || !videoPath) {
    throw new Error("usage: _renderFunControlAB.ts <analysisIdPrefix> --video <local.mp4> [...]");
  }
  if (!fs.existsSync(videoPath)) throw new Error(`video not found: ${videoPath}`);
  const variants = (arg("--variants") ?? "base,outline,plan,old").split(",") as Variant[];
  const otherPro = arg("--pro");
  const userMetricsPath = arg("--user-metrics");
  const proMetricsPath = arg("--pro-metrics");
  if (variants.some((v) => v === "plan" || v === "old") && !otherPro && !proMetricsPath) {
    throw new Error("plan/old variants need --pro <trainSampleId> or --pro-metrics <json>");
  }
  process.env.COMFYUI_FUN_SEED = arg("--seed") ?? process.env.COMFYUI_FUN_SEED ?? "42";

  let analysis: { id: string; metrics: any } | undefined;
  if (userMetricsPath) {
    analysis = { id: prefix, metrics: JSON.parse(fs.readFileSync(userMetricsPath, "utf8")) };
  } else {
    const res: any = await db.execute(
      sql`select id, metrics from technique_analysis where id like ${prefix + "%"} limit 1`
    );
    analysis = (res.rows ?? res)[0] as { id: string; metrics: any } | undefined;
  }
  if (!analysis) throw new Error(`no analysis starting with ${prefix}`);
  const metrics = analysis.metrics ?? {};
  if (arg("--user-impact")) {
    metrics.impact_frame_resolved = Number(arg("--user-impact"));
    delete metrics.correction_videos_comfy;
  }
  const localPro = proMetricsPath ? JSON.parse(fs.readFileSync(proMetricsPath, "utf8")) : null;
  const outRoot = arg("--out") ?? path.join(process.cwd(), "..", "verify-out", "fun-control-ab");
  const outDir = path.join(outRoot, analysis.id.slice(0, 8));
  fs.mkdirSync(outDir, { recursive: true });

  const userImpactFrame = Number(metrics.impact_frame_resolved);
  const startFrame = Number(metrics.correction_videos_comfy?.frame ?? userImpactFrame);
  const totalFrames = Number(metrics.total_frames);
  const videoDurationMs = Number(metrics.video_duration_ms) || undefined;
  const userFps = videoDurationMs != null ? estimateFps(totalFrames, videoDurationMs) : 30;
  const shotName = resolveCanonicalShotFromMetrics(metrics).shotName;
  const handedness =
    profileTextToDominantHand(metrics?.stroke_side?.dominant_hand ?? null) || "unknown";
  const ownPro: string = localPro
    ? "local-pro"
    : metrics?.retrieval?.neighbors?.[0]?.train_sample_id;
  /** Pose sequence, contact frame and frame rate of a pro, from the DB or a local analysis. */
  const loadPro = async (id: string) => {
    if (localPro && (id === "local-pro" || !otherPro)) {
      const seq = (localPro.pose_data ?? [])
        .filter((r: any) => r.landmarks)
        .map((r: any) => ({ frame_idx: r.frame, landmarks: r.landmarks })) as TrainPoseFrame[];
      const impact = arg("--pro-impact") ? Number(arg("--pro-impact")) : localPro.impact_frame_resolved ?? null;
      const fps = estimateFps(Number(localPro.total_frames), Number(localPro.video_duration_ms));
      return { seq, impact, fps, rows: (localPro.pose_data ?? []) as PoseYoloRow[] };
    }
    const seq = await getTrainSamplePoseSequence(id);
    const impact = (await getTrainSampleImpactMeta(id))?.impactFrame ?? null;
    return { seq, impact, fps: userFps, rows: null as PoseYoloRow[] | null };
  };
  const poseData: Array<PoseYoloRow & { landmarks?: unknown }> = metrics.pose_data ?? [];

  const userFrameIndices = sampleImpactWindowFrameIndices({
    impactFrame: userImpactFrame,
    totalFrames,
    videoDurationMs,
    count: correctionFunLength(),
  });
  const frameBuffer = await extractFrame(videoPath, startFrame);
  const source = await readImageDimensions(frameBuffer);
  const canvas = controlCanvasSize(source.width, source.height);
  const aspect = canvas.width / canvas.height;
  const userRaw = userLandmarksForFrames(userFrameIndices, poseData);
  const crop = pickControlCrop({
    srcW: source.width,
    srcH: source.height,
    canvasW: canvas.width,
    canvasH: canvas.height,
    userFrames: userRaw,
  });
  const startImage = await sharp(frameBuffer)
    .extract({ left: crop.x, top: crop.y, width: crop.w, height: crop.h })
    .resize(canvas.width, canvas.height, { fit: "fill" })
    .png()
    .toBuffer();
  fs.writeFileSync(path.join(outDir, "start.png"), startImage);
  const userFrames = framesToCanvas(userRaw, crop, source.width, source.height);
  const lo = Math.min(...userFrameIndices);
  const hi = Math.max(...userFrameIndices);
  const windowRows = poseData.filter((r) => r.frame >= lo && r.frame <= hi);
  const yoloRows = (windowRows.length ? windowRows : poseData).map((r) => ({
    ...r,
    racket_bbox: r.racket_bbox ? boxToCanvas(r.racket_bbox, crop, source.width, source.height) : r.racket_bbox,
    ball_bbox: r.ball_bbox ? boxToCanvas(r.ball_bbox, crop, source.width, source.height) : r.ball_bbox,
  }));

  console.log(
    `analysis=${analysis.id} shot=${shotName} hand=${handedness} start=${startFrame} impact=${userImpactFrame} ` +
      `source=${source.width}x${source.height} canvas=${canvas.width}x${canvas.height} seed=${process.env.COMFYUI_FUN_SEED}`
  );

  for (const variant of variants) {
    const trainSampleId = variant === "plan" || variant === "old" ? otherPro ?? ownPro : ownPro;
    const baseName = variant === "plan" || variant === "old" ? `${variant}-${trainSampleId.slice(0, 8)}` : variant;
    // --tag keeps outputs apart when the same variant runs under different env (e.g. blend).
    const name = arg("--tag") ? `${baseName}-${arg("--tag")}` : baseName;
    const { seq: proSeq, impact: proImpact, fps: proFps, rows: proRows } = await loadPro(trainSampleId);
    if (!proSeq?.length) throw new Error(`no pose sequence for ${trainSampleId}`);
    const proLandmarks =
      proImpact != null
        ? alignedProLandmarksByImpact({
            userFrameIndices,
            userImpactFrame,
            userFps,
            proSeq,
            proImpactFrame: proImpact,
            proFps,
          })
        : alignedProLandmarksForUserFrames(userFrameIndices, totalFrames, proSeq);

    const userControl = fillJointGaps(rejectBodySizeOutliers(userFrames, { aspect }).frames).frames;
    const proControl = fillJointGaps(rejectBodySizeOutliers(proLandmarks, { aspect }).frames).frames;
    // Racket boxes name the racket arm reliably; reach does not on a volley. Both sides must be
    // measured the same way, so boxes are used only when both clips have them (library pros
    // store none), as the route would have to.
    const centreAt = (rows: PoseYoloRow[], frame: number) => {
      const r = rows.find((row) => Math.abs(row.frame - frame) <= 1 && row.racket_bbox);
      return r?.racket_bbox ? { x: (r.racket_bbox[0] + r.racket_bbox[2]) / 2, y: (r.racket_bbox[1] + r.racket_bbox[3]) / 2 } : null;
    };
    // Vote on every source frame within RACKET_HAND_CONTACT_S of each clip's own contact.
    const sideNearContact = (rows: PoseYoloRow[], contact: number, fps: number, aspectRatio: number) => {
      const near = rows.filter((r: any) => r.landmarks && Math.abs(r.frame - contact) <= Math.round(RACKET_HAND_CONTACT_S * fps));
      return racketSideFromBoxes(
        near.map((r: any) => r.landmarks as NamedLandmarks),
        near.map((r) => centreAt(rows, r.frame)),
        aspectRatio
      );
    };
    const userBoxSide = sideNearContact(poseData, userImpactFrame, userFps, source.width / source.height);
    const proBoxSide = proRows && proImpact != null ? sideNearContact(proRows, proImpact, proFps, 1) : null;
    const useBoxes = Boolean(userBoxSide && proBoxSide);
    const proSide = useBoxes ? proBoxSide : inferSwingSideFromLandmarks(proControl, aspect);
    const userSide = useBoxes ? userBoxSide : inferSwingSideFromLandmarks(userControl, aspect);
    const userFacing = inferFacing(userControl);
    const proFacing = inferFacing(proControl);
    const orientation =
      variant === "old"
        ? { swapSides: false, flipX: Boolean(userSide && proSide && userSide !== proSide) }
        : proOrientationPlan({ userSide, proSide, userFacing, proFacing });
    const control = coachedControlLandmarkFrames({
      userFrames: userControl,
      proFrames: proControl,
      aspect,
      flipX: orientation.flipX,
      swapSides: orientation.swapSides,
      racketSide: userBoxSide ?? (handedness.includes("left") ? "LEFT" : "RIGHT"),
      blend: correctionPoseBlend(),
      scale: windowRetargetScale(userControl, proControl, aspect),
    });

    process.env.CORRECTION_DRAW_RACKET_OUTLINE = variant === "base" ? "false" : "true";
    const overlays = controlOverlaysForWindow({
      userFrameIndices,
      poseRows: yoloRows,
      controlLandmarks: control,
      handedness,
      width: canvas.width,
      height: canvas.height,
      fps: userFps,
      userLandmarks: userControl,
      contactFrame: userImpactFrame,
    });
    const poseVideoBuffer = await renderOpenPoseMp4({
      landmarkFrames: control,
      overlays,
      width: canvas.width,
      height: canvas.height,
    });
    fs.writeFileSync(path.join(outDir, `${name}-control.mp4`), poseVideoBuffer);

    const coaching = buildCorrectionVideoCoachingContext({
      metrics,
      userFrameIndices,
      userLandmarkFrames: userRaw,
      proLandmarkFrames: proLandmarks,
      userImpactFrame,
      handedness,
    });
    console.log(
      `[${name}] side by ${useBoxes ? "racket boxes" : "reach"}: user=${userSide}/${userFacing} pro=${proSide}/${proFacing} ` +
        `swap=${orientation.swapSides} flip=${orientation.flipX} ` +
        `balls=${overlays.filter((o) => o.ball).length}/${overlays.length} outline=${process.env.CORRECTION_DRAW_RACKET_OUTLINE} rendering...`
    );
    const t0 = Date.now();
    const video = await generatePoseRetargetVideoComfy({
      analysisId: `${analysis.id}-${variant}`,
      frameNumber: startFrame,
      imageBuffer: startImage,
      poseVideoBuffer,
      shotName,
      handedness,
      width: canvas.width,
      height: canvas.height,
      coaching,
    });
    fs.writeFileSync(path.join(outDir, `${name}-corrected.mp4`), video);
    console.log(`[${name}] done in ${Math.round((Date.now() - t0) / 1000)}s -> ${outDir}`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
