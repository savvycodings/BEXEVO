import fs from "fs";
import path from "path";

export type CorrectionVideoResult = {
  frame: number;
  startImage: string;
  video: string;
  poseVideo?: string;
  /**
   * Span of the source clip the generated video covers. The clip is a window centred on
   * contact, not the whole upload, so the before/after compare needs these to play the same
   * moments on both sides.
   */
  windowStartMs?: number;
  windowEndMs?: number;
};

const VIDEO_UPLOAD_ROOT = path.join(process.cwd(), "uploads", "technique-correction-videos");

function videoDir(analysisId: string): string {
  return path.join(VIDEO_UPLOAD_ROOT, analysisId);
}

export function persistCorrectionVideo(opts: {
  analysisId: string;
  frame: number;
  videoBuffer: Buffer;
  startImageBuffer: Buffer;
  poseVideoBuffer?: Buffer;
  /** Default corrected.mp4; Veo A/B uses corrected-veo.mp4 so Fun Control output is kept. */
  videoFileName?: string;
  windowStartMs?: number;
  windowEndMs?: number;
}): CorrectionVideoResult {
  const dir = videoDir(opts.analysisId);
  fs.mkdirSync(dir, { recursive: true });
  const startName = `${opts.frame}-start.png`;
  const videoName = opts.videoFileName?.trim() || "corrected.mp4";
  fs.writeFileSync(path.join(dir, startName), opts.startImageBuffer);
  fs.writeFileSync(path.join(dir, videoName), opts.videoBuffer);
  const result: CorrectionVideoResult = {
    frame: opts.frame,
    startImage: `/uploads/technique-correction-videos/${opts.analysisId}/${startName}`,
    video: `/uploads/technique-correction-videos/${opts.analysisId}/${videoName}`,
    ...(Number.isFinite(opts.windowStartMs) && Number.isFinite(opts.windowEndMs)
      ? {
          windowStartMs: Math.max(0, Math.round(opts.windowStartMs as number)),
          windowEndMs: Math.max(0, Math.round(opts.windowEndMs as number)),
        }
      : {}),
  };
  if (opts.poseVideoBuffer?.length) {
    const poseName = "openpose-control.mp4";
    fs.writeFileSync(path.join(dir, poseName), opts.poseVideoBuffer);
    result.poseVideo = `/uploads/technique-correction-videos/${opts.analysisId}/${poseName}`;
  }
  return result;
}

export function parseCachedCorrectionVideo(raw: unknown): CorrectionVideoResult | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const frame = typeof o.frame === "number" && Number.isFinite(o.frame) ? o.frame : null;
  const startImage = typeof o.startImage === "string" ? o.startImage.trim() : "";
  const video = typeof o.video === "string" ? o.video.trim() : "";
  if (frame == null || !startImage || !video) return null;
  const poseRaw = typeof o.poseVideo === "string" ? o.poseVideo.trim() : "";
  const num = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
  const startMs = num(o.windowStartMs);
  const endMs = num(o.windowEndMs);
  return {
    frame,
    startImage,
    video,
    ...(poseRaw ? { poseVideo: poseRaw } : {}),
    ...(startMs != null && endMs != null && endMs > startMs
      ? { windowStartMs: startMs, windowEndMs: endMs }
      : {}),
  };
}
