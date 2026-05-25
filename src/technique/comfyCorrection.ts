import fs from "fs/promises";
import path from "path";
import {
  buildQwenCorrectionPrompt,
  buildSdxlCorrectionPrompt,
  resolveCorrectionPromptIntensity,
  type CorrectionPromptIntensity,
  type FrameLandmarks,
  type LandmarkDelta,
  type ShotAndHandedness,
} from "./correctionPrompt";
import {
  comfyImageToDataUri,
  comfyQueuePrompt,
  comfyUploadImage,
  comfyWaitForOutputImage,
} from "./comfyClient";
import {
  buildCoachingInpaintMaskPng,
  dimensionsForMegapixels,
  readImageDimensions,
} from "./poseMask";

export function isComfyCorrectionConfigured(): boolean {
  const base = String(process.env.COMFYUI_BASE_URL ?? "").trim();
  const wf = String(process.env.COMFYUI_WORKFLOW_PATH ?? "").trim();
  return base.length > 0 && wf.length > 0;
}

function resolveWorkflowPath(raw: string): string {
  const p = raw.trim();
  if (path.isAbsolute(p)) return p;
  return path.join(process.cwd(), p);
}

type ApiWorkflow = Record<string, { class_type?: string; inputs?: Record<string, unknown> }>;

function unwrapWorkflow(raw: unknown): ApiWorkflow {
  if (!raw || typeof raw !== "object") throw new Error("ComfyUI workflow: empty or invalid JSON");
  const o = raw as Record<string, unknown>;
  if (o.prompt && typeof o.prompt === "object") {
    return o.prompt as ApiWorkflow;
  }
  return raw as ApiWorkflow;
}

function deepClone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

function parseEnvFloat(key: string, fallback: number): number {
  const raw = String(process.env[key] ?? "").trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export type CorrectionIntensityProfile = {
  intensity: CorrectionPromptIntensity;
  denoise: number;
  cnStrengthPro: number;
  cnStrengthPlayer: number;
  maskDilatePct: number;
  refMegapixels: number;
};

/** Default coaching profile; `COMFYUI_CORRECTION_INTENSITY=subtle` for lighter edits. */
export function resolveCorrectionIntensity(): CorrectionIntensityProfile {
  const intensity = resolveCorrectionPromptIntensity();
  const coaching = intensity === "coaching";

  return {
    intensity,
    denoise: parseEnvFloat(
      "COMFYUI_DENOISE",
      coaching ? 0.92 : 0.82
    ),
    cnStrengthPro: parseEnvFloat(
      "COMFYUI_CONTROLNET_STRENGTH_PRO",
      coaching ? 0.78 : 0.55
    ),
    cnStrengthPlayer: parseEnvFloat(
      "COMFYUI_CONTROLNET_STRENGTH",
      0.35
    ),
    maskDilatePct: parseEnvFloat(
      "COMFYUI_MASK_DILATE_PCT",
      coaching ? 0.2 : 0.12
    ),
    refMegapixels: parseEnvFloat(
      "COMFYUI_REF_MEGAPIXELS",
      coaching ? 1.0 : 0.6
    ),
  };
}

function patchOpenPoseControlNetForCorrection(
  workflow: ApiWorkflow,
  hasProReferenceImage: boolean,
  profile: CorrectionIntensityProfile
): { poseSourceNode: string; controlnetStrength: number } {
  const openposeId = String(process.env.COMFYUI_OPENPOSE_NODE_ID ?? "96").trim() || "96";
  const cnApplyId = String(process.env.COMFYUI_CONTROLNET_APPLY_NODE_ID ?? "97").trim() || "97";
  const playerScaleId =
    String(process.env.COMFYUI_OPENPOSE_SCALE_NODE_PLAYER ?? "90").trim() || "90";
  const proScaleId = String(process.env.COMFYUI_OPENPOSE_SCALE_NODE_PRO ?? "91").trim() || "91";

  const openposeNode = workflow[openposeId];
  const cnNode = workflow[cnApplyId];
  if (!openposeNode?.inputs) {
    return { poseSourceNode: playerScaleId, controlnetStrength: profile.cnStrengthPlayer };
  }

  const poseSource = hasProReferenceImage ? proScaleId : playerScaleId;
  openposeNode.inputs.image = [poseSource, 0];

  const strength = hasProReferenceImage
    ? profile.cnStrengthPro
    : profile.cnStrengthPlayer;

  if (cnNode?.inputs) {
    cnNode.inputs.strength = strength;
  }

  return { poseSourceNode: poseSource, controlnetStrength: strength };
}

function patchKsamplerDenoise(workflow: ApiWorkflow, denoise: number): void {
  const samplerId = String(process.env.COMFYUI_KSAMPLER_NODE_ID ?? "65").trim() || "65";
  const node = workflow[samplerId];
  if (node?.inputs) {
    node.inputs.denoise = denoise;
  }
}

function patchRefMegapixels(workflow: ApiWorkflow, megapixels: number): void {
  const scaleId = String(process.env.COMFYUI_REF_SCALE_NODE_ID ?? "91").trim() || "91";
  const node = workflow[scaleId];
  if (node?.inputs) {
    node.inputs.megapixels = megapixels;
  }
}

function readWorkflowMegapixels(workflow: ApiWorkflow, nodeId: string, fallback: number): number {
  const node = workflow[nodeId];
  const mp = node?.inputs?.megapixels;
  if (typeof mp === "number" && Number.isFinite(mp) && mp > 0) return mp;
  return fallback;
}

function patchNodeMegapixels(workflow: ApiWorkflow, nodeId: string, megapixels: number): void {
  const node = workflow[nodeId];
  if (node?.inputs) {
    node.inputs.megapixels = megapixels;
  }
}

/** Same MP as player scale node 90 (and optional mask scale 98) for latent/mask alignment. */
function resolveAndPatchPlayerMegapixels(workflow: ApiWorkflow): number {
  const playerScaleId =
    String(process.env.COMFYUI_PLAYER_SCALE_NODE_ID ?? "90").trim() || "90";
  const fromWorkflow = readWorkflowMegapixels(workflow, playerScaleId, 1);
  const fromEnv = parseEnvFloat("COMFYUI_PLAYER_MEGAPIXELS", 0);
  const megapixels = fromEnv > 0 ? fromEnv : fromWorkflow;

  patchNodeMegapixels(workflow, playerScaleId, megapixels);

  const maskScaleId = String(process.env.COMFYUI_MASK_SCALE_NODE_ID ?? "98").trim() || "98";
  if (workflow[maskScaleId]?.inputs) {
    patchNodeMegapixels(workflow, maskScaleId, megapixels);
  }

  return megapixels;
}

/** `COMFYUI_PROMPT_FORMAT=sdxl|qwen`, else infer from workflow filename. */
export function resolveComfyPromptFormat(workflowPath: string): "sdxl" | "qwen" {
  const env = String(process.env.COMFYUI_PROMPT_FORMAT ?? "").trim().toLowerCase();
  if (env === "sdxl" || env === "qwen") return env;
  return workflowPath.toLowerCase().includes("sdxl") ? "sdxl" : "qwen";
}

/**
 * Runs a ComfyUI API-format workflow with dynamic image + prompt on configured node IDs.
 */
export async function generateCorrectedImageComfy(
  originalImageBase64: string,
  mimeType: string,
  frameNumber: number,
  landmarks: FrameLandmarks,
  deltas: LandmarkDelta[],
  diagnosis: string,
  recommendations: string[],
  shotAndHandedness?: ShotAndHandedness | null,
  proReferenceText?: string | null,
  referenceImageBase64?: string | null,
  referenceMimeType?: string | null,
  proLandmarks?: FrameLandmarks | null
): Promise<string | null> {
  if (!isComfyCorrectionConfigured()) {
    console.error("[comfyCorrection] COMFYUI_BASE_URL and COMFYUI_WORKFLOW_PATH are required");
    return null;
  }

  const profile = resolveCorrectionIntensity();
  const baseUrl = String(process.env.COMFYUI_BASE_URL).trim();
  const workflowPath = resolveWorkflowPath(String(process.env.COMFYUI_WORKFLOW_PATH));
  const loadNodeIdsRaw = String(process.env.COMFYUI_LOAD_IMAGE_NODE_ID ?? "").trim();
  const loadNodeIds = loadNodeIdsRaw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const promptNodeId = String(process.env.COMFYUI_PROMPT_NODE_ID ?? "").trim();
  const maskNodeId = String(process.env.COMFYUI_MASK_NODE_ID ?? "").trim();
  const imageInputKey = String(process.env.COMFYUI_IMAGE_INPUT_KEY ?? "image").trim() || "image";
  const promptInputKey = String(process.env.COMFYUI_PROMPT_INPUT_KEY ?? "text").trim() || "text";

  if (loadNodeIds.length === 0 || !promptNodeId) {
    console.error(
      "[comfyCorrection] Set COMFYUI_LOAD_IMAGE_NODE_ID (one id or comma-separated) and COMFYUI_PROMPT_NODE_ID (string node ids from API JSON)"
    );
    return null;
  }

  const promptFormat = resolveComfyPromptFormat(workflowPath);
  const promptText =
    promptFormat === "sdxl"
      ? buildSdxlCorrectionPrompt(
          frameNumber,
          deltas,
          diagnosis,
          recommendations,
          shotAndHandedness ?? null,
          proReferenceText ?? null
        )
      : buildQwenCorrectionPrompt(
          frameNumber,
          landmarks,
          deltas,
          diagnosis,
          recommendations,
          shotAndHandedness ?? null,
          proReferenceText ?? null,
          profile.intensity,
          proLandmarks ?? null
        );

  let fileJson: string;
  try {
    fileJson = await fs.readFile(workflowPath, "utf8");
  } catch (e) {
    console.error("[comfyCorrection] Failed to read workflow file", workflowPath, e);
    return null;
  }

  let template: ApiWorkflow;
  try {
    template = unwrapWorkflow(JSON.parse(fileJson));
  } catch (e) {
    console.error("[comfyCorrection] Invalid workflow JSON", e);
    return null;
  }

  const workflow = deepClone(template);
  for (const id of loadNodeIds) {
    const n = workflow[id];
    if (!n?.inputs) {
      console.error(`[comfyCorrection] Load image node ${id} missing inputs`);
      return null;
    }
  }
  const promptNode = workflow[promptNodeId];
  if (!promptNode?.inputs) {
    console.error(`[comfyCorrection] Node ${promptNodeId} missing inputs`);
    return null;
  }

  let maskNode: { class_type?: string; inputs?: Record<string, unknown> } | null = null;
  if (maskNodeId) {
    maskNode = workflow[maskNodeId] ?? null;
    if (!maskNode?.inputs) {
      console.warn(
        `[comfyCorrection] COMFYUI_MASK_NODE_ID=${maskNodeId} but workflow has no such node — running without mask`
      );
      maskNode = null;
    }
  }

  const buf = Buffer.from(originalImageBase64, "base64");
  const safeMime = mimeType?.startsWith("image/") ? mimeType : "image/png";
  const ext = safeMime.includes("jpeg") || safeMime.includes("jpg") ? "jpg" : "png";
  const uploadName = `xevo_f${frameNumber}_${Date.now().toString(36)}.${ext}`;

  try {
    const mainNodeId = loadNodeIds[0]!;
    const uploadedMain = await comfyUploadImage(baseUrl, buf, uploadName);
    (workflow[mainNodeId].inputs as Record<string, unknown>)[imageInputKey] =
      uploadedMain.name;

    const hasProRef = Boolean(referenceImageBase64?.trim());
    const hasProRefText = Boolean(proReferenceText?.trim());
    const proRefImageMissing = hasProRefText && !hasProRef;
    if (proRefImageMissing) {
      console.warn(
        "[comfyCorrection] proRefImageMissing — pro prompt/deltas present but pro still failed to extract; image2 and OpenPose use player frame only (limb movement will be weak)",
        { frame: frameNumber }
      );
    }
    if (loadNodeIds.length > 1) {
      const refNodeId = loadNodeIds[1]!;
      const refB64 = referenceImageBase64?.trim();
      const refBuf = refB64 ? Buffer.from(refB64, "base64") : buf;
      const refMime =
        refB64 && referenceMimeType?.startsWith("image/")
          ? referenceMimeType
          : safeMime;
      const refExt =
        refMime.includes("jpeg") || refMime.includes("jpg") ? "jpg" : "png";
      const refUploadName = `xevo_f${frameNumber}_ref_${Date.now().toString(36)}.${refExt}`;
      const uploadedRef = await comfyUploadImage(baseUrl, refBuf, refUploadName);
      (workflow[refNodeId].inputs as Record<string, unknown>)[imageInputKey] =
        uploadedRef.name;
      if (hasProRef) {
        patchRefMegapixels(workflow, profile.refMegapixels);
      }
    }

    promptNode.inputs[promptInputKey] = promptText;

    patchKsamplerDenoise(workflow, profile.denoise);
    const playerMegapixels = resolveAndPatchPlayerMegapixels(workflow);
    const { poseSourceNode, controlnetStrength } = patchOpenPoseControlNetForCorrection(
      workflow,
      hasProRef,
      profile
    );

    let maskUnionPro = false;
    let maskW: number | null = null;
    let maskH: number | null = null;
    let originalW: number | null = null;
    let originalH: number | null = null;
    if (maskNode) {
      try {
        const { width, height } = await readImageDimensions(buf);
        originalW = width;
        originalH = height;
        const scaled = dimensionsForMegapixels(width, height, playerMegapixels);
        maskW = scaled.width;
        maskH = scaled.height;
        maskUnionPro = Boolean(proLandmarks && Object.keys(proLandmarks).length > 0);
        const maskPng = await buildCoachingInpaintMaskPng(landmarks, proLandmarks, {
          width: maskW,
          height: maskH,
          dilatePct: profile.maskDilatePct,
        });

        if (String(process.env.COMFYUI_DEBUG_MASK ?? "").trim().toLowerCase() === "true") {
          const debugDir = path.join(process.cwd(), "tmp");
          await fs.mkdir(debugDir, { recursive: true });
          const debugPath = path.join(debugDir, `xevo_mask_f${frameNumber}.png`);
          await fs.writeFile(debugPath, maskPng);
          console.log("[comfyCorrection] debug mask saved", {
            frame: frameNumber,
            debugPath,
            maskW,
            maskH,
            playerMegapixels,
          });
        }

        const maskName = `xevo_f${frameNumber}_${Date.now().toString(36)}_mask.png`;
        const uploadedMask = await comfyUploadImage(baseUrl, maskPng, maskName);
        (maskNode.inputs as Record<string, unknown>)[imageInputKey] = uploadedMask.name;
      } catch (maskErr) {
        console.warn("[comfyCorrection] mask build/upload failed — running without mask", maskErr);
      }
    }

    const proDeltaCount = proLandmarks
      ? deltas.filter((d) => d.reason.startsWith("pro library:")).length
      : 0;

    if (deltas.length === 0) {
      console.warn(
        "[comfyCorrection] No landmark deltas for frame — Comfy will rely on diagnosis text only; limb movement will be weak",
        { frame: frameNumber }
      );
    }
    if (hasProRef && !proLandmarks) {
      console.warn(
        "[comfyCorrection] Pro ref image uploaded but pro landmarks missing — numeric joint targets unavailable",
        { frame: frameNumber }
      );
    }

    console.log("[comfyCorrection] coaching profile", {
      frame: frameNumber,
      intensity: profile.intensity,
      refIsProFrame: hasProRef,
      proRefImageMissing,
      poseSourceNode,
      denoise: profile.denoise,
      controlnetStrength,
      maskDilatePct: profile.maskDilatePct,
      maskUnionPro,
      maskEnabled: Boolean(maskNode),
      originalWxH: originalW && originalH ? `${originalW}x${originalH}` : null,
      maskWxH: maskW && maskH ? `${maskW}x${maskH}` : null,
      playerMegapixels,
      refMegapixels: hasProRef ? profile.refMegapixels : null,
      deltaCount: deltas.length,
      proDeltaCount,
      topJoints: deltas.slice(0, 5).map((d) => d.landmark),
    });

    const { prompt_id } = await comfyQueuePrompt(baseUrl, workflow as Record<string, unknown>);
    const out = await comfyWaitForOutputImage(baseUrl, prompt_id, {
      timeoutMs: Number(process.env.COMFYUI_TIMEOUT_MS ?? 420000) || 420000,
    });
    return await comfyImageToDataUri(baseUrl, out.filename, out.subfolder, out.type);
  } catch (e) {
    console.error("[comfyCorrection] ComfyUI run failed", e);
    return null;
  }
}
