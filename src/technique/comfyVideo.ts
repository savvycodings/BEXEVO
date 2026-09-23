import fs from "fs/promises";
import path from "path";
import {
  comfyQueuePrompt,
  comfyUploadImage,
  comfyUploadVideo,
  comfyViewToBuffer,
  comfyWaitForOutputMedia,
} from "./comfyClient";
import {
  correctionCanvasSize,
  correctionFunFps,
  correctionFunLength,
} from "./openPoseVideo";

type ApiWorkflow = Record<string, { class_type?: string; inputs?: Record<string, unknown> }>;

const LOAD_IMAGE_NODE_ID = "59";
const KSAMPLER_NODE_ID = "3";
const POSITIVE_NODE_ID = "6";
const LATENT_NODE_ID = "55";
const SAVE_VIDEO_NODE_ID = "58";

function envBaseUrl(): string {
  return String(process.env.COMFYUI_BASE_URL ?? "").trim();
}

/** Hostname (or host:port) of COMFYUI_BASE_URL for safe server logs. */
export function comfyBaseHost(): string {
  const raw = envBaseUrl();
  if (!raw) return "(unset)";
  try {
    const u = new URL(raw.includes("://") ? raw : `http://${raw}`);
    return u.host || raw;
  } catch {
    return raw.slice(0, 64);
  }
}

export function isComfyFunControlConfigured(): boolean {
  const base = envBaseUrl();
  const wf = String(process.env.COMFYUI_FUN_CONTROL_WORKFLOW_PATH ?? "").trim();
  return base.length > 0 && wf.length > 0;
}

export function isComfyTi2vConfigured(): boolean {
  const base = envBaseUrl();
  const wf = String(process.env.COMFYUI_VIDEO_WORKFLOW_PATH ?? "").trim();
  return base.length > 0 && wf.length > 0;
}

export function isComfyVideoConfigured(): boolean {
  return isComfyFunControlConfigured() || isComfyTi2vConfigured();
}

/** True when either Comfy video or Gemini Veo can serve POST /correction-videos. */
export function isVideoGenerationConfigured(): boolean {
  const provider = String(process.env.XEVO_VIDEO_PROVIDER ?? "")
    .trim()
    .toLowerCase();
  if (provider === "gemini" || provider === "veo") {
    return Boolean(String(process.env.GEMINI_API_KEY ?? "").trim());
  }
  return isComfyVideoConfigured();
}

function resolveWorkflowPath(raw: string): string {
  const p = raw.trim();
  if (path.isAbsolute(p)) return p;
  return path.join(process.cwd(), p);
}

function unwrapWorkflow(raw: unknown): ApiWorkflow {
  if (!raw || typeof raw !== "object") throw new Error("ComfyUI video workflow: empty or invalid JSON");
  const o = raw as Record<string, unknown>;
  if (o.prompt && typeof o.prompt === "object") {
    return o.prompt as ApiWorkflow;
  }
  return raw as ApiWorkflow;
}

function deepClone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

export function buildWanI2vPrompt(shotName: string, handedness: string): string {
  const shot = shotName.trim() || "padel shot";
  const hand = handedness.trim() && handedness !== "unknown" ? `${handedness} ` : "";
  return (
    `Photorealistic padel tennis, ${hand}${shot}. ` +
    `Same person as the start frame, same clothing, same court and lighting. ` +
    `Natural athletic motion, camera locked, keep the racket and ball if visible.`
  );
}

export async function generateCorrectedVideoComfy(opts: {
  analysisId: string;
  frameNumber: number;
  imageBuffer: Buffer;
  shotName: string;
  handedness: string;
}): Promise<Buffer> {
  if (!isComfyTi2vConfigured()) {
    throw new Error("COMFYUI_BASE_URL and COMFYUI_VIDEO_WORKFLOW_PATH are required");
  }

  const baseUrl = String(process.env.COMFYUI_BASE_URL).trim();
  const workflowPath = resolveWorkflowPath(String(process.env.COMFYUI_VIDEO_WORKFLOW_PATH));
  const timeoutMs = Math.max(Number(process.env.COMFYUI_TIMEOUT_MS) || 0, 900_000);
  const t0 = Date.now();
  const prefixId = opts.analysisId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 12);

  let fileJson: string;
  try {
    fileJson = await fs.readFile(workflowPath, "utf8");
  } catch {
    throw new Error(`Failed to read WAN workflow: ${workflowPath}`);
  }

  const template = unwrapWorkflow(JSON.parse(fileJson));
  const workflow = deepClone(template);

  const ksampler = workflow[KSAMPLER_NODE_ID];
  if (!ksampler?.inputs) throw new Error("WAN workflow missing KSampler node 3");
  ksampler.inputs.steps = 8;

  const latent = workflow[LATENT_NODE_ID];
  if (!latent?.inputs) throw new Error("WAN workflow missing Wan22ImageToVideoLatent node 55");
  latent.inputs.width = 832;
  latent.inputs.height = 480;
  latent.inputs.length = 17;

  const save = workflow[SAVE_VIDEO_NODE_ID];
  if (!save?.inputs) throw new Error("WAN workflow missing SaveVideo node 58");
  save.inputs.filename_prefix = `video/xevo_wan_${prefixId || "clip"}`;

  const positive = workflow[POSITIVE_NODE_ID];
  if (!positive?.inputs) throw new Error("WAN workflow missing CLIPTextEncode node 6");
  positive.inputs.text = buildWanI2vPrompt(opts.shotName, opts.handedness);

  const startName = `xevo_wan_start_${prefixId}_${opts.frameNumber}.png`;
  try {
    const uploaded = await comfyUploadImage(baseUrl, opts.imageBuffer, startName);
    const loadName = uploaded.subfolder
      ? `${uploaded.subfolder.replace(/\/+$/, "")}/${uploaded.name}`
      : uploaded.name;

    workflow[LOAD_IMAGE_NODE_ID] = {
      class_type: "LoadImage",
      inputs: { image: loadName },
    };
    latent.inputs.start_image = [LOAD_IMAGE_NODE_ID, 0];

    console.log("[comfyVideo] TI2V queue", {
      analysisId: opts.analysisId,
      comfyHost: comfyBaseHost(),
      workflow: path.basename(workflowPath),
      startImage: loadName,
      timeoutMs,
    });

    const queued = await comfyQueuePrompt(baseUrl, workflow);
    console.log("[comfyVideo] TI2V queued", {
      analysisId: opts.analysisId,
      promptId: queued.prompt_id,
    });
    const media = await comfyWaitForOutputMedia(baseUrl, queued.prompt_id, { timeoutMs });
    const viewed = await comfyViewToBuffer(baseUrl, media.filename, media.subfolder, media.type);
    if (!viewed.buffer.length) {
      throw new Error("ComfyUI /view returned an empty video");
    }
    console.log("[comfyVideo] TI2V done", {
      analysisId: opts.analysisId,
      promptId: queued.prompt_id,
      filename: media.filename,
      bytes: viewed.buffer.length,
      elapsedMs: Date.now() - t0,
    });
    return viewed.buffer;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[comfyVideo] TI2V failed", {
      analysisId: opts.analysisId,
      comfyHost: comfyBaseHost(),
      workflow: path.basename(workflowPath),
      message: msg,
      elapsedMs: Date.now() - t0,
    });
    throw e;
  }
}

const FUN_LOAD_IMAGE_NODE_ID = "145";
const FUN_LOAD_VIDEO_NODE_ID = "158";
const FUN_POSITIVE_NODE_ID = "99";
const FUN_NEGATIVE_NODE_ID = "91";
const FUN_CONTROL_NODE_ID = "160";
const FUN_SAVE_VIDEO_NODE_ID = "98";
const FUN_HIGH_SAMPLER_NODE_ID = "96";
const FUN_LOW_SAMPLER_NODE_ID = "95";
const FUN_CREATE_VIDEO_NODE_ID = "100";
const FUN_CONTROL_CFG = 3.5;

/**
 * Total sampling steps, split evenly between the high-noise and low-noise experts.
 *
 * 30 was tried against the blocky texture and did not touch it, because the texture came from
 * the canvas size rather than under-sampling; it only tripled the runtime. Back to 20, which is
 * what the clean output was sampled at. Env-overridable for tuning sweeps.
 */
function funControlSteps(): number {
  const n = Number(process.env.CORRECTION_FUN_STEPS);
  if (Number.isFinite(n) && n >= 4 && n <= 80) return Math.floor(n);
  return 20;
}

export function buildWanFunControlPrompt(shotName: string, handedness: string): string {
  const shot = shotName.trim() || "padel shot";
  const hand =
    handedness.trim() && handedness !== "unknown" ? handedness.trim() : "right-handed";
  return (
    `Photorealistic professional padel tennis action. The exact same player from the start frame, with identical face, body proportions, hairstyle, clothing, shoes, accessories, court environment, lighting, shadows, and camera perspective. ` +
    `The player is ${hand} and performs a realistic ${shot}, accurately following the provided pose skeleton. Natural biomechanics, correct body rotation, believable weight transfer, realistic arm and wrist position, and anatomically correct hands. ` +
    `Camera remains completely locked: no camera movement, zoom, reframing, perspective change, or lens change. ` +
    `The player holds exactly one normal-sized professional padel racket with realistic proportions. ` +
    `Ball continuity — critical. There is exactly ONE padel ball in the entire scene at all times. It must be the same physical ball visible in the start frame. Preserve its identity and visual continuity throughout the motion. ` +
    `The player must make realistic racket contact with that exact same ball during the ${shot}. The ball may naturally change position according to the action, but never duplicate, replace, regenerate, or introduce another ball. ` +
    `At no point may two balls appear simultaneously, including during motion blur, racket contact, or immediately before/after impact. ` +
    `Maintain strict temporal consistency and photorealism throughout.`
  );
}

export type CoachingVideoContext = {
  /** Coach diagnosis for this clip (locale-picked upstream). */
  diagnosis?: string | null;
  recommendations?: string[];
  /** Formatted `JOINT: current (x,y) -> target (x,y)` lines, highest priority first. */
  jointMoves?: string[];
  timing?: {
    prepToImpactMs?: number | null;
    impactToFollowMs?: number | null;
  } | null;
  /** You-vs-pro joint angles in degrees, e.g. `shoulder 96 -> 118`. */
  angleTargets?: string[];
};

function trimList(items: string[] | undefined, max: number): string[] {
  return (items ?? [])
    .map((s) => String(s ?? "").trim())
    .filter((s) => s.length > 0)
    .slice(0, max);
}

function timingIntentLines(timing: CoachingVideoContext["timing"]): string[] {
  if (!timing) return [];
  const out: string[] = [];
  const prep = timing.prepToImpactMs;
  const follow = timing.impactToFollowMs;
  if (typeof prep === "number" && Number.isFinite(prep) && prep > 0) {
    out.push(
      `Preparation to contact took about ${Math.round(prep)} ms — begin the upward drive and racket lift earlier so the body is loaded before contact.`
    );
  }
  if (typeof follow === "number" && Number.isFinite(follow) && follow > 0) {
    out.push(
      `Contact to follow-through took about ${Math.round(follow)} ms — carry the racket arm further through the finish instead of stopping at the ball.`
    );
  }
  return out;
}

/**
 * Fun Control prompt carrying the coaching intent (diagnosis, joint targets, timing) rather than
 * only shot + handedness. The pose skeleton says where limbs go; this says what is being fixed and why,
 * so the model shapes a correction instead of tracing points.
 */
export function buildWanFunControlCoachingPrompt(
  shotName: string,
  handedness: string,
  ctx: CoachingVideoContext
): string {
  const shot = shotName.trim() || "padel shot";
  const hand =
    handedness.trim() && handedness !== "unknown" ? handedness.trim() : "right-handed";

  const moves = trimList(ctx.jointMoves, 5);
  const recs = trimList(ctx.recommendations, 3);
  const angles = trimList(ctx.angleTargets, 4);
  const timing = timingIntentLines(ctx.timing);
  const diagnosis = String(ctx.diagnosis ?? "").trim();

  const sections: string[] = [
    `Photorealistic professional padel tennis action. The exact same player from the reference frame, with identical face, body proportions, hairstyle, clothing, shoes, accessories, court environment, lighting, shadows, and camera perspective. ` +
      `The player is ${hand} and performs a realistic ${shot}, following the provided pose skeleton as a coaching guide for limb placement. ` +
      `Natural biomechanics, correct body rotation, believable weight transfer, realistic arm and wrist position, and anatomically correct hands.`,
  ];

  sections.push(
    `COACHING INTENT — this clip demonstrates the corrected version of this player's own swing. Keep the athlete, court, and camera identical; change only how the body moves.`
  );

  if (diagnosis) {
    sections.push(`WHAT WENT WRONG: ${diagnosis}`);
  }
  if (moves.length) {
    sections.push(
      `PRIORITY BODY CHANGES (normalized frame coords, current -> target):\n${moves
        .map((m, i) => `${i + 1}. ${m}`)
        .join("\n")}`
    );
  }
  if (angles.length) {
    sections.push(`JOINT ANGLE TARGETS (degrees, you -> pro): ${angles.join("; ")}`);
  }
  if (timing.length) {
    sections.push(`MOTION TIMING:\n${timing.join("\n")}`);
  }
  if (recs.length) {
    sections.push(
      `COACH CUES TO EXPRESS IN THE MOVEMENT:\n${recs.map((r, i) => `${i + 1}. ${r}`).join("\n")}`
    );
  }

  sections.push(
    `Camera remains completely locked: no camera movement, zoom, reframing, perspective change, or lens change. ` +
      `The player holds exactly one normal-sized professional padel racket with realistic proportions. ` +
      `Ball continuity — critical. There is exactly ONE padel ball in the entire scene at all times. It must be the same physical ball visible in the reference frame. Preserve its identity and visual continuity throughout the motion. ` +
      `The player must make realistic racket contact with that exact same ball during the ${shot}. The ball may naturally change position according to the action, but never duplicate, replace, regenerate, or introduce another ball. ` +
      `At no point may two balls appear simultaneously, including during motion blur, racket contact, or immediately before/after impact. ` +
      `Maintain strict temporal consistency and photorealism throughout.`
  );

  return sections.join("\n\n");
}

/** True when there is enough analysis text to justify the coaching prompt over the generic one. */
export function hasCoachingVideoContext(ctx?: CoachingVideoContext | null): boolean {
  if (!ctx) return false;
  return Boolean(
    String(ctx.diagnosis ?? "").trim() ||
      trimList(ctx.jointMoves, 1).length ||
      trimList(ctx.recommendations, 1).length ||
      trimList(ctx.angleTargets, 1).length ||
      timingIntentLines(ctx.timing).length
  );
}

/**
 * Deduplicated: the previous version repeated whole phrase groups two and three times, which
 * spends conditioning weight on repetition rather than coverage.
 *
 * Do not negate softness (blurry / low detail / mushy texture). On a bilinear-upscaled
 * identity frame that pushes WAN to invent a 16px DiT patch grid instead of staying smooth.
 */
export function buildWanFunControlNegativePrompt(): string {
  return (
    "extra ball, multiple balls, duplicate ball, cloned ball, ghost ball, floating ball, ball trail, invented ball, inconsistent ball identity, ball appearing from nowhere, " +
    "extra racket, duplicate racket, deformed racket, warped racket, oversized racket, oversized paddle, tiny racket, " +
    "different person, changed face, changed identity, changed clothing, changed shoes, changed court, changed background, changed lighting, changed camera angle, " +
    "camera movement, camera shake, zoom, crop, reframing, perspective shift, " +
    "incorrect grip, impossible racket angle, incorrect handedness, anatomically impossible pose, broken wrist, twisted arm, extra arm, extra hand, extra fingers, missing fingers, malformed hands, duplicated limbs, distorted anatomy, " +
    "incorrect ball contact, ball far from racket, unrealistic contact point, unrealistic padel technique, " +
    "cartoon, illustration, CGI, 3D render, artificial skin, unrealistic proportions"
  );
}

export async function generatePoseRetargetVideoComfy(opts: {
  analysisId: string;
  frameNumber: number;
  imageBuffer: Buffer;
  poseVideoBuffer: Buffer;
  shotName: string;
  handedness: string;
  length?: number;
  /** Control-clip canvas; defaults to the legacy 768 square when omitted. */
  width?: number;
  height?: number;
  /** Coaching text; falls back to the generic shot prompt when empty. */
  coaching?: CoachingVideoContext | null;
}): Promise<Buffer> {
  if (!isComfyFunControlConfigured()) {
    throw new Error("COMFYUI_BASE_URL and COMFYUI_FUN_CONTROL_WORKFLOW_PATH are required");
  }

  const baseUrl = envBaseUrl();
  const workflowPath = resolveWorkflowPath(
    String(process.env.COMFYUI_FUN_CONTROL_WORKFLOW_PATH)
  );
  // Measured 445s for 848x1024 at 33 frames and 30 steps, so the old 420s ceiling would have
  // killed the render it was waiting for. Video gets its own floor rather than sharing the
  // image pipeline's shorter one.
  const timeoutMs = Math.max(Number(process.env.COMFYUI_TIMEOUT_MS) || 0, 900_000);
  const length = opts.length ?? correctionFunLength();
  const t0 = Date.now();
  const prefixId = opts.analysisId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 12);

  let fileJson: string;
  try {
    fileJson = await fs.readFile(workflowPath, "utf8");
  } catch {
    throw new Error(`Failed to read Fun Control workflow: ${workflowPath}`);
  }

  const template = unwrapWorkflow(JSON.parse(fileJson));
  const workflow = deepClone(template);

  const control = workflow[FUN_CONTROL_NODE_ID];
  if (!control?.inputs) {
    throw new Error("Fun Control workflow missing Wan22FunControlToVideo node 160");
  }
  const outWidth = opts.width && opts.width > 0 ? opts.width : correctionCanvasSize();
  const outHeight = opts.height && opts.height > 0 ? opts.height : correctionCanvasSize();
  control.inputs.width = outWidth;
  control.inputs.height = outHeight;
  control.inputs.length = length;

  const save = workflow[FUN_SAVE_VIDEO_NODE_ID];
  if (!save?.inputs) throw new Error("Fun Control workflow missing SaveVideo node 98");
  save.inputs.filename_prefix = `video/xevo_fun_${prefixId || "clip"}`;

  const positive = workflow[FUN_POSITIVE_NODE_ID];
  if (!positive?.inputs) {
    throw new Error("Fun Control workflow missing CLIPTextEncode node 99");
  }
  const useCoachingPrompt = hasCoachingVideoContext(opts.coaching);
  positive.inputs.text = useCoachingPrompt
    ? buildWanFunControlCoachingPrompt(
        opts.shotName,
        opts.handedness,
        opts.coaching as CoachingVideoContext
      )
    : buildWanFunControlPrompt(opts.shotName, opts.handedness);
  const negative = workflow[FUN_NEGATIVE_NODE_ID];
  if (negative?.inputs) {
    negative.inputs.text = buildWanFunControlNegativePrompt();
  }

  const steps = funControlSteps();
  const highEnd = Math.max(1, Math.round(steps / 2));
  const highSampler = workflow[FUN_HIGH_SAMPLER_NODE_ID];
  if (highSampler?.inputs) {
    highSampler.inputs.noise_seed = Date.now() % 1_000_000_000;
    highSampler.inputs.steps = steps;
    highSampler.inputs.cfg = FUN_CONTROL_CFG;
    highSampler.inputs.start_at_step = 0;
    highSampler.inputs.end_at_step = highEnd;
  }
  const lowSampler = workflow[FUN_LOW_SAMPLER_NODE_ID];
  if (lowSampler?.inputs) {
    lowSampler.inputs.steps = steps;
    lowSampler.inputs.cfg = FUN_CONTROL_CFG;
    lowSampler.inputs.start_at_step = highEnd;
    lowSampler.inputs.end_at_step = steps;
  }

  // The control clip is encoded at this rate, so the output has to match or the swing
  // plays back at the wrong speed.
  const fps = correctionFunFps();
  const createVideo = workflow[FUN_CREATE_VIDEO_NODE_ID];
  if (createVideo?.inputs) createVideo.inputs.fps = fps;

  try {
    const uploadedImage = await comfyUploadImage(
      baseUrl,
      opts.imageBuffer,
      `xevo_fun_start_${prefixId}_${opts.frameNumber}.png`
    );
    const imageName = uploadedImage.subfolder
      ? `${uploadedImage.subfolder.replace(/\/+$/, "")}/${uploadedImage.name}`
      : uploadedImage.name;

    const uploadedVideo = await comfyUploadVideo(
      baseUrl,
      opts.poseVideoBuffer,
      `xevo_fun_pose_${prefixId}_${opts.frameNumber}.mp4`
    );
    const videoName = uploadedVideo.subfolder
      ? `${uploadedVideo.subfolder.replace(/\/+$/, "")}/${uploadedVideo.name}`
      : uploadedVideo.name;

    workflow[FUN_LOAD_IMAGE_NODE_ID] = {
      class_type: "LoadImage",
      inputs: { image: imageName },
    };
    workflow[FUN_LOAD_VIDEO_NODE_ID] = {
      class_type: "LoadVideo",
      inputs: { file: videoName },
    };
    control.inputs.ref_image = [FUN_LOAD_IMAGE_NODE_ID, 0];
    const components = workflow["156"];
    if (components?.inputs) {
      components.inputs.video = [FUN_LOAD_VIDEO_NODE_ID, 0];
      control.inputs.control_video = ["156", 0];
    }

    console.log("[comfyVideo] Fun Control queue", {
      analysisId: opts.analysisId,
      comfyHost: comfyBaseHost(),
      workflow: path.basename(workflowPath),
      startImage: imageName,
      poseVideo: videoName,
      length,
      size: `${outWidth}x${outHeight}`,
      fps,
      steps,
      model: String(workflow["101"]?.inputs?.unet_name ?? "?").includes("fp8")
        ? "fp8"
        : "bf16",
      prompt: useCoachingPrompt ? "coaching" : "generic",
      timeoutMs,
    });

    const queued = await comfyQueuePrompt(baseUrl, workflow);
    console.log("[comfyVideo] Fun Control queued", {
      analysisId: opts.analysisId,
      promptId: queued.prompt_id,
    });
    const media = await comfyWaitForOutputMedia(baseUrl, queued.prompt_id, { timeoutMs });
    const viewed = await comfyViewToBuffer(baseUrl, media.filename, media.subfolder, media.type);
    if (!viewed.buffer.length) {
      throw new Error("ComfyUI /view returned an empty Fun Control video");
    }
    console.log("[comfyVideo] Fun Control done", {
      analysisId: opts.analysisId,
      promptId: queued.prompt_id,
      filename: media.filename,
      bytes: viewed.buffer.length,
      elapsedMs: Date.now() - t0,
    });
    return viewed.buffer;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[comfyVideo] Fun Control failed", {
      analysisId: opts.analysisId,
      comfyHost: comfyBaseHost(),
      workflow: path.basename(workflowPath),
      message: msg,
      elapsedMs: Date.now() - t0,
    });
    throw e;
  }
}
