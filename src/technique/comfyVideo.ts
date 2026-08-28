import fs from "fs/promises";
import path from "path";
import {
  comfyQueuePrompt,
  comfyUploadImage,
  comfyUploadVideo,
  comfyViewToBuffer,
  comfyWaitForOutputMedia,
} from "./comfyClient";
import { FUN_CONTROL_LENGTH, FUN_CONTROL_SIZE } from "./openPoseVideo";

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
  const timeoutMs = Number(process.env.COMFYUI_TIMEOUT_MS) || 420_000;
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
const FUN_CONTROL_STEPS = 20;
const FUN_CONTROL_CFG = 3.5;
const FUN_CONTROL_HIGH_END = 10;

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

export function buildWanFunControlNegativePrompt(): string {
  return (
    "extra ball, extra balls, multiple balls, two balls, second ball, duplicate ball, duplicated ball, cloned ball, newly generated ball, replacement ball, ghost ball, floating ball, ball artifact, ball trail resembling another ball, motion blur creating duplicate balls, multiple ball positions visible simultaneously, ball appearing from nowhere, inconsistent ball identity, disappearing and reappearing ball, " +
    "giant racket, oversized racket, oversized racquet, oversized paddle, duplicate racket, extra racket, deformed racket, distorted hands, extra fingers, malformed limbs, incorrect anatomy, changing clothes, changing player identity, changing court, changing lighting, camera movement, camera shake, zoom, reframing, perspective shift, " +
    "extra ball, extra balls, multiple balls, second ball, duplicate ball, duplicated ball, cloned ball, mirrored ball, floating ball, floating balls, background ball, ghost ball, ball trail, motion-trail ball, invented ball, new ball, two balls, three balls, " +
    "extra racket, multiple rackets, duplicate racket, deformed racket, giant racket, oversized racket, oversized racquet, oversized paddle, tiny racket, warped racket, " +
    "different person, changed face, changed identity, changed clothing, changed shoes, changed court, changed background, changed lighting, changed camera angle, camera movement, zoom, crop, perspective change, " +
    "incorrect grip, impossible racket angle, incorrect handedness, anatomically impossible pose, broken wrist, twisted arm, extra arm, extra hand, extra fingers, missing fingers, malformed hands, duplicated limbs, distorted anatomy, " +
    "incorrect ball contact, ball far from racket, racket missing ball, unrealistic contact point, unrealistic padel technique, " +
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
}): Promise<Buffer> {
  if (!isComfyFunControlConfigured()) {
    throw new Error("COMFYUI_BASE_URL and COMFYUI_FUN_CONTROL_WORKFLOW_PATH are required");
  }

  const baseUrl = envBaseUrl();
  const workflowPath = resolveWorkflowPath(
    String(process.env.COMFYUI_FUN_CONTROL_WORKFLOW_PATH)
  );
  const timeoutMs = Number(process.env.COMFYUI_TIMEOUT_MS) || 420_000;
  const length = opts.length ?? FUN_CONTROL_LENGTH;
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
  control.inputs.width = FUN_CONTROL_SIZE;
  control.inputs.height = FUN_CONTROL_SIZE;
  control.inputs.length = length;

  const save = workflow[FUN_SAVE_VIDEO_NODE_ID];
  if (!save?.inputs) throw new Error("Fun Control workflow missing SaveVideo node 98");
  save.inputs.filename_prefix = `video/xevo_fun_${prefixId || "clip"}`;

  const positive = workflow[FUN_POSITIVE_NODE_ID];
  if (!positive?.inputs) {
    throw new Error("Fun Control workflow missing CLIPTextEncode node 99");
  }
  positive.inputs.text = buildWanFunControlPrompt(opts.shotName, opts.handedness);
  const negative = workflow[FUN_NEGATIVE_NODE_ID];
  if (negative?.inputs) {
    negative.inputs.text = buildWanFunControlNegativePrompt();
  }

  const highSampler = workflow[FUN_HIGH_SAMPLER_NODE_ID];
  if (highSampler?.inputs) {
    highSampler.inputs.noise_seed = Date.now() % 1_000_000_000;
    highSampler.inputs.steps = FUN_CONTROL_STEPS;
    highSampler.inputs.cfg = FUN_CONTROL_CFG;
    highSampler.inputs.start_at_step = 0;
    highSampler.inputs.end_at_step = FUN_CONTROL_HIGH_END;
  }
  const lowSampler = workflow[FUN_LOW_SAMPLER_NODE_ID];
  if (lowSampler?.inputs) {
    lowSampler.inputs.steps = FUN_CONTROL_STEPS;
    lowSampler.inputs.cfg = FUN_CONTROL_CFG;
    lowSampler.inputs.start_at_step = FUN_CONTROL_HIGH_END;
    lowSampler.inputs.end_at_step = FUN_CONTROL_STEPS;
  }

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
      size: FUN_CONTROL_SIZE,
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
