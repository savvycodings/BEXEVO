import sharp from "sharp";
import {
  buildWanFunControlNegativePrompt,
  buildWanFunControlPrompt,
} from "./comfyVideo";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_VEO_MODEL = "veo-3.1-fast-generate-preview";
const POLL_MS = 10_000;

export type VideoProvider = "comfy" | "gemini";

export function resolveVideoProvider(): VideoProvider {
  const raw = String(process.env.XEVO_VIDEO_PROVIDER ?? "")
    .trim()
    .toLowerCase();
  if (raw === "gemini" || raw === "veo") return "gemini";
  return "comfy";
}

export function isGeminiVideoConfigured(): boolean {
  return Boolean(String(process.env.GEMINI_API_KEY ?? "").trim());
}

function veoModel(): string {
  return String(process.env.XEVO_VEO_MODEL ?? DEFAULT_VEO_MODEL).trim() || DEFAULT_VEO_MODEL;
}

function veoTimeoutMs(): number {
  const fromVeo = Number(process.env.XEVO_VEO_TIMEOUT_MS);
  if (Number.isFinite(fromVeo) && fromVeo > 0) return fromVeo;
  const fromComfy = Number(process.env.COMFYUI_TIMEOUT_MS);
  if (Number.isFinite(fromComfy) && fromComfy > 0) return fromComfy;
  return 420_000;
}

async function aspectRatioForImage(imageBuffer: Buffer): Promise<"9:16" | "16:9"> {
  try {
    const meta = await sharp(imageBuffer).metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    if (w > 0 && h > 0 && w > h) return "16:9";
  } catch {
    /* default portrait for phone padel clips */
  }
  return "9:16";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type VeoOperation = {
  name?: string;
  done?: boolean;
  error?: { message?: string; code?: number };
  response?: {
    generateVideoResponse?: {
      generatedSamples?: Array<{ video?: { uri?: string; videoBytes?: string } }>;
      raiMediaFilteredCount?: number;
      raiMediaFilteredReasons?: string[];
    };
  };
};

async function geminiFetchJson(
  url: string,
  apiKey: string,
  init?: RequestInit
): Promise<{ status: number; data: VeoOperation & Record<string, unknown> }> {
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  let data: VeoOperation & Record<string, unknown> = {};
  try {
    data = text ? (JSON.parse(text) as VeoOperation & Record<string, unknown>) : {};
  } catch {
    data = { _parseError: true, raw: text.slice(0, 400) } as VeoOperation &
      Record<string, unknown>;
  }
  return { status: res.status, data };
}

/**
 * Gemini Veo image-to-video: start frame + text prompts only (no OpenPose control).
 */
export async function generateCorrectedVideoGemini(opts: {
  analysisId: string;
  frameNumber: number;
  imageBuffer: Buffer;
  shotName: string;
  handedness: string;
}): Promise<Buffer> {
  const apiKey = String(process.env.GEMINI_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is required for XEVO_VIDEO_PROVIDER=gemini");
  }

  const model = veoModel();
  const prompt = buildWanFunControlPrompt(opts.shotName, opts.handedness);
  const negativePrompt = buildWanFunControlNegativePrompt();
  const aspectRatio = await aspectRatioForImage(opts.imageBuffer);
  const mimeType = "image/png";
  const imageB64 = opts.imageBuffer.toString("base64");

  const startUrl = `${GEMINI_API_BASE}/models/${model}:predictLongRunning`;
  const body = {
    instances: [
      {
        prompt,
        image: {
          mimeType,
          bytesBase64Encoded: imageB64,
        },
      },
    ],
    parameters: {
      aspectRatio,
      negativePrompt,
      sampleCount: 1,
      personGeneration: "allow_adult",
      resolution: "720p",
      durationSeconds: 8,
    },
  };

  console.log("[Veo] Starting I2V", {
    analysisId: opts.analysisId,
    frame: opts.frameNumber,
    model,
    aspectRatio,
    promptChars: prompt.length,
  });

  const started = await geminiFetchJson(startUrl, apiKey, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (started.status < 200 || started.status >= 300) {
    throw new Error(
      `Veo predictLongRunning HTTP ${started.status}: ${JSON.stringify(started.data).slice(0, 600)}`
    );
  }
  const operationName = typeof started.data.name === "string" ? started.data.name : "";
  if (!operationName) {
    throw new Error(
      `Veo predictLongRunning: missing operation name: ${JSON.stringify(started.data).slice(0, 400)}`
    );
  }

  const deadline = Date.now() + veoTimeoutMs();
  let operation: VeoOperation = started.data;
  while (!operation.done) {
    if (Date.now() > deadline) {
      throw new Error(`Veo timeout waiting for ${operationName}`);
    }
    await sleep(POLL_MS);
    const polled = await geminiFetchJson(`${GEMINI_API_BASE}/${operationName}`, apiKey, {
      method: "GET",
    });
    if (polled.status < 200 || polled.status >= 300) {
      throw new Error(
        `Veo poll HTTP ${polled.status}: ${JSON.stringify(polled.data).slice(0, 600)}`
      );
    }
    operation = polled.data;
    console.log("[Veo] Poll", {
      operationName,
      done: Boolean(operation.done),
      analysisId: opts.analysisId,
    });
  }

  if (operation.error?.message) {
    throw new Error(`Veo failed: ${operation.error.message}`);
  }

  const sample = operation.response?.generateVideoResponse?.generatedSamples?.[0];
  const filtered = operation.response?.generateVideoResponse?.raiMediaFilteredCount;
  if (filtered && filtered > 0) {
    const reasons =
      operation.response?.generateVideoResponse?.raiMediaFilteredReasons?.join("; ") ??
      "rai filtered";
    throw new Error(`Veo filtered output: ${reasons}`);
  }

  if (sample?.video?.videoBytes) {
    return Buffer.from(sample.video.videoBytes, "base64");
  }

  const uri = sample?.video?.uri;
  if (!uri) {
    throw new Error(
      `Veo done but no video uri/bytes: ${JSON.stringify(operation.response ?? {}).slice(0, 600)}`
    );
  }

  const dl = await fetch(uri, {
    headers: { "x-goog-api-key": apiKey },
    redirect: "follow",
  });
  if (!dl.ok) {
    const errText = await dl.text().catch(() => "");
    throw new Error(`Veo download HTTP ${dl.status}: ${errText.slice(0, 300)}`);
  }
  const ab = await dl.arrayBuffer();
  const buf = Buffer.from(ab);
  if (!buf.length) {
    throw new Error("Veo download returned empty video");
  }
  console.log("[Veo] Downloaded mp4", {
    analysisId: opts.analysisId,
    bytes: buf.length,
  });
  return buf;
}
