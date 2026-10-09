/**
 * End-to-end check of the OpenPose control clip on real forehand-volley analyses.
 *
 * Replays the Fun Control branch of `techniqueRouter` (window sampling, pro alignment, crop,
 * outlier guard, swing-side mirror, retarget + blend + smoothing, overlays, render) against
 * stored pose data, then asserts the control clip is something Fun Control can follow:
 * a full skeleton on every frame, anchored on the athlete, inside the canvas, stable in size,
 * no smoother-defeating jumps, and a wrist that reaches contact in front of the body.
 *
 * Writes each analysis's control mp4 and a contact sheet for eyeballing.
 *
 * Usage:
 *   npx tsx scripts/_testOpenPoseForehandVolley.ts [analysisIdPrefix] [--src WxH] [--out dir]
 * With no prefix, runs every completed analysis whose top retrieval neighbour is a forehand volley.
 */
import "dotenv/config";
import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import ffmpegStatic from "ffmpeg-static";
import { sql } from "drizzle-orm";
import { db } from "../src/db";
import { estimateFps } from "../src/technique/impactPoseContext";
import {
  alignedProLandmarksByImpact,
  alignedProLandmarksForUserFrames,
  bodySizeRatios,
  coachedControlLandmarkFrames,
  controlCanvasSize,
  controlOverlaysForWindow,
  correctionFunLength,
  correctionPoseBlend,
  correctionPoseSmoothing,
  smoothLandmarkTrack,
  drawOpenPoseRgb,
  fillJointGaps,
  framesToCanvas,
  inferFacing,
  inferSwingSideFromLandmarks,
  proOrientationPlan,
  racketSideForWindow,
  pickControlCrop,
  rejectBodySizeOutliers,
  renderOpenPoseMp4,
  retargetProToUser,
  sampleImpactWindowFrameIndices,
  userLandmarksForFrames,
  windowRetargetScale,
  boxToCanvas,
  type NamedLandmarks,
  type PoseYoloRow,
} from "../src/technique/openPoseVideo";
import {
  getTrainSampleImpactMeta,
  getTrainSamplePoseSequence,
} from "../src/technique/trainRetrieval";

const CORE = [
  "LEFT_SHOULDER",
  "RIGHT_SHOULDER",
  "LEFT_ELBOW",
  "RIGHT_ELBOW",
  "LEFT_WRIST",
  "RIGHT_WRIST",
  "LEFT_HIP",
  "RIGHT_HIP",
  "LEFT_KNEE",
  "RIGHT_KNEE",
  "LEFT_ANKLE",
  "RIGHT_ANKLE",
] as const;

type Check = { name: string; pass: boolean; detail: string; warnOnly?: boolean };

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function ffmpegBin(): string {
  return process.env.FFMPEG_PATH?.trim() || ffmpegStatic || "ffmpeg";
}

function ffmpeg(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(ffmpegBin(), args, { maxBuffer: 16 * 1024 * 1024 }, (_err, _out, stderr) =>
      resolve(String(stderr))
    );
  });
}

/** Display dimensions of the uploaded video, honouring phone rotation metadata. */
async function probeDims(
  url: string
): Promise<{ width: number; height: number } | { error: string }> {
  const info = await ffmpeg(["-hide_banner", "-i", url]);
  const m = info.match(/Video:.*?, (\d{2,5})x(\d{2,5})/);
  if (!m) return { error: info.trim().split("\n").at(-1)?.slice(0, 160) ?? "no output" };
  let width = Number(m[1]);
  let height = Number(m[2]);
  const rot = info.match(/rotation of (-?\d+(?:\.\d+)?)/) ?? info.match(/rotate\s*:\s*(-?\d+)/);
  if (rot && Math.abs(Math.round(Number(rot[1]))) % 180 === 90) [width, height] = [height, width];
  return { width, height };
}

function vis(lm: NamedLandmarks[string]): boolean {
  return Boolean(
    lm && Number.isFinite(lm.x) && Number.isFinite(lm.y) && (lm.visibility ?? 1) >= 0.25
  );
}

function hipMid(lm: NamedLandmarks): { x: number; y: number } | null {
  const a = lm.LEFT_HIP;
  const b = lm.RIGHT_HIP;
  if (!vis(a) || !vis(b)) return null;
  return { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 };
}

function shoulderMid(lm: NamedLandmarks): { x: number; y: number } | null {
  const a = lm.LEFT_SHOULDER;
  const b = lm.RIGHT_SHOULDER;
  if (!vis(a) || !vis(b)) return null;
  return { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 };
}

/** "3/33 frames (LEFT_ANKLE x3)": how many frames drop a core joint, and which joints. */
function missingCore(frames: NamedLandmarks[]): { frames: number; detail: string } {
  const byJoint = new Map<string, number>();
  let n = 0;
  for (const lm of frames) {
    const gone = CORE.filter((j) => !vis(lm[j]));
    if (gone.length) n++;
    for (const j of gone) byJoint.set(j, (byJoint.get(j) ?? 0) + 1);
  }
  const top = [...byJoint].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([j, c]) => `${j} x${c}`);
  return { frames: n, detail: `${n}/${frames.length} frames missing a core joint${top.length ? ` (${top.join(", ")})` : ""}` };
}

function wristJerk(frames: NamedLandmarks[], joint: string): number | null {
  const steps: number[] = [];
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1]?.[joint];
    const b = frames[i]?.[joint];
    if (!vis(a) || !vis(b)) continue;
    steps.push(Math.hypot(b!.x - a!.x, b!.y - a!.y));
  }
  if (steps.length < 4) return null;
  const mean = steps.reduce((s, n) => s + n, 0) / steps.length;
  return mean > 0 ? Math.max(...steps) / mean : null;
}

async function checkAnalysis(
  analysis: { id: string; metrics: any; videoUrl: string | null },
  outDir: string,
  srcOverride: { width: number; height: number } | null
): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (name: string, pass: boolean, detail: string, warnOnly = false) =>
    checks.push({ name, pass, detail, warnOnly });

  const metrics = analysis.metrics ?? {};
  const poseData: Array<PoseYoloRow & { landmarks?: unknown }> = Array.isArray(metrics.pose_data)
    ? metrics.pose_data
    : [];
  const totalFrames = Number(metrics.total_frames) || poseData.length;
  const videoDurationMs = Number(metrics.video_duration_ms) || undefined;
  const userImpactFrame = Number(
    metrics.impact_frame_resolved ?? metrics.correction_videos_comfy?.frame ?? NaN
  );
  const trainSampleId: string | undefined = metrics?.retrieval?.neighbors?.[0]?.train_sample_id;
  const handedness = String(metrics?.stroke_side?.dominant_hand ?? "unknown");

  add("impact frame resolved", Number.isFinite(userImpactFrame), `impact=${userImpactFrame}`);
  add("pro neighbour present", Boolean(trainSampleId), `train_sample_id=${trainSampleId}`);
  if (!Number.isFinite(userImpactFrame) || !trainSampleId) return checks;

  // 1. Window sampling.
  const count = correctionFunLength();
  const userFrameIndices = sampleImpactWindowFrameIndices({
    impactFrame: userImpactFrame,
    totalFrames,
    videoDurationMs,
    count,
  });
  const userFps = videoDurationMs != null ? estimateFps(totalFrames, videoDurationMs) : 30;
  const monotonic = userFrameIndices.every((f, i) => i === 0 || f >= userFrameIndices[i - 1]!);
  // Window index nearest contact. Not always the middle: the sampler clamps at the clip edges.
  let contactIdx = 0;
  userFrameIndices.forEach((f, i) => {
    if (Math.abs(f - userImpactFrame) < Math.abs(userFrameIndices[contactIdx]! - userImpactFrame)) {
      contactIdx = i;
    }
  });
  const range = `${userFrameIndices[0]}..${userFrameIndices.at(-1)}`;
  add(
    "window: 4n+1 frames, monotonic, contains contact",
    userFrameIndices.length === count && (count - 1) % 4 === 0 && monotonic &&
      Math.abs(userFrameIndices[contactIdx]! - userImpactFrame) <= 2,
    `n=${userFrameIndices.length} range=${range} impact=${userImpactFrame}`
  );
  add(
    "window: contact near the middle of the clip",
    Math.abs(contactIdx - (count - 1) / 2) <= count / 6,
    `contact at index ${contactIdx}/${count - 1} (range=${range})`,
    true
  );

  // 2. Pro alignment.
  const proSeq = await getTrainSamplePoseSequence(trainSampleId);
  const proMeta = await getTrainSampleImpactMeta(trainSampleId);
  add("pro pose sequence loads", Boolean(proSeq?.length), `frames=${proSeq?.length ?? 0}`);
  if (!proSeq?.length) return checks;
  const proImpactFrame = proMeta?.impactFrame ?? null;
  const proLandmarks =
    proImpactFrame != null
      ? alignedProLandmarksByImpact({
          userFrameIndices,
          userImpactFrame,
          userFps,
          proSeq,
          proImpactFrame,
          proFps: userFps,
        })
      : alignedProLandmarksForUserFrames(userFrameIndices, totalFrames, proSeq);
  add(
    "pro landmarks index-aligned with window",
    proLandmarks.length === userFrameIndices.length,
    `pro=${proLandmarks.length} alignment=${proImpactFrame != null ? "impact" : "relative-timeline"}`
  );
  add(
    "pro clip has a resolved impact frame",
    proImpactFrame != null,
    `proImpactFrame=${proImpactFrame}`,
    true
  );

  // 3. Canvas + crop, as the router does from the start frame's dimensions.
  // `cloudinaryPublicId` holds the uploaded file's local path.
  const probed =
    srcOverride ??
    (analysis.videoUrl && fs.existsSync(analysis.videoUrl)
      ? await probeDims(analysis.videoUrl)
      : { error: `video not on disk: ${analysis.videoUrl}` });
  const source = "error" in probed ? null : probed;
  add(
    "source dimensions known",
    Boolean(source),
    source ? `${source.width}x${source.height}` : (probed as { error: string }).error,
    true
  );
  const canvas = controlCanvasSize(source?.width, source?.height);
  const userRaw = userLandmarksForFrames(userFrameIndices, poseData);
  let userFrames = userRaw;
  let mapBox = (b: [number, number, number, number]) => b;
  let cropDesc = "none";
  if (source) {
    const crop = pickControlCrop({
      srcW: source.width,
      srcH: source.height,
      canvasW: canvas.width,
      canvasH: canvas.height,
      userFrames: userRaw,
    });
    userFrames = framesToCanvas(userRaw, crop, source.width, source.height);
    mapBox = (b) => boxToCanvas(b, crop, source.width, source.height);
    cropDesc = `${crop.w}x${crop.h}@${crop.x},${crop.y}`;
  }
  const aspect = canvas.width / canvas.height;

  const userMissing = missingCore(userFrames);
  // Input quality, reported but not failed: the pipeline is expected to cope with it.
  add("user pose: core joints on every window frame", userMissing.frames <= 2, userMissing.detail, true);

  // 4. Outlier guard, swing side, mirror.
  const userGuarded = rejectBodySizeOutliers(userFrames, { aspect });
  const proGuarded = rejectBodySizeOutliers(proLandmarks, { aspect });
  const userGuard = { replaced: userGuarded.replaced, frames: fillJointGaps(userGuarded.frames).frames };
  const proGuard = { replaced: proGuarded.replaced, frames: fillJointGaps(proGuarded.frames).frames };
  add(
    "body-size outliers are rare",
    userGuard.replaced.length <= 3 && proGuard.replaced.length <= 3,
    `user=[${userGuard.replaced}] pro=[${proGuard.replaced}]`,
    true
  );
  const proSide = inferSwingSideFromLandmarks(proGuard.frames, aspect);
  const userSide = inferSwingSideFromLandmarks(userGuard.frames, aspect);
  const userFacing = inferFacing(userGuard.frames);
  const proFacing = inferFacing(proGuard.frames);
  const plan = proOrientationPlan({ userSide, proSide, userFacing, proFacing });
  const mirror = plan.swapSides;
  add(
    "swing side resolvable on both clips",
    proSide != null && userSide != null,
    `user=${userSide} pro=${proSide} facing user=${userFacing} pro=${proFacing} swap=${plan.swapSides} flip=${plan.flipX} profileHand=${handedness}`,
    true
  );

  // 5. Control clip.
  const scale = windowRetargetScale(userGuard.frames, proGuard.frames, aspect);
  const windowYolo = poseData
    .filter((r) => r.frame >= userFrameIndices[0]! && r.frame <= userFrameIndices.at(-1)!)
    .map((r) => ({ ...r, racket_bbox: r.racket_bbox ? mapBox(r.racket_bbox) : r.racket_bbox }));
  const racketSide = racketSideForWindow({
    userFrames: userGuard.frames,
    poseRows: windowYolo,
    userFrameIndices,
    contactFrame: userImpactFrame,
    fps: userFps,
    handedness,
    aspect,
  });
  const control = coachedControlLandmarkFrames({
    userFrames: userGuard.frames,
    proFrames: proGuard.frames,
    aspect,
    flipX: plan.flipX,
    swapSides: plan.swapSides,
    racketSide,
    blend: correctionPoseBlend(),
    scale,
  });
  add(
    "control clip: one pose per window frame",
    control.length === userFrameIndices.length,
    `control=${control.length}`
  );
  add(
    "retarget scale is plausible",
    scale != null && scale > 0.33 && scale < 3,
    `scale=${scale?.toFixed(3)}`
  );

  const controlMissing = missingCore(control);
  add("control: full skeleton on every frame", controlMissing.frames === 0, controlMissing.detail, true);
  // What the pipeline owns: never drop a joint that either input still has on that frame.
  const dropped: string[] = [];
  control.forEach((lm, i) => {
    for (const j of CORE) {
      if (vis(lm[j])) continue;
      if (vis(userGuard.frames[i]?.[j]) || vis(proGuard.frames[i]?.[j])) dropped.push(`${i}:${j}`);
    }
  });
  add(
    "control: keeps every joint an input has",
    dropped.length === 0,
    dropped.length ? `dropped ${dropped.slice(0, 4).join(" ")}` : "none dropped"
  );

  let jointsOut = 0;
  let jointsTotal = 0;
  for (const lm of control) {
    for (const j of CORE) {
      const p = lm[j];
      if (!vis(p)) continue;
      jointsTotal++;
      if (p!.x < 0 || p!.x > 1 || p!.y < 0 || p!.y > 1) jointsOut++;
    }
  }
  add(
    "control: joints inside the canvas",
    jointsTotal > 0 && jointsOut / jointsTotal <= 0.02,
    `${jointsOut}/${jointsTotal} off-canvas`
  );

  // Retarget puts pro hips on user hips, and blending keeps them there; only smoothing moves them.
  let maxHipDrift = 0;
  control.forEach((lm, i) => {
    const c = hipMid(lm);
    const u = hipMid(userGuard.frames[i] ?? {});
    if (c && u) maxHipDrift = Math.max(maxHipDrift, Math.hypot((c.x - u.x) * aspect, c.y - u.y));
  });
  add("control: anchored on the athlete's hips", maxHipDrift < 0.05, `max drift=${maxHipDrift.toFixed(4)}`);

  // A player closing on the net legitimately grows through the clip, so stability means no
  // sudden jumps against nearby frames rather than a fixed size.
  const ratios = bodySizeRatios(control, aspect);
  let worstJump = 0;
  ratios.forEach((r, i) => {
    if (r == null) return;
    const near = ratios.slice(Math.max(0, i - 4), i + 5).filter((n): n is number => n != null).sort((a, b) => a - b);
    const ref = near[Math.floor(near.length / 2)];
    if (ref) worstJump = Math.max(worstJump, Math.abs(r / ref - 1));
  });
  const known = ratios.filter((r): r is number => r != null);
  add(
    "control: no sudden body-size jumps",
    known.length > 0 && worstJump <= 0.2,
    `worst jump ${(worstJump * 100).toFixed(1)}% (range ${Math.min(...known).toFixed(2)}..${Math.max(...known).toFixed(2)})`
  );

  const controlSide = inferSwingSideFromLandmarks(control, aspect);
  // Reach-based, so only a warning: on a volley the free arm reaches out for balance, and once
  // the free arm keeps the athlete's own motion while the racket arm moves toward the pro, the
  // free arm can out-reach it without any arm being wrong.
  add(
    "control reach side matches the athlete's",
    userSide == null || controlSide == null || controlSide === userSide,
    `control=${controlSide} user=${userSide} pro=${proSide} mirror=${mirror}`,
    true
  );

  // Free arm blends by joint angle: its elbow bend must stay between the athlete's and the pro's
  // (10 degree slack), never straighter or more bent than both, on 90% of frames.
  const freeSide = racketSide === "LEFT" ? "RIGHT" : "LEFT";
  const elbowAngle = (lm: NamedLandmarks): number | null => {
    const sh = lm[`${freeSide}_SHOULDER`], el = lm[`${freeSide}_ELBOW`], wr = lm[`${freeSide}_WRIST`];
    if (!vis(sh) || !vis(el) || !vis(wr)) return null;
    let d = Math.abs(Math.atan2(sh!.y - el!.y, (sh!.x - el!.x) * aspect) - Math.atan2(wr!.y - el!.y, (wr!.x - el!.x) * aspect)) * (180 / Math.PI);
    if (d > 180) d = 360 - d;
    return d;
  };
  const smoothed = (frames: NamedLandmarks[]) => smoothLandmarkTrack(frames, correctionPoseSmoothing());
  const userSm = smoothed(userGuard.frames);
  const proSm = smoothed(
    userGuard.frames.map((u, i) =>
      retargetProToUser(proGuard.frames[i] ?? {}, u, { aspect, flipX: plan.flipX, swapSides: plan.swapSides, scale: scale ?? undefined })
    )
  );
  let freeOk = 0;
  let freeN = 0;
  control.forEach((lm, i) => {
    const c = elbowAngle(lm);
    const u = elbowAngle(userSm[i] ?? {});
    const p = elbowAngle(proSm[i] ?? {});
    if (c == null || u == null || p == null) return;
    freeN++;
    if (c <= Math.max(u, p) + 10 && c >= Math.min(u, p) - 10) freeOk++;
  });
  add(
    "free elbow bends between athlete and pro",
    freeN === 0 || freeOk / freeN >= 0.9,
    `${freeSide} elbow in range on ${freeOk}/${freeN} frames`
  );
  add(
    "control swing side clear",
    userSide == null || controlSide === userSide,
    `control=${controlSide} user=${userSide}`,
    true
  );

  // Blending pairs joints by name. When the pro is mirrored, check the name pairing still puts
  // the pro's racket wrist on the athlete's racket wrist rather than on their off hand.
  if (userSide) {
    const other = userSide === "RIGHT" ? "LEFT" : "RIGHT";
    let same = 0;
    let cross = 0;
    let n = 0;
    userGuard.frames.forEach((u, i) => {
      const pr = retargetProToUser(proGuard.frames[i] ?? {}, u, { aspect, flipX: plan.flipX, swapSides: plan.swapSides, scale: scale ?? undefined });
      const uw = u[`${userSide}_WRIST`];
      const ps = pr[`${userSide}_WRIST`];
      const po = pr[`${other}_WRIST`];
      if (!vis(uw) || !vis(ps) || !vis(po)) return;
      same += Math.hypot((ps!.x - uw!.x) * aspect, ps!.y - uw!.y);
      cross += Math.hypot((po!.x - uw!.x) * aspect, po!.y - uw!.y);
      n++;
    });
    if (n) {
      // Volley hands both sit out front, so a near tie is not a crossing; fail on a clear one.
      const detail = `mirror=${mirror} mean dist same-name=${(same / n).toFixed(3)} cross-name=${(cross / n).toFixed(3)}`;
      add("pro racket wrist pairs with the athlete's racket wrist", cross >= same * 0.8, detail);
      add("pro racket wrist pairing is clear-cut", same <= cross, detail, true);
    }
  }

  // Smoothness: control wrist should be no jerkier than the athlete's own motion, within slack.
  const swingWrist = `${controlSide ?? userSide ?? "RIGHT"}_WRIST`;
  const jUser = wristJerk(userGuard.frames, swingWrist);
  const jCtrl = wristJerk(control, swingWrist);
  add(
    "control: swing wrist no jerkier than the athlete",
    jUser == null || jCtrl == null || jCtrl <= Math.max(jUser * 1.5, 3.5),
    `${swingWrist} peak/mean control=${jCtrl?.toFixed(2)} user=${jUser?.toFixed(2)}`
  );

  // Volley shape at contact: compact, wrist out from the body, between knee and head height.
  const atContact = control[contactIdx] ?? {};
  const wrist = atContact[swingWrist];
  const hip = hipMid(atContact);
  const sh = shoulderMid(atContact);
  if (vis(wrist) && hip && sh) {
    const torso = Math.hypot((sh.x - hip.x) * aspect, sh.y - hip.y);
    const reach = Math.hypot((wrist!.x - hip.x) * aspect, wrist!.y - hip.y) / torso;
    const heightAboveHip = (hip.y - wrist!.y) / torso;
    add(
      "volley contact: wrist out from body",
      reach >= 0.6,
      `reach=${reach.toFixed(2)} torsos`,
      true
    );
    add(
      "volley contact: wrist between knee and head height",
      heightAboveHip > -0.8 && heightAboveHip < 1.6,
      `height=${heightAboveHip.toFixed(2)} torsos above hip`,
      true
    );
  } else {
    add("volley contact: swing wrist visible at contact", false, `${swingWrist} not visible`);
  }

  // 6. Overlays + render.
  const lo = Math.min(...userFrameIndices);
  const hi = Math.max(...userFrameIndices);
  const windowRows = poseData.filter((r) => typeof r.frame === "number" && r.frame >= lo && r.frame <= hi);
  const overlays = controlOverlaysForWindow({
    userFrameIndices,
    poseRows: (windowRows.length ? windowRows : poseData).map((r) => ({
      ...r,
      racket_bbox: r.racket_bbox ? mapBox(r.racket_bbox) : r.racket_bbox,
      ball_bbox: r.ball_bbox ? mapBox(r.ball_bbox) : r.ball_bbox,
    })),
    controlLandmarks: control,
    handedness,
    width: canvas.width,
    height: canvas.height,
    fps: userFps,
    userLandmarks: userGuard.frames,
    contactFrame: userImpactFrame,
  });
  add(
    "ball marker present for part of the window",
    overlays.some((o) => o.ball),
    `balls=${overlays.filter((o) => o.ball).length}/${overlays.length}`,
    true
  );

  // Contact: the ball should sit on the racket face. Head centre is two thirds of the racket
  // length out from the grip (0.33 handle + half the 0.67 head). Measured in racket lengths over
  // the frames either side of contact, against the same distance in the athlete's own footage.
  const headGap = (i: number): number | null => {
    const o = overlays[i];
    if (!o?.racketOutline || !o.ball) return null;
    const r = o.racketOutline;
    const hx = r.x + Math.cos(r.angle) * r.length * 0.665;
    const hy = r.y + Math.sin(r.angle) * r.length * 0.665;
    return Math.hypot(o.ball.cx - hx, o.ball.cy - hy) / r.length;
  };
  const near = [contactIdx - 1, contactIdx, contactIdx + 1].map(headGap).filter((n): n is number => n != null);
  const footage = [contactIdx - 1, contactIdx, contactIdx + 1].flatMap((i) => {
    const f = userFrameIndices[i];
    const row = poseData.find((r) => r.frame === f);
    const rl = overlays[i]?.racketOutline?.length;
    if (!row?.racket_bbox || !row.ball_bbox || !rl) return [];
    const rb = mapBox(row.racket_bbox);
    const bb = mapBox(row.ball_bbox);
    const dx = ((rb[0] + rb[2]) / 2 - (bb[0] + bb[2]) / 2) * canvas.width;
    const dy = ((rb[1] + rb[3]) / 2 - (bb[1] + bb[3]) / 2) * canvas.height;
    return [Math.hypot(dx, dy) / rl];
  });
  const fmt = (xs: number[]) => (xs.length ? Math.min(...xs).toFixed(2) : "n/a");
  add(
    "contact: ball on the racket head",
    !near.length || Math.min(...near) <= 0.35,
    `ball to head centre ${fmt(near)} racket lengths (footage: racket box to ball ${fmt(footage)})`,
    true
  );

  const minLit = Math.min(
    ...control.map((lm, i) => {
      const rgb = drawOpenPoseRgb(lm, canvas.width, canvas.height, overlays[i]);
      let lit = 0;
      for (let p = 0; p < rgb.length; p += 3) if (rgb[p] || rgb[p + 1] || rgb[p + 2]) lit++;
      return lit / (canvas.width * canvas.height);
    })
  );
  add("every rendered frame draws a skeleton", minLit > 0.003, `min lit=${(minLit * 100).toFixed(2)}%`);

  const mp4 = await renderOpenPoseMp4({
    landmarkFrames: control,
    overlays,
    width: canvas.width,
    height: canvas.height,
  });
  const dir = path.join(outDir, analysis.id.slice(0, 8));
  fs.mkdirSync(dir, { recursive: true });
  const mp4Path = path.join(dir, "openpose-control.mp4");
  fs.writeFileSync(mp4Path, mp4);
  const probe = await ffmpeg(["-hide_banner", "-i", mp4Path, "-map", "0:v", "-f", "null", "-"]);
  const frameCount = Number(probe.match(/frame=\s*(\d+)/g)?.at(-1)?.replace(/\D/g, ""));
  const dims = probe.match(/Video:.*?, (\d+)x(\d+)/);
  add(
    "mp4: frame count and canvas size",
    frameCount === control.length &&
      Number(dims?.[1]) === canvas.width &&
      Number(dims?.[2]) === canvas.height,
    `frames=${frameCount} size=${dims?.[1]}x${dims?.[2]} canvas=${canvas.width}x${canvas.height} crop=${cropDesc}`
  );
  await ffmpeg([
    "-y", "-hide_banner", "-loglevel", "error", "-i", mp4Path,
    "-vf", `select='not(mod(n\\,3))',scale=256:-1,tile=6x2`,
    "-frames:v", "1", path.join(dir, "contact-sheet.png"),
  ]);

  return checks;
}

async function main() {
  const prefix = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : null;
  const srcArg = arg("--src")?.match(/^(\d+)x(\d+)$/);
  const srcOverride = srcArg ? { width: Number(srcArg[1]), height: Number(srcArg[2]) } : null;
  const outDir = arg("--out") ?? path.join(os.tmpdir(), "xevo-openpose-forehand-volley");

  const res: any = await db.execute(sql`
    select a.id, a.metrics, v."cloudinaryPublicId" as "videoUrl"
    from technique_analysis a
    left join technique_video v on v.id = a."techniqueVideoId"
    where a.status = 'completed'
      and a.metrics->'retrieval'->'neighbors'->0->>'stroke_preset' = 'forehand_volley'
    order by a."createdAt" desc`);
  const rows: Array<{ id: string; metrics: any; videoUrl: string | null }> = (res.rows ?? res).filter(
    (r: { id: string }) => !prefix || r.id.startsWith(prefix)
  );
  if (!rows.length) throw new Error(`no completed forehand-volley analysis${prefix ? ` starting with ${prefix}` : ""}`);

  // Full detail for a single analysis; otherwise only what did not pass.
  const verbose = rows.length === 1 || process.argv.includes("--verbose");
  const tally = new Map<string, { fail: number; warn: number }>();
  let failed = 0;
  for (const row of rows) {
    const checks = await checkAnalysis(row, outDir, srcOverride);
    const hardFails = checks.filter((c) => !c.pass && !c.warnOnly).length;
    if (hardFails) failed++;
    console.log(`\n=== ${row.id}  ${hardFails ? `FAIL (${hardFails})` : "ok"}`);
    for (const c of checks) {
      const t = tally.get(c.name) ?? { fail: 0, warn: 0 };
      if (!c.pass) c.warnOnly ? t.warn++ : t.fail++;
      tally.set(c.name, t);
      if (c.pass && !verbose) continue;
      const tag = c.pass ? "PASS" : c.warnOnly ? "WARN" : "FAIL";
      console.log(`  ${tag}  ${c.name.padEnd(52)} ${c.detail}`);
    }
  }
  console.log(`\n--- summary over ${rows.length} analyses ---`);
  for (const [name, t] of tally) {
    if (!t.fail && !t.warn) continue;
    console.log(`  ${name.padEnd(52)} fail=${t.fail} warn=${t.warn}`);
  }
  console.log(`\n${rows.length - failed}/${rows.length} forehand-volley analyses passed. Output: ${outDir}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
