import fs from "fs/promises";
import path from "path";
import {
  buildQwenCorrectionPrompt,
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
import { buildPoseMaskPng, readImageDimensions } from "./poseMask";

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

/**
 * Runs a ComfyUI API-format workflow with dynamic image + prompt on configured node IDs.
 *
 * Env:
 * - COMFYUI_BASE_URL (e.g. http://127.0.0.1:8188)
 * - COMFYUI_WORKFLOW_PATH — path to JSON from Comfy "Save (API Format)"
 * - COMFYUI_LOAD_IMAGE_NODE_ID — one id or comma-separated ids (e.g. `41,83` for Qwen Image Edit Plus: same upload is written to every listed node)
 * - COMFYUI_PROMPT_NODE_ID — node whose prompt field receives the coaching prompt (`text` for CLIPTextEncode, `prompt` for Qwen image encode nodes — set COMFYUI_PROMPT_INPUT_KEY)
 * - COMFYUI_MASK_NODE_ID — (optional) LoadImage node id whose `image` slot receives a server-built pose mask PNG so SetLatentNoiseMask can preserve the court/net/walls. Leave unset to disable masked inpaint and run full-frame regeneration as before.
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
  proReferenceText?: string | null
): Promise<string | null> {
  if (!isComfyCorrectionConfigured()) {
    console.error("[comfyCorrection] COMFYUI_BASE_URL and COMFYUI_WORKFLOW_PATH are required");
    return null;
  }

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

  const promptText = buildQwenCorrectionPrompt(
    frameNumber,
    landmarks,
    deltas,
    diagnosis,
    recommendations,
    shotAndHandedness ?? null,
    proReferenceText ?? null
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

  // Optional mask LoadImage node — Phase 6c masked-inpaint path.
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
    const uploaded = await comfyUploadImage(baseUrl, buf, uploadName);
    for (const id of loadNodeIds) {
      (workflow[id].inputs as Record<string, unknown>)[imageInputKey] = uploaded.name;
    }
    promptNode.inputs[promptInputKey] = promptText;

    if (maskNode) {
      try {
        const { width, height } = await readImageDimensions(buf);
        // Mask matches the upscaled latent's aspect (post-ImageScaleToTotalPixels).
        // We just match the original frame aspect at a reasonable resolution;
        // SetLatentNoiseMask will resample to latent dims automatically.
        const maxDim = 1024;
        const scale = Math.min(1, maxDim / Math.max(width, height));
        const maskW = Math.max(64, Math.round(width * scale));
        const maskH = Math.max(64, Math.round(height * scale));
        const maskPng = await buildPoseMaskPng(landmarks, {
          width: maskW,
          height: maskH,
        });
        const maskName = `xevo_f${frameNumber}_${Date.now().toString(36)}_mask.png`;
        const uploadedMask = await comfyUploadImage(baseUrl, maskPng, maskName);
        (maskNode.inputs as Record<string, unknown>)[imageInputKey] = uploadedMask.name;
        console.log("[comfyCorrection] mask uploaded", {
          frame: frameNumber,
          maskW,
          maskH,
          name: uploadedMask.name,
        });
      } catch (maskErr) {
        // Mask is a best-effort improvement; never block the correction over it.
        console.warn("[comfyCorrection] mask build/upload failed — running without mask", maskErr);
      }
    }

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
