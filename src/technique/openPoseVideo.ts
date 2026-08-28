import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import ffmpegStatic from "ffmpeg-static";
import { estimateFps } from "./impactPoseContext";
import { pickAlignedProPoseFrame } from "./trainRetrieval";
import type { TrainPoseFrame } from "../db/schema";

export type NamedLandmark = {
  x: number;
  y: number;
  z?: number;
  visibility?: number;
};

export type NamedLandmarks = Record<string, NamedLandmark | undefined>;

const VISIBILITY_MIN = 0.25;
const DEFAULT_SIZE = 768;
const DEFAULT_FPS = 16;
const DEFAULT_LENGTH = 17;

function resolveFfmpegBinary(): string {
  const fromEnv = process.env.FFMPEG_PATH?.trim();
  if (fromEnv) return fromEnv;
  if (ffmpegStatic) return ffmpegStatic;
  return "ffmpeg";
}

function isVisible(lm: NamedLandmark | undefined): lm is NamedLandmark {
  if (!lm || typeof lm.x !== "number" || typeof lm.y !== "number") return false;
  if (!Number.isFinite(lm.x) || !Number.isFinite(lm.y)) return false;
  if (typeof lm.visibility === "number" && Number.isFinite(lm.visibility)) {
    return lm.visibility >= VISIBILITY_MIN;
  }
  return true;
}

function toPixel(
  lm: NamedLandmark,
  width: number,
  height: number
): { x: number; y: number } {
  const nx = lm.x > 1.5 ? lm.x / width : lm.x;
  const ny = lm.y > 1.5 ? lm.y / height : lm.y;
  return {
    x: Math.round(Math.max(0, Math.min(width - 1, nx * width))),
    y: Math.round(Math.max(0, Math.min(height - 1, ny * height))),
  };
}

/** OpenPose-like limb colors (BGR-ish RGB used by controlnet_aux BODY_25). */
const BONES: Array<[string, string, [number, number, number]]> = [
  ["LEFT_SHOULDER", "RIGHT_SHOULDER", [255, 0, 0]],
  ["LEFT_SHOULDER", "LEFT_HIP", [255, 85, 0]],
  ["RIGHT_SHOULDER", "RIGHT_HIP", [255, 170, 0]],
  ["LEFT_HIP", "RIGHT_HIP", [255, 255, 0]],
  ["LEFT_SHOULDER", "LEFT_ELBOW", [170, 255, 0]],
  ["LEFT_ELBOW", "LEFT_WRIST", [85, 255, 0]],
  ["LEFT_WRIST", "LEFT_INDEX", [0, 255, 0]],
  ["RIGHT_SHOULDER", "RIGHT_ELBOW", [0, 255, 85]],
  ["RIGHT_ELBOW", "RIGHT_WRIST", [0, 255, 170]],
  ["RIGHT_WRIST", "RIGHT_INDEX", [0, 255, 255]],
  ["LEFT_HIP", "LEFT_KNEE", [0, 170, 255]],
  ["LEFT_KNEE", "LEFT_ANKLE", [0, 85, 255]],
  ["LEFT_ANKLE", "LEFT_FOOT_INDEX", [0, 0, 255]],
  ["LEFT_ANKLE", "LEFT_HEEL", [85, 0, 255]],
  ["RIGHT_HIP", "RIGHT_KNEE", [170, 0, 255]],
  ["RIGHT_KNEE", "RIGHT_ANKLE", [255, 0, 255]],
  ["RIGHT_ANKLE", "RIGHT_FOOT_INDEX", [255, 0, 170]],
  ["RIGHT_ANKLE", "RIGHT_HEEL", [255, 0, 85]],
  ["LEFT_SHOULDER", "NOSE", [255, 128, 0]],
  ["RIGHT_SHOULDER", "NOSE", [255, 0, 128]],
];

function setPixel(
  buf: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  rgb: [number, number, number]
): void {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const i = (y * width + x) * 3;
  buf[i] = rgb[0];
  buf[i + 1] = rgb[1];
  buf[i + 2] = rgb[2];
}

function drawDisk(
  buf: Uint8Array,
  width: number,
  height: number,
  cx: number,
  cy: number,
  radius: number,
  rgb: [number, number, number]
): void {
  const r2 = radius * radius;
  for (let y = cy - radius; y <= cy + radius; y++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r2) setPixel(buf, width, height, x, y, rgb);
    }
  }
}

function drawThickLine(
  buf: Uint8Array,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  thickness: number,
  rgb: [number, number, number]
): void {
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let x = x0;
  let y = y0;
  while (true) {
    drawDisk(buf, width, height, x, y, thickness, rgb);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
  }
}

export type NormBox = [number, number, number, number];

export type PoseYoloRow = {
  frame: number;
  racket_bbox?: NormBox | null;
  ball_bbox?: NormBox | null;
};

export type ControlOverlay = {
  racket?: { cx: number; cy: number; w: number; h: number };
  ball?: { cx: number; cy: number; r: number };
};

const RACKET_RGB: [number, number, number] = [255, 0, 180];
const BALL_RGB: [number, number, number] = [255, 220, 0];

function fillRect(
  buf: Uint8Array,
  width: number,
  height: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  rgb: [number, number, number]
): void {
  const xa = Math.max(0, Math.min(width - 1, Math.round(Math.min(x1, x2))));
  const xb = Math.max(0, Math.min(width - 1, Math.round(Math.max(x1, x2))));
  const ya = Math.max(0, Math.min(height - 1, Math.round(Math.min(y1, y2))));
  const yb = Math.max(0, Math.min(height - 1, Math.round(Math.max(y1, y2))));
  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++) setPixel(buf, width, height, x, y, rgb);
  }
}

function boxSize(box: NormBox): { w: number; h: number } {
  return {
    w: Math.max(0, box[2] - box[0]),
    h: Math.max(0, box[3] - box[1]),
  };
}

function median(nums: number[]): number | null {
  const xs = nums.filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid]! : (xs[mid - 1]! + xs[mid]!) / 2;
}

function nearestYoloRow(rows: PoseYoloRow[], frame: number): PoseYoloRow | null {
  if (!rows.length) return null;
  let best = rows[0]!;
  let bestD = Math.abs(best.frame - frame);
  for (const row of rows) {
    const d = Math.abs(row.frame - frame);
    if (d < bestD) {
      best = row;
      bestD = d;
    }
  }
  return best;
}

function racketWristName(handedness: string): "LEFT_WRIST" | "RIGHT_WRIST" {
  return handedness.toLowerCase().includes("left") ? "LEFT_WRIST" : "RIGHT_WRIST";
}

function racketElbowName(handedness: string): "LEFT_ELBOW" | "RIGHT_ELBOW" {
  return racketWristName(handedness) === "LEFT_WRIST" ? "LEFT_ELBOW" : "RIGHT_ELBOW";
}

/** Median YOLO racket size in the window; ball boxes per sampled frame with lerp. */
export function controlOverlaysForWindow(opts: {
  userFrameIndices: number[];
  poseRows: PoseYoloRow[];
  proLandmarks: NamedLandmarks[];
  handedness: string;
  width?: number;
  height?: number;
}): ControlOverlay[] {
  const width = opts.width ?? DEFAULT_SIZE;
  const height = opts.height ?? DEFAULT_SIZE;
  const racketWs = opts.poseRows
    .map((r) => (r.racket_bbox ? boxSize(r.racket_bbox).w : 0))
    .filter((n) => n > 0.01);
  const racketHs = opts.poseRows
    .map((r) => (r.racket_bbox ? boxSize(r.racket_bbox).h : 0))
    .filter((n) => n > 0.01);
  const rw = median(racketWs);
  const rh = median(racketHs);
  const wristKey = racketWristName(opts.handedness);
  const elbowKey = racketElbowName(opts.handedness);

  const knownBalls: Array<{ i: number; box: NormBox }> = [];
  opts.userFrameIndices.forEach((frame, i) => {
    const row = nearestYoloRow(opts.poseRows, frame);
    if (row?.ball_bbox && boxSize(row.ball_bbox).w > 0.005) {
      knownBalls.push({ i, box: row.ball_bbox });
    }
  });

  const lerpBox = (i: number): NormBox | null => {
    if (!knownBalls.length) return null;
    const exact = knownBalls.find((b) => b.i === i);
    if (exact) return exact.box;
    let prev = knownBalls[0]!;
    let next = knownBalls[knownBalls.length - 1]!;
    for (const b of knownBalls) {
      if (b.i <= i) prev = b;
      if (b.i >= i) {
        next = b;
        break;
      }
    }
    if (prev.i === next.i) return prev.box;
    const t = (i - prev.i) / Math.max(1, next.i - prev.i);
    return [
      prev.box[0] + (next.box[0] - prev.box[0]) * t,
      prev.box[1] + (next.box[1] - prev.box[1]) * t,
      prev.box[2] + (next.box[2] - prev.box[2]) * t,
      prev.box[3] + (next.box[3] - prev.box[3]) * t,
    ];
  };

  return opts.proLandmarks.map((lm, i) => {
    const overlay: ControlOverlay = {};
    if (rw != null && rh != null) {
      const wrist = lm[wristKey];
      if (isVisible(wrist)) {
        const wp = toPixel(wrist, width, height);
        let cx = wp.x;
        let cy = wp.y;
        const elbow = lm[elbowKey];
        if (isVisible(elbow)) {
          const ep = toPixel(elbow, width, height);
          const dx = wp.x - ep.x;
          const dy = wp.y - ep.y;
          const len = Math.hypot(dx, dy) || 1;
          const ext = 0.35 * rh * height;
          cx = Math.round(wp.x + (dx / len) * ext);
          cy = Math.round(wp.y + (dy / len) * ext);
        }
        overlay.racket = {
          cx,
          cy,
          w: Math.max(8, rw * width),
          h: Math.max(8, rh * height),
        };
      }
    }
    const ball = lerpBox(i);
    if (ball) {
      const bw = boxSize(ball);
      overlay.ball = {
        cx: Math.round(((ball[0] + ball[2]) / 2) * width),
        cy: Math.round(((ball[1] + ball[3]) / 2) * height),
        r: Math.max(3, Math.round((Math.min(bw.w, bw.h) * Math.min(width, height)) / 2)),
      };
    }
    return overlay;
  });
}

export function drawOpenPoseRgb(
  landmarks: NamedLandmarks,
  width = DEFAULT_SIZE,
  height = DEFAULT_SIZE,
  overlay?: ControlOverlay
): Buffer {
  const buf = new Uint8Array(width * height * 3);
  for (const [a, b, color] of BONES) {
    const la = landmarks[a];
    const lb = landmarks[b];
    if (!isVisible(la) || !isVisible(lb)) continue;
    const pa = toPixel(la, width, height);
    const pb = toPixel(lb, width, height);
    drawThickLine(buf, width, height, pa.x, pa.y, pb.x, pb.y, 4, color);
  }
  const joints = new Set<string>();
  for (const [a, b] of BONES) {
    joints.add(a);
    joints.add(b);
  }
  for (const name of joints) {
    const lm = landmarks[name];
    if (!isVisible(lm)) continue;
    const p = toPixel(lm, width, height);
    drawDisk(buf, width, height, p.x, p.y, 6, [255, 255, 255]);
  }
  if (overlay?.racket) {
    const { cx, cy, w, h } = overlay.racket;
    fillRect(buf, width, height, cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2, RACKET_RGB);
  }
  if (overlay?.ball) {
    drawDisk(buf, width, height, overlay.ball.cx, overlay.ball.cy, overlay.ball.r, BALL_RGB);
  }
  return Buffer.from(buf);
}

function writePpm(filePath: string, rgb: Buffer, width: number, height: number): void {
  const header = Buffer.from(`P6\n${width} ${height}\n255\n`, "ascii");
  fs.writeFileSync(filePath, Buffer.concat([header, rgb]));
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const bin = resolveFfmpegBinary();
    execFile(bin, args, { maxBuffer: 8 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) {
        reject(
          new Error(
            `ffmpeg failed (${bin}): ${err.message}; stderr=${String(stderr).slice(0, 400)}`
          )
        );
        return;
      }
      resolve();
    });
  });
}

export function sampleImpactWindowFrameIndices(opts: {
  impactFrame: number;
  totalFrames: number;
  videoDurationMs?: number;
  count?: number;
  windowMs?: number;
}): number[] {
  const count = Math.max(1, opts.count ?? DEFAULT_LENGTH);
  const total = Math.max(1, Math.round(opts.totalFrames));
  const impact = Math.max(0, Math.min(total - 1, Math.round(opts.impactFrame)));
  const windowMs = Number.isFinite(opts.windowMs) && (opts.windowMs ?? 0) > 0
    ? Number(opts.windowMs)
    : Number(process.env.CORRECTION_IMPACT_WINDOW_MS) || 1000;
  const durationMs =
    typeof opts.videoDurationMs === "number" && opts.videoDurationMs > 0
      ? opts.videoDurationMs
      : null;
  const fps = durationMs != null ? estimateFps(total, durationMs) : 30;
  const half = Math.max(1, Math.round((fps * (windowMs / 1000)) / 2));
  const start = Math.max(0, impact - half);
  const end = Math.min(total - 1, impact + half);
  if (count === 1) return [impact];
  const span = Math.max(0, end - start);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    out.push(Math.round(start + (i / (count - 1)) * span));
  }
  return out;
}

export function alignedProLandmarksForUserFrames(
  userFrameIndices: number[],
  videoTotalFrames: number,
  proSeq: TrainPoseFrame[]
): NamedLandmarks[] {
  const frames: NamedLandmarks[] = [];
  let last: NamedLandmarks | null = null;
  for (const idx of userFrameIndices) {
    const pro = pickAlignedProPoseFrame(idx, videoTotalFrames, proSeq);
    const lm: NamedLandmarks | null =
      pro?.landmarks && typeof pro.landmarks === "object"
        ? (pro.landmarks as NamedLandmarks)
        : last;
    if (lm) {
      frames.push(lm);
      last = lm;
    }
  }
  return frames;
}

export async function renderOpenPoseMp4(opts: {
  landmarkFrames: NamedLandmarks[];
  overlays?: ControlOverlay[];
  width?: number;
  height?: number;
  fps?: number;
}): Promise<Buffer> {
  if (!opts.landmarkFrames.length) {
    throw new Error("OpenPose render: no landmark frames");
  }
  const width = opts.width ?? DEFAULT_SIZE;
  const height = opts.height ?? DEFAULT_SIZE;
  const fps = opts.fps ?? DEFAULT_FPS;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "xevo-openpose-"));
  try {
    opts.landmarkFrames.forEach((lm, i) => {
      const rgb = drawOpenPoseRgb(lm, width, height, opts.overlays?.[i]);
      const name = `frame_${String(i).padStart(4, "0")}.ppm`;
      writePpm(path.join(tmp, name), rgb, width, height);
    });
    const outPath = path.join(tmp, "openpose.mp4");
    await runFfmpeg([
      "-y",
      "-framerate",
      String(fps),
      "-i",
      path.join(tmp, "frame_%04d.ppm"),
      "-pix_fmt",
      "yuv420p",
      "-c:v",
      "libx264",
      "-movflags",
      "+faststart",
      outPath,
    ]);
    const buf = fs.readFileSync(outPath);
    if (!buf.length) throw new Error("OpenPose render: empty mp4");
    return buf;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export function correctionImpactWindowMs(): number {
  const n = Number(process.env.CORRECTION_IMPACT_WINDOW_MS);
  if (Number.isFinite(n) && n >= 200) return Math.min(Math.floor(n), 4000);
  return 1000;
}

export { DEFAULT_LENGTH as FUN_CONTROL_LENGTH, DEFAULT_SIZE as FUN_CONTROL_SIZE };
