/**
 * A/B Fun Control renders for one analysis, without the HTTP route or any DB write.
 *
 * Replays the fun-control branch of `POST /technique/correction-videos` (same window, alignment,
 * crop, outlier guard, gap fill, mirror, blend, overlays, coaching prompt and ComfyUI call) once
 * per variant, all at one fixed seed, and writes each start image, control clip and generated
 * clip under --out. Point COMFYUI_BASE_URL at the ComfyUI under test.
 *
 * Variants:
 *   base         production pipeline, racket outline drawn
 *   nooutline    base without the racket outline (production before the arm-end A/B)
 *   outline      old pipeline (no hand-off), racket outline drawn
 *   plan         pro from --pro, oriented by proOrientationPlan (outline on)
 *   old          same pro, the old rule: flip x on any swing-side mismatch, names kept
 *   k14soft      base, full skeleton for steps 0-14, soft (hand-less, blurred) skeleton for 14-20
 *   k10soft      base, full skeleton for the high-noise steps only, soft skeleton after
 *   k10none      base, full skeleton for the high-noise steps only, no control after
 *   softall      base, but every step sees the soft skeleton (no hand points, light blur)
 *   softprompt   base, prompt says "guided by" the skeleton instead of "accurately following"
 * `base` pins the full skeleton on every step whatever CORRECTION_FUN_CONTROL_END is set to.
 * --base-pro runs `base` against --pro instead of the analysis's own nearest pro.
 * --skeletons writes the user's own and the full-pro skeletons next to the control clip and
 * skips ComfyUI.
 * Pro-specific outputs are named <variant>-<pro id prefix>.
 *
 * Usage:
 *   COMFYUI_BASE_URL=https://<pod>-8188.proxy.runpod.net \
 *   npx tsx scripts/_renderFunControlAB.ts <analysisIdPrefix> --video <local.mp4> \
 *     [--pro <trainSampleId>] [--variants base,outline,plan,old] [--seed 42] [--out dir] [--tag name]
 *     [--contact-ms <ms>]   treat <ms> as the contact the user marked in the app
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
import { applyUserClipImpactToMetrics, estimateFps } from "../src/technique/impactPoseContext";
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
  CORRECTION_FUN_LENGTH,
  CORRECTION_FUN_SOFT_BLUR,
  CORRECTION_POSE_BLEND,
  softControlLandmarks,
  fillJointGaps,
  framesToCanvas,
  inferSwingSideFromLandmarks,
  pickControlCrop,
  rejectBodySizeOutliers,
  rejectLimbGlitches,
  renderOpenPoseMp4,
  sampleImpactWindowFrameIndices,
  userLandmarksForFrames,
  windowRetargetScale,
  type NamedLandmarks,
  type PoseYoloRow,
} from "../src/technique/openPoseVideo";
import { proTrustByImpact } from "../src/technique/proTimeAlign";
import type { TrainPoseFrame } from "../src/db/schema";
import {
  getTrainSampleImpactMeta,
  getTrainSamplePoseSequence,
} from "../src/technique/trainRetrieval";

type Variant =
  | "base"
  | "nooutline"
  | "outline"
  | "plan"
  | "old"
  | "k14soft"
  | "k10soft"
  | "k10none"
  | "softall"
  | "softprompt";

/**
 * Blur for `softall`. Lighter than the tail's `CORRECTION_FUN_SOFT_BLUR` because this clip also
 * lays out the motion in the high-noise steps.
 */
const SOFT_ALL_BLUR = 1.5;

/** Skeleton hand-off per variant: fraction of steps on the full skeleton, and the tail. */
const HANDOFF: Partial<Record<Variant, { end: number; tail: "soft" | "none" }>> = {
  base: { end: 1, tail: "soft" },
  nooutline: { end: 1, tail: "soft" },
  softall: { end: 1, tail: "soft" },
  softprompt: { end: 1, tail: "soft" },
  k14soft: { end: 0.7, tail: "soft" },
  k10soft: { end: 0.5, tail: "soft" },
  k10none: { end: 0.5, tail: "none" },
};

/** Slack past the user-to-pro arc before a control wrist direction counts as an overshoot. */
const OVERSHOOT_SLACK_DEG = 10;

/**
 * Per frame and per arm: control wrist distance from the user's (torso lengths), inner elbow
 * angles for user / pro / control, and whether the control wrist direction from the shoulder lies
 * outside the arc between the user's and the pro's by more than `OVERSHOOT_SLACK_DEG`.
 */
function armReport(opts: {
  user: NamedLandmarks[];
  pro: NamedLandmarks[];
  control: NamedLandmarks[];
  aspect: number;
  racketSide: "LEFT" | "RIGHT";
  trust?: number[];
  glitches: { user: number; pro: number };
}) {
  const a = opts.aspect;
  const ok = (p: any) => p && Number.isFinite(p.x) && Number.isFinite(p.y) && (p.visibility ?? 1) >= 0.25;
  const deg = (r: number) => Math.round((r * 180) / Math.PI);
  const wrap = (d: number) => Math.atan2(Math.sin(d), Math.cos(d));
  const dir = (lm: NamedLandmarks, s: string, w: string) =>
    ok(lm[s]) && ok(lm[w]) ? Math.atan2(lm[w]!.y - lm[s]!.y, (lm[w]!.x - lm[s]!.x) * a) : null;
  const elbow = (lm: NamedLandmarks, side: string) => {
    const s = lm[`${side}_SHOULDER`];
    const e = lm[`${side}_ELBOW`];
    const w = lm[`${side}_WRIST`];
    if (!ok(s) || !ok(e) || !ok(w)) return null;
    return deg(
      Math.abs(wrap(Math.atan2(s!.y - e!.y, (s!.x - e!.x) * a) - Math.atan2(w!.y - e!.y, (w!.x - e!.x) * a)))
    );
  };
  const torso = (lm: NamedLandmarks) => {
    const ls = lm.LEFT_SHOULDER, rs = lm.RIGHT_SHOULDER, lh = lm.LEFT_HIP, rh = lm.RIGHT_HIP;
    if (!ok(ls) || !ok(rs) || !ok(lh) || !ok(rh)) return null;
    return Math.hypot(((ls!.x + rs!.x - lh!.x - rh!.x) / 2) * a, (ls!.y + rs!.y - lh!.y - rh!.y) / 2);
  };
  const free = opts.racketSide === "LEFT" ? "RIGHT" : "LEFT";
  const arm = (i: number, side: string) => {
    const u = opts.user[i] ?? {};
    const p = opts.pro[i] ?? {};
    const c = opts.control[i] ?? {};
    const t = torso(u);
    const uw = u[`${side}_WRIST`];
    const cw = c[`${side}_WRIST`];
    const offset =
      t && ok(uw) && ok(cw) ? Math.round((Math.hypot((cw!.x - uw!.x) * a, cw!.y - uw!.y) / t) * 100) / 100 : null;
    const ud = dir(u, `${side}_SHOULDER`, `${side}_WRIST`);
    const pd = dir(p, `${side}_SHOULDER`, `${side}_WRIST`);
    const cd = dir(c, `${side}_SHOULDER`, `${side}_WRIST`);
    let overshoot = false;
    if (ud != null && pd != null && cd != null) {
      const gap = wrap(pd - ud);
      const at = wrap(cd - ud);
      const slack = (OVERSHOOT_SLACK_DEG * Math.PI) / 180;
      const lo = Math.min(0, gap) - slack;
      const hi = Math.max(0, gap) + slack;
      overshoot = at < lo || at > hi;
    }
    return { offset, elbow: [elbow(u, side), elbow(p, side), elbow(c, side)], overshoot };
  };
  const frames = opts.control.map((_, i) => ({
    i,
    trust: opts.trust ? Math.round(opts.trust[i]! * 100) / 100 : null,
    free: arm(i, free),
    racket: arm(i, opts.racketSide),
  }));
  const maxOf = (k: "free" | "racket") => Math.max(0, ...frames.map((f) => f[k].offset ?? 0));
  return {
    freeSide: free,
    glitches: opts.glitches,
    overshoot: {
      free: frames.filter((f) => f.free.overshoot).length,
      racket: frames.filter((f) => f.racket.overshoot).length,
    },
    maxOffset: { free: maxOf("free"), racket: maxOf("racket") },
    frames,
  };
}

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
  if (arg("--contact-ms")) metrics.user_contact_ms = Number(arg("--contact-ms"));
  if (arg("--user-impact")) {
    metrics.impact_frame_resolved = Number(arg("--user-impact"));
    delete metrics.correction_videos_comfy;
  } else if (Array.isArray(metrics.user_clips) && metrics.user_clips.length && metrics.video_duration_ms) {
    // Same re-resolution the route runs before rendering, so stored impacts from older resolvers
    // are replaced by the current one.
    const applied = applyUserClipImpactToMetrics(metrics, metrics.user_clips, Number(metrics.video_duration_ms));
    if (applied) {
      console.log(
        `impact re-resolved: ${metrics.impact_frame_resolved} (${metrics.impact_frame_source}) -> ` +
          `${applied.impact_frame_resolved} (${applied.impact_frame_source})`
      );
      metrics.impact_frame_resolved = applied.impact_frame_resolved;
      metrics.impact_frame_source = applied.impact_frame_source;
    }
  }
  const localPro = proMetricsPath ? JSON.parse(fs.readFileSync(proMetricsPath, "utf8")) : null;
  const outRoot = arg("--out") ?? path.join(process.cwd(), "..", "verify-out", "fun-control-ab");
  const outDir = path.join(outRoot, analysis.id.slice(0, 8));
  fs.mkdirSync(outDir, { recursive: true });

  const userImpactFrame = Number(metrics.impact_frame_resolved);
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

  const firstClip = Array.isArray(metrics.user_clips) ? metrics.user_clips[0] : undefined;
  const userFrameIndices = sampleImpactWindowFrameIndices({
    impactFrame: userImpactFrame,
    totalFrames,
    videoDurationMs,
    count: CORRECTION_FUN_LENGTH,
    bounds: firstClip
      ? { start: (firstClip.startMs / 1000) * userFps, end: (firstClip.endMs / 1000) * userFps }
      : undefined,
  });
  const startFrame = Math.max(0, Math.round(userFrameIndices[0] ?? userImpactFrame));
  const contactIndex = userFrameIndices.reduce(
    (best, f, i) => (Math.abs(f - userImpactFrame) < Math.abs(userFrameIndices[best]! - userImpactFrame) ? i : best),
    0
  );
  fs.writeFileSync(path.join(outDir, "window.json"), JSON.stringify({ userImpactFrame, userFrameIndices }, null, 1));
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
    const swapsPro = variant === "plan" || variant === "old" || (variant === "base" && process.argv.includes("--base-pro"));
    const trainSampleId = swapsPro ? otherPro ?? ownPro : ownPro;
    const baseName = swapsPro ? `${variant}-${trainSampleId.slice(0, 8)}` : variant;
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

    const proTrust =
      proImpact != null
        ? proTrustByImpact({ userFrameIndices, userImpactFrame, userFps, proSeq, proImpactFrame: proImpact, proFps })
        : undefined;
    const userGuarded = rejectBodySizeOutliers(userFrames, { aspect }).frames;
    const proGuarded = rejectBodySizeOutliers(proLandmarks, { aspect }).frames;
    const userGlitch = rejectLimbGlitches(userGuarded, { aspect });
    const proGlitch = rejectLimbGlitches(proGuarded, { aspect });
    if (process.argv.includes("--skeletons")) {
      const droppedAt = (before: NamedLandmarks[], after: NamedLandmarks[]) =>
        before.flatMap((lm, i) => {
          const gone = Object.keys(lm).filter((n) => lm[n] && !after[i]![n] && !/INDEX|PINKY|THUMB|HEEL|FOOT/.test(n));          return gone.length ? [`f${i}:${gone.map((n) => n.replace("LEFT_", "L_").replace("RIGHT_", "R_")).join(",")}`] : [];
        });
      console.log(`[glitch] user ${droppedAt(userGuarded, userGlitch.frames).join(" ")}`);
      console.log(`[glitch] pro  ${droppedAt(proGuarded, proGlitch.frames).join(" ")}`);
    }
    const userControl = fillJointGaps(userGlitch.frames).frames;
    const proControl = fillJointGaps(proGlitch.frames).frames;
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
      blend: CORRECTION_POSE_BLEND,
      scale: windowRetargetScale(userControl, proControl, aspect),
      contactIndex,
      frameTimesMs: userFrameIndices.map((f) => (f / userFps) * 1000),
      proTrust,
    });

    const handoff = HANDOFF[variant];
    const racketDraw = {
      outline: variant === "base" || variant === "softall" || variant === "softprompt" || !handoff,
    };
    const softAll = variant === "softall";
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
      landmarkFrames: softAll ? softControlLandmarks(control) : control,
      overlays,
      width: canvas.width,
      height: canvas.height,
      blurSigma: softAll ? SOFT_ALL_BLUR : undefined,
      racketDraw,
    });
    fs.writeFileSync(path.join(outDir, `${name}-control.mp4`), poseVideoBuffer);
    if (process.argv.includes("--skeletons")) {
      const proOnUser = coachedControlLandmarkFrames({
        userFrames: userControl,
        proFrames: proControl,
        aspect,
        flipX: orientation.flipX,
        swapSides: orientation.swapSides,
        racketSide: userBoxSide ?? (handedness.includes("left") ? "LEFT" : "RIGHT"),
        blend: 1,
        freeArmBlend: 1,
        scale: windowRetargetScale(userControl, proControl, aspect),
      });
      const skeleton = (frames: NamedLandmarks[]) =>
        renderOpenPoseMp4({ landmarkFrames: frames, width: canvas.width, height: canvas.height });
      fs.writeFileSync(path.join(outDir, `${name}-user-skeleton.mp4`), await skeleton(userControl));
      fs.writeFileSync(path.join(outDir, `${name}-pro-skeleton.mp4`), await skeleton(proOnUser));
      const report = armReport({
        user: userControl,
        pro: proOnUser,
        control,
        aspect,
        racketSide: userBoxSide ?? (handedness.includes("left") ? "LEFT" : "RIGHT"),
        trust: proTrust,
        glitches: { user: userGlitch.dropped, pro: proGlitch.dropped },
      });
      fs.writeFileSync(path.join(outDir, `${name}-arm-report.json`), JSON.stringify(report, null, 1));
      console.log(
        `[${name}] arm report: glitches user=${report.glitches.user} pro=${report.glitches.pro} ` +
          `overshoot free=${report.overshoot.free} racket=${report.overshoot.racket} ` +
          `max free wrist offset=${report.maxOffset.free} racket=${report.maxOffset.racket}`
      );
      for (const r of report.frames) {
        console.log(
          `  f${String(r.i).padStart(2, "0")} trust=${r.trust ?? "-"} ` +
            `free off=${r.free.offset ?? "-"} elbow u/p/c=${r.free.elbow.join("/")}${r.free.overshoot ? " OVER" : ""} | ` +
            `racket off=${r.racket.offset ?? "-"} elbow u/p/c=${r.racket.elbow.join("/")}${r.racket.overshoot ? " OVER" : ""}`
        );
      }
      console.log(`[${name}] skeletons written (blend=${CORRECTION_POSE_BLEND}) -> ${outDir}`);
      continue;
    }
    const softPoseVideoBuffer =
      handoff && handoff.end < 1 && handoff.tail === "soft"
        ? await renderOpenPoseMp4({
            landmarkFrames: softControlLandmarks(control),
            overlays,
            width: canvas.width,
            height: canvas.height,
            blurSigma: CORRECTION_FUN_SOFT_BLUR,
            racketDraw,
          })
        : null;
    if (softPoseVideoBuffer) {
      fs.writeFileSync(path.join(outDir, `${name}-soft-control.mp4`), softPoseVideoBuffer);
    }

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
        `balls=${overlays.filter((o) => o.ball).length}/${overlays.length} outline=${racketDraw.outline} rendering...`
    );
    const t0 = Date.now();
    const video = await generatePoseRetargetVideoComfy({
      analysisId: `${analysis.id}-${variant}`,
      frameNumber: startFrame,
      imageBuffer: startImage,
      poseVideoBuffer,
      softPoseVideoBuffer,
      controlHandoff: handoff,
      shotName,
      handedness,
      width: canvas.width,
      height: canvas.height,
      coaching,
      poseGuidance: variant === "softprompt" ? "loose" : "strict",
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
