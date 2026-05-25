import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import ffmpegStatic from "ffmpeg-static";

function resolveFfmpegBinary(): string {
  const fromEnv = process.env.FFMPEG_PATH?.trim();
  if (fromEnv) return fromEnv;
  if (ffmpegStatic) return ffmpegStatic;
  return "ffmpeg";
}

function resolveFfprobeBinary(): string {
  return process.env.FFPROBE_PATH?.trim() || "ffprobe";
}

function parseFpsRate(raw: string): number | null {
  const s = String(raw).trim();
  if (!s) return null;
  if (s.includes("/")) {
    const [num, den] = s.split("/").map((x) => parseFloat(x));
    if (Number.isFinite(num) && Number.isFinite(den) && den > 0) {
      return num / den;
    }
    return null;
  }
  const n = parseFloat(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export type VideoStreamMeta = {
  fps: number;
  durationSec: number | null;
  nbFrames: number | null;
};

const DEFAULT_FPS = 30;

/** fps, duration, and frame count for pro-library timestamp / ratio extraction. */
export async function probeVideoStreamMeta(
  videoPath: string
): Promise<VideoStreamMeta | null> {
  return new Promise((resolve) => {
    execFile(
      resolveFfprobeBinary(),
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=r_frame_rate,duration,nb_frames",
        "-of",
        "json",
        videoPath,
      ],
      { maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        try {
          const parsed = JSON.parse(String(stdout)) as {
            streams?: Array<{
              r_frame_rate?: string;
              duration?: string;
              nb_frames?: string;
            }>;
          };
          const stream = parsed.streams?.[0];
          if (!stream) {
            resolve(null);
            return;
          }
          const fps = parseFpsRate(stream.r_frame_rate ?? "") ?? DEFAULT_FPS;
          const durationRaw = parseFloat(String(stream.duration ?? ""));
          const durationSec =
            Number.isFinite(durationRaw) && durationRaw > 0 ? durationRaw : null;
          const nbRaw = parseInt(String(stream.nb_frames ?? ""), 10);
          const nbFrames =
            Number.isFinite(nbRaw) && nbRaw > 0 ? nbRaw : null;
          resolve({ fps, durationSec, nbFrames });
        } catch {
          resolve(null);
        }
      }
    );
  });
}

/** Best-effort frame count for clamping pro-library extractions. */
export async function probeVideoFrameCount(
  videoPath: string
): Promise<number | null> {
  const meta = await probeVideoStreamMeta(videoPath);
  if (meta?.nbFrames) return meta.nbFrames;
  if (meta?.durationSec && meta.fps > 0) {
    return Math.max(1, Math.round(meta.durationSec * meta.fps));
  }
  return null;
}

export type ProFrameExtractMethod = "index" | "timestamp" | "ratio";

export type ProFrameExtractResult = {
  buffer: Buffer;
  method: ProFrameExtractMethod;
  detail: string;
};

export type ExtractProReferenceFrameOptions = {
  frameCandidates: number[];
  maxFrame?: number | null;
  /** 0–1 position in pro clip (aligned to user frame); used when index/timestamp attempts fail. */
  timelineRatio?: number;
};

/**
 * Extract a still from a pro train video: index select, then timestamp seek, then timeline ratio.
 */
export async function extractProReferenceFrame(
  videoPath: string,
  options: ExtractProReferenceFrameOptions
): Promise<ProFrameExtractResult> {
  if (!fs.existsSync(videoPath)) {
    throw new Error(
      `pro train video not found on disk: ${videoPath} (re-upload train clip or fix cloudinaryPublicId)`
    );
  }

  const meta = await probeVideoStreamMeta(videoPath);
  const fps = meta?.fps ?? DEFAULT_FPS;
  const durationSec = meta?.durationSec ?? null;
  const probedFrames = meta?.nbFrames ?? null;
  const maxFrame =
    typeof options.maxFrame === "number" && options.maxFrame > 0
      ? options.maxFrame
      : probedFrames;

  const seen = new Set<number>();
  const candidates: number[] = [];
  for (const n of options.frameCandidates) {
    if (!Number.isFinite(n) || n < 0) continue;
    const clamped =
      typeof maxFrame === "number" && maxFrame > 0
        ? Math.min(Math.floor(n), maxFrame - 1)
        : Math.floor(n);
    if (!seen.has(clamped)) {
      seen.add(clamped);
      candidates.push(clamped);
    }
  }

  let lastErr: unknown;

  for (const idx of candidates) {
    try {
      const buf = await extractFrame(videoPath, idx);
      if (buf.length > 0) {
        return { buffer: buf, method: "index", detail: `frame_index=${idx}` };
      }
    } catch (e) {
      lastErr = e;
    }

    const timeSec = idx / fps;
    try {
      const buf = await extractFrameByTimestamp(videoPath, timeSec);
      if (buf.length > 0) {
        return {
          buffer: buf,
          method: "timestamp",
          detail: `frame_index=${idx} time_sec=${timeSec.toFixed(3)} fps=${fps}`,
        };
      }
    } catch (e) {
      lastErr = e;
    }
  }

  const ratio = options.timelineRatio;
  if (typeof ratio === "number" && Number.isFinite(ratio)) {
    const t = Math.max(0, Math.min(1, ratio));

    if (durationSec && durationSec > 0) {
      const timeSec = t * Math.max(0, durationSec - 0.05);
      try {
        const buf = await extractFrameByTimestamp(videoPath, timeSec);
        if (buf.length > 0) {
          return {
            buffer: buf,
            method: "ratio",
            detail: `timeline_ratio=${t.toFixed(4)} time_sec=${timeSec.toFixed(3)}`,
          };
        }
      } catch (e) {
        lastErr = e;
      }
    }

    if (typeof maxFrame === "number" && maxFrame > 0) {
      const idx = Math.min(maxFrame - 1, Math.max(0, Math.floor(t * (maxFrame - 1))));
      try {
        const buf = await extractFrame(videoPath, idx);
        if (buf.length > 0) {
          return {
            buffer: buf,
            method: "ratio",
            detail: `timeline_ratio=${t.toFixed(4)} frame_index=${idx} max_frame=${maxFrame}`,
          };
        }
      } catch (e) {
        lastErr = e;
      }
      try {
        const timeSec = idx / fps;
        const buf = await extractFrameByTimestamp(videoPath, timeSec);
        if (buf.length > 0) {
          return {
            buffer: buf,
            method: "ratio",
            detail: `timeline_ratio=${t.toFixed(4)} time_sec=${timeSec.toFixed(3)}`,
          };
        }
      } catch (e) {
        lastErr = e;
      }
    }
  }

  const errMsg =
    lastErr instanceof Error
      ? lastErr.message
      : `ffmpeg extraction failed for frames [${candidates.join(", ")}] on ${videoPath}`;
  throw new Error(errMsg);
}

/** Try several frame indices; optional clamp to decoded frame count. */
export async function extractFrameFirstAvailable(
  videoPath: string,
  frameNumbers: number[],
  maxFrame?: number | null
): Promise<Buffer> {
  const result = await extractProReferenceFrame(videoPath, {
    frameCandidates: frameNumbers,
    maxFrame,
  });
  return result.buffer;
}

export function extractFrame(
  videoPath: string,
  frameNumber: number
): Promise<Buffer> {
  const filters = [
    `select=eq(n\\,${frameNumber})`,
    `select=gte(n\\,${frameNumber})`,
  ];

  return new Promise(async (resolve, reject) => {
    for (const vf of filters) {
      try {
        const frame = await runFfmpegExtract(videoPath, vf);
        if (frame.length > 0) {
          return resolve(frame);
        }
      } catch {
        // try next filter
      }
    }
    reject(
      new Error(
        `ffmpeg extraction failed for frame ${frameNumber} with all filter strategies`
      )
    );
  });
}

/** Seek by time (seconds); more reliable than select=n on some train codecs. */
export function extractFrameByTimestamp(
  videoPath: string,
  timeSec: number
): Promise<Buffer> {
  const t = Math.max(0, timeSec);
  return runFfmpegRawArgs([
    "-ss",
    String(t),
    "-i",
    videoPath,
    "-frames:v",
    "1",
    "-f",
    "image2pipe",
    "-vcodec",
    "png",
    "-y",
    "pipe:1",
  ]);
}

function runFfmpegExtract(videoPath: string, vf: string): Promise<Buffer> {
  return runFfmpegRawArgs([
    "-i",
    videoPath,
    "-vf",
    vf,
    "-vsync",
    "vfr",
    "-frames:v",
    "1",
    "-f",
    "image2pipe",
    "-vcodec",
    "png",
    "-y",
    "pipe:1",
  ]);
}

function runFfmpegRawArgs(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const outBuffers: Buffer[] = [];
    const errBuffers: Buffer[] = [];
    const ffmpegBin = resolveFfmpegBinary();
    const proc = execFile(ffmpegBin, args, {
      maxBuffer: 20 * 1024 * 1024,
      encoding: "buffer" as any,
    });

    proc.stdout?.on("data", (chunk: Buffer) => outBuffers.push(chunk));
    proc.stderr?.on("data", (chunk: Buffer) => errBuffers.push(chunk));

    proc.on("close", (code) => {
      const stderr = Buffer.concat(errBuffers).toString("utf8");
      const hasFilterError =
        /error|invalid|failed/i.test(stderr) &&
        /select|filter|vf|expression/i.test(stderr);
      if (code === 0 && outBuffers.length > 0 && !hasFilterError) {
        resolve(Buffer.concat(outBuffers));
      } else {
        reject(
          new Error(
            `ffmpeg exited with code ${code}; args=${args.slice(0, 6).join(" ")}…; stderr=${stderr
              .slice(0, 400)
              .replace(/\s+/g, " ")}`
          )
        );
      }
    });

    proc.on("error", (err) => {
      reject(
        new Error(
          `ffmpeg not found or failed to start (binary: ${resolveFfmpegBinary()}): ${err.message}`
        )
      );
    });
  });
}

export function resolveVideoPath(cloudinaryPublicId: string): string {
  if (path.isAbsolute(cloudinaryPublicId)) return cloudinaryPublicId;
  return path.join(process.cwd(), cloudinaryPublicId);
}
