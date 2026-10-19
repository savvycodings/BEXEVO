import fs from "fs/promises";
import path from "path";
import {
  comfyQueuePrompt,
  comfyUploadImage,
  comfyUploadVideo,
  comfyViewToBuffer,
  comfyWaitForOutputMedia,
  withComfyVideoModelSession,
} from "./comfyClient";
import {
  CORRECTION_CANVAS_SIZE,
  CORRECTION_FUN_CONTROL_END,
  CORRECTION_FUN_CONTROL_TAIL,
  CORRECTION_FUN_FPS,
  CORRECTION_FUN_LENGTH,
} from "./openPoseVideo";

type ApiWorkflow = Record<string, { class_type?: string; inputs?: Record<string, unknown> }>;

const LOAD_IMAGE_NODE_ID = "59";
const KSAMPLER_NODE_ID = "3";
const POSITIVE_NODE_ID = "6";
const NEGATIVE_NODE_ID = "7";
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
    `Same person as the start frame, same face, same clothing, same court and lighting. ` +
    `Natural athletic motion, camera locked. ` +
    racketSentence("start") +
    `Keep the ball only if it is visible in the start frame; otherwise no ball appears.`
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
  const latentInputs = latent?.inputs;
  if (!latentInputs) throw new Error("WAN workflow missing Wan22ImageToVideoLatent node 55");
  latentInputs.width = 832;
  latentInputs.height = 480;
  latentInputs.length = 17;

  const save = workflow[SAVE_VIDEO_NODE_ID];
  if (!save?.inputs) throw new Error("WAN workflow missing SaveVideo node 58");
  save.inputs.filename_prefix = `video/xevo_wan_${prefixId || "clip"}`;

  const positive = workflow[POSITIVE_NODE_ID];
  if (!positive?.inputs) throw new Error("WAN workflow missing CLIPTextEncode node 6");
  positive.inputs.text = buildWanI2vPrompt(opts.shotName, opts.handedness);
  const negative = workflow[NEGATIVE_NODE_ID];
  if (negative?.inputs) negative.inputs.text = buildWanFunControlNegativePrompt();

  const startName = `xevo_wan_start_${prefixId}_${opts.frameNumber}.png`;
  return withComfyVideoModelSession(baseUrl, async () => {
    try {
      const uploaded = await comfyUploadImage(baseUrl, opts.imageBuffer, startName);
      const loadName = uploaded.subfolder
        ? `${uploaded.subfolder.replace(/\/+$/, "")}/${uploaded.name}`
        : uploaded.name;

      workflow[LOAD_IMAGE_NODE_ID] = {
        class_type: "LoadImage",
        inputs: { image: loadName },
      };
      latentInputs.start_image = [LOAD_IMAGE_NODE_ID, 0];

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
  });
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
 * what the clean output was sampled at.
 */
const FUN_CONTROL_STEPS = 20;

const FUN_TAIL_CONTROL_NODE_ID = "161";
const FUN_TAIL_LOAD_VIDEO_NODE_ID = "162";
const FUN_TAIL_COMPONENTS_NODE_ID = "163";
const FUN_TAIL_SAMPLER_NODE_ID = "164";

/**
 * Step at which the full skeleton hands over to the tail conditioning. Clamped to the high/low
 * expert switch at the earliest, so the motion is always laid out under the full skeleton.
 */
export function funControlEndStep(steps: number, highEnd: number, fraction = CORRECTION_FUN_CONTROL_END): number {
  return Math.max(highEnd, Math.min(steps, Math.round(steps * fraction)));
}

/** Fraction of steps on the full skeleton, and what the remaining steps see. */
export type FunControlHandoff = { end: number; tail: "soft" | "none" };

/** Sampling steps, expert switch and skeleton hand-off a Fun Control render will use. */
export function funControlHandoffPlan(
  handoff: FunControlHandoff = { end: CORRECTION_FUN_CONTROL_END, tail: CORRECTION_FUN_CONTROL_TAIL }
): {
  steps: number;
  highEnd: number;
  controlEndStep: number;
  tail: "soft" | "none";
  /** True when some steps run without the full skeleton. */
  active: boolean;
} {
  const steps = FUN_CONTROL_STEPS;
  const highEnd = Math.max(1, Math.round(steps / 2));
  const controlEndStep = funControlEndStep(steps, highEnd, Math.max(0.5, Math.min(1, handoff.end)));
  return { steps, highEnd, controlEndStep, tail: handoff.tail, active: controlEndStep < steps };
}

/**
 * Splits the low-noise pass at `controlEndStep`: steps up to it keep node 160's full skeleton,
 * the rest run on a copy of node 160 (same prompts, same reference image) whose control is the
 * soft skeleton video, or omitted for `none`. Whatever read the low sampler's latent (the VAE
 * decode) reads the tail sampler's instead. No-op when the hand-off is at the last step.
 */
export function applyControlHandoff(
  workflow: ApiWorkflow,
  opts: { steps: number; controlEndStep: number; tail: "soft" | "none"; softVideoName?: string | null }
): void {
  if (opts.controlEndStep >= opts.steps) return;
  const control = workflow[FUN_CONTROL_NODE_ID];
  const low = workflow[FUN_LOW_SAMPLER_NODE_ID];
  if (!control?.inputs || !low?.inputs) {
    throw new Error("Fun Control workflow missing node 160 or low sampler 95 for the control hand-off");
  }

  const tailControl = deepClone(control);
  const tailInputs = tailControl.inputs!;
  if (opts.tail === "soft" && opts.softVideoName) {
    workflow[FUN_TAIL_LOAD_VIDEO_NODE_ID] = {
      class_type: "LoadVideo",
      inputs: { file: opts.softVideoName },
    };
    workflow[FUN_TAIL_COMPONENTS_NODE_ID] = {
      class_type: "GetVideoComponents",
      inputs: { video: [FUN_TAIL_LOAD_VIDEO_NODE_ID, 0] },
    };
    tailInputs.control_video = [FUN_TAIL_COMPONENTS_NODE_ID, 0];
  } else {
    delete tailInputs.control_video;
  }
  workflow[FUN_TAIL_CONTROL_NODE_ID] = tailControl;

  for (const [id, node] of Object.entries(workflow)) {
    if (id === FUN_LOW_SAMPLER_NODE_ID || !node.inputs) continue;
    for (const [key, v] of Object.entries(node.inputs)) {
      if (Array.isArray(v) && v[0] === FUN_LOW_SAMPLER_NODE_ID && v[1] === 0) {
        node.inputs[key] = [FUN_TAIL_SAMPLER_NODE_ID, 0];
      }
    }
  }

  const tailSampler = deepClone(low);
  Object.assign(tailSampler.inputs!, {
    add_noise: "disable",
    start_at_step: opts.controlEndStep,
    end_at_step: opts.steps,
    return_with_leftover_noise: "disable",
    positive: [FUN_TAIL_CONTROL_NODE_ID, 0],
    negative: [FUN_TAIL_CONTROL_NODE_ID, 1],
    latent_image: [FUN_LOW_SAMPLER_NODE_ID, 0],
  });
  workflow[FUN_TAIL_SAMPLER_NODE_ID] = tailSampler;

  low.inputs.end_at_step = opts.controlEndStep;
  low.inputs.return_with_leftover_noise = "enable";
}

/** Video models default to a strung tennis racket unless the padel racket is spelled out. */
function racketSentence(frame: "start" | "reference"): string {
  return (
    `The player holds exactly one padel racket, the same one as in the ${frame} frame: a solid perforated face with no strings, a short handle, normal size, and the same color and design throughout. `
  );
}

/**
 * Conditional on the frame: asserting a ball "visible in the start frame" when there is none
 * makes the model invent one mid-clip.
 */
function ballContinuitySentence(frame: "start" | "reference", shot: string): string {
  return (
    racketSentence(frame) +
    `Ball continuity — critical. If a padel ball is visible in the ${frame} frame, there is exactly ONE padel ball in the entire scene at all times, the same physical ball. Preserve its identity and visual continuity throughout the motion. ` +
    `The player must make realistic racket contact with that exact same ball during the ${shot}. The ball may naturally change position according to the action, but never duplicate, replace, regenerate, or introduce another ball. ` +
    `If no ball is visible in the ${frame} frame, no ball appears at any point. ` +
    `At no point may two balls appear simultaneously, including during motion blur, racket contact, or immediately before/after impact. `
  );
}

/**
 * How hard the prompt tells the model to obey the skeleton. `strict` asks for exact copying;
 * `loose` lets its sense of natural movement override small skeleton errors.
 */
export type PoseGuidance = "strict" | "loose";

export function buildWanFunControlPrompt(
  shotName: string,
  handedness: string,
  poseGuidance: PoseGuidance = "strict"
): string {
  const shot = shotName.trim() || "padel shot";
  const hand =
    handedness.trim() && handedness !== "unknown" ? handedness.trim() : "right-handed";
  const follow =
    poseGuidance === "loose"
      ? "guided by the pose skeleton, with natural padel movement"
      : "accurately following the provided pose skeleton";
  return (
    `Photorealistic professional padel tennis action. The exact same player from the start frame, with identical face, body proportions, hairstyle, clothing, shoes, accessories, court environment, lighting, shadows, and camera perspective. ` +
    `The player is ${hand} and performs a realistic ${shot}, ${follow}. Natural biomechanics, correct body rotation, believable weight transfer, realistic arm and wrist position, and anatomically correct hands. ` +
    `Camera remains completely locked: no camera movement, zoom, reframing, perspective change, or lens change. ` +
    ballContinuitySentence("start", shot) +
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
      ballContinuitySentence("reference", shot) +
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
    "extra racket, duplicate racket, deformed racket, warped racket, oversized racket, oversized paddle, tiny racket, tennis racket, strung racket, racket strings, racket changing color, " +
    "different person, changed face, changed identity, changed clothing, changed shoes, changed court, changed background, changed lighting, changed camera angle, " +
    "camera movement, camera shake, zoom, crop, reframing, perspective shift, " +
    "incorrect grip, impossible racket angle, incorrect handedness, anatomically impossible pose, broken wrist, twisted arm, elongated arms, stretched limbs, extra arm, extra hand, extra fingers, missing fingers, malformed hands, duplicated limbs, distorted anatomy, " +
    "incorrect ball contact, ball far from racket, unrealistic contact point, unrealistic padel technique, " +
    "cartoon, illustration, CGI, 3D render, artificial skin, unrealistic proportions"
  );
}

export async function generatePoseRetargetVideoComfy(opts: {
  analysisId: string;
  frameNumber: number;
  imageBuffer: Buffer;
  poseVideoBuffer: Buffer;
  /** Hand-less, blurred control clip for the polishing steps when the tail is `soft`. */
  softPoseVideoBuffer?: Buffer | null;
  /** Skeleton hand-off; defaults to `CORRECTION_FUN_CONTROL_END` / `CORRECTION_FUN_CONTROL_TAIL`. */
  controlHandoff?: FunControlHandoff;
  shotName: string;
  handedness: string;
  length?: number;
  /** Control-clip canvas; defaults to the legacy 768 square when omitted. */
  width?: number;
  height?: number;
  /** Coaching text; falls back to the generic shot prompt when empty. */
  coaching?: CoachingVideoContext | null;
  poseGuidance?: PoseGuidance;
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
  const length = opts.length ?? CORRECTION_FUN_LENGTH;
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
  const outWidth = opts.width && opts.width > 0 ? opts.width : CORRECTION_CANVAS_SIZE;
  const outHeight = opts.height && opts.height > 0 ? opts.height : CORRECTION_CANVAS_SIZE;
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
  // Coaching dumps (diagnosis + PRIORITY BODY CHANGES coords) bring back the Fun Control
  // token lattice on good bf16 weights. Pose already carries the correction; keep CLIP text
  // on the short generic shot prompt. See docs/texture-investigation/coaching-prompt-lattice.md.
  const hadCoachingContext = hasCoachingVideoContext(opts.coaching);
  positive.inputs.text = buildWanFunControlPrompt(opts.shotName, opts.handedness, opts.poseGuidance);
  const negative = workflow[FUN_NEGATIVE_NODE_ID];
  if (negative?.inputs) {
    negative.inputs.text = buildWanFunControlNegativePrompt();
  }

  const handoff = funControlHandoffPlan(opts.controlHandoff);
  const { steps, highEnd } = handoff;
  const highSampler = workflow[FUN_HIGH_SAMPLER_NODE_ID];
  if (highSampler?.inputs) {
    // Fixed seed only for A/B renders; production varies it per request.
    const fixedSeed = Number(process.env.COMFYUI_FUN_SEED);
    highSampler.inputs.noise_seed =
      process.env.COMFYUI_FUN_SEED && Number.isInteger(fixedSeed) && fixedSeed >= 0
        ? fixedSeed
        : Date.now() % 1_000_000_000;
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
  const fps = CORRECTION_FUN_FPS;
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

    // Without a soft clip the tail falls back to no control rather than the full skeleton.
    let tail: "soft" | "none" = handoff.tail;
    let softVideoName: string | null = null;
    if (handoff.active && tail === "soft") {
      if (opts.softPoseVideoBuffer?.length) {
        const uploadedSoft = await comfyUploadVideo(
          baseUrl,
          opts.softPoseVideoBuffer,
          `xevo_fun_pose_soft_${prefixId}_${opts.frameNumber}.mp4`
        );
        softVideoName = uploadedSoft.subfolder
          ? `${uploadedSoft.subfolder.replace(/\/+$/, "")}/${uploadedSoft.name}`
          : uploadedSoft.name;
      } else {
        tail = "none";
      }
    }
    if (handoff.active) {
      applyControlHandoff(workflow, {
        steps,
        controlEndStep: handoff.controlEndStep,
        tail,
        softVideoName,
      });
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
      controlEndStep: handoff.controlEndStep,
      controlTail: handoff.active ? tail : null,
      model: String(workflow["101"]?.inputs?.unet_name ?? "?").includes("fp8")
        ? "fp8"
        : "bf16",
      prompt: "generic",
      poseGuidance: opts.poseGuidance ?? "strict",
      coachingContextSkipped: hadCoachingContext,
      timeoutMs,
    });

    return withComfyVideoModelSession(baseUrl, async () => {
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
    });
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
