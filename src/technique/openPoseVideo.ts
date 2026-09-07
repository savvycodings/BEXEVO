import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import ffmpegStatic from "ffmpeg-static";
import { estimateFps } from "./impactPoseContext";
import {
  pickAlignedProPoseFrame,
  pickImpactAlignedProPoseFrame,
} from "./proTimeAlign";
import type { TrainPoseFrame } from "../db/schema";

export type NamedLandmark = {
  x: number;
  y: number;
  z?: number;
  visibility?: number;
};

export type NamedLandmarks = Record<string, NamedLandmark | undefined>;

const VISIBILITY_MIN = 0.25;
/**
 * Minimum relative wrist-reach gap to call a swing side. Below this the arms are effectively
 * level, and mirroring on a coin flip is worse than not mirroring at all.
 */
const SWING_SIDE_MIN_MARGIN = 0.04;
/** Longest side of the control clip and the Fun Control render. Square unless aspect fitting is on. */
const DEFAULT_SIZE = 768;
const DEFAULT_FPS = 16;
/**
 * Frames handed to Fun Control. Must stay 4n+1 or the latent packing rejects it.
 * 33 frames at 16 fps is ~2s, which matches `correctionVideoWindowMs()` so the compare lines up.
 */
const DEFAULT_LENGTH = 33;

function envInt(name: string, min: number, max: number): number | null {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/** Snap a canvas side to a multiple of 32. WAN accepts multiples of 16 but resolves them poorly. */
function round32(n: number): number {
  return Math.max(256, Math.round(n / 32) * 32);
}

/** Longest side of the generated clip. Raising this is the main quality/VRAM dial. */
export function correctionCanvasSize(): number {
  const n = envInt("CORRECTION_CANVAS_SIZE", 256, 1536);
  if (n == null) return DEFAULT_SIZE;
  return round32(n);
}

/** Frame count for Fun Control, snapped up to the nearest 4n+1 the model accepts. */
export function correctionFunLength(): number {
  const n = envInt("CORRECTION_FUN_LENGTH", 5, 121) ?? DEFAULT_LENGTH;
  return Math.round((n - 1) / 4) * 4 + 1;
}

/** Playback rate of the control clip and the generated clip. */
export function correctionFunFps(): number {
  return envInt("CORRECTION_FUN_FPS", 8, 60) ?? DEFAULT_FPS;
}

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

/**
 * Off by default. A saturated filled rectangle is a very strong control signal, and WAN paints
 * it in literally as a striped slab instead of a paddle. With it gone, the racket has to come
 * from the start frame and the prompt, which is what keeps it looking like the athlete's own.
 */
function drawRacketBox(): boolean {
  return String(process.env.CORRECTION_DRAW_RACKET_BOX ?? "").trim().toLowerCase() === "true";
}

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

/**
 * Median YOLO racket size in the window; ball boxes per sampled frame with lerp.
 * `controlLandmarks` must be the same poses drawn into the control clip (blended, retargeted)
 * so the racket sits on the wrist that is actually rendered.
 */
export function controlOverlaysForWindow(opts: {
  userFrameIndices: number[];
  poseRows: PoseYoloRow[];
  controlLandmarks: NamedLandmarks[];
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

  return opts.controlLandmarks.map((lm, i) => {
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
  if (overlay?.racket && drawRacketBox()) {
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
  const count = Math.max(1, opts.count ?? correctionFunLength());
  const total = Math.max(1, Math.round(opts.totalFrames));
  const impact = Math.max(0, Math.min(total - 1, Math.round(opts.impactFrame)));
  const windowMs = Number.isFinite(opts.windowMs) && (opts.windowMs ?? 0) > 0
    ? Number(opts.windowMs)
    : correctionVideoWindowMs();
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

/**
 * One landmark set per requested frame, gaps filled from the nearest neighbour in time.
 * The returned array must stay index-aligned with `userFrameIndices`, because downstream
 * blending and overlay placement pair the two arrays position by position.
 */
function denseLandmarkFrames(
  picked: Array<TrainPoseFrame | null>
): NamedLandmarks[] {
  const raw: Array<NamedLandmarks | null> = picked.map((pro) => {
    const lm = pro?.landmarks;
    if (!lm || typeof lm !== "object" || !Object.keys(lm).length) return null;
    return lm as NamedLandmarks;
  });
  if (raw.every((lm) => lm === null)) return [];

  const out: NamedLandmarks[] = new Array(raw.length);
  let last: NamedLandmarks | null = null;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i]) last = raw[i]!;
    if (last) out[i] = last;
  }
  // Leading gap: borrow the first frame that did resolve.
  let next: NamedLandmarks | null = null;
  for (let i = raw.length - 1; i >= 0; i--) {
    if (out[i]) next = out[i]!;
    else if (next) out[i] = next;
  }
  return out;
}

export function alignedProLandmarksForUserFrames(
  userFrameIndices: number[],
  videoTotalFrames: number,
  proSeq: TrainPoseFrame[]
): NamedLandmarks[] {
  return denseLandmarkFrames(
    userFrameIndices.map((idx) =>
      pickAlignedProPoseFrame(idx, videoTotalFrames, proSeq)
    )
  );
}

/**
 * Contact-to-contact pro alignment: each user frame maps to the pro frame at the same
 * time offset from impact. Falls back to relative-timeline alignment upstream when the
 * pro clip has no resolved impact frame.
 */
export function alignedProLandmarksByImpact(opts: {
  userFrameIndices: number[];
  userImpactFrame: number;
  userFps: number;
  proSeq: TrainPoseFrame[];
  proImpactFrame: number;
  proFps: number;
}): NamedLandmarks[] {
  return denseLandmarkFrames(
    opts.userFrameIndices.map((idx) =>
      pickImpactAlignedProPoseFrame({
        userVideoFrameIndex: idx,
        userImpactFrame: opts.userImpactFrame,
        userFps: opts.userFps,
        proSeq: opts.proSeq,
        proImpactFrame: opts.proImpactFrame,
        proFps: opts.proFps,
      })
    )
  );
}

/** User landmarks for the sampled window frames, carrying forward the last good row. */
export function userLandmarksForFrames(
  userFrameIndices: number[],
  poseRows: Array<{ frame?: number; landmarks?: unknown }>
): NamedLandmarks[] {
  const rows = poseRows.filter(
    (r) => typeof r.frame === "number" && r.landmarks && typeof r.landmarks === "object"
  ) as Array<{ frame: number; landmarks: NamedLandmarks }>;
  const frames: NamedLandmarks[] = [];
  let last: NamedLandmarks | null = null;
  for (const idx of userFrameIndices) {
    let best: NamedLandmarks | null = null;
    let bestD = Number.POSITIVE_INFINITY;
    for (const row of rows) {
      const d = Math.abs(row.frame - idx);
      if (d < bestD) {
        bestD = d;
        best = row.landmarks;
      }
    }
    const lm: NamedLandmarks | null = best ?? last;
    frames.push(lm ?? {});
    if (lm) last = lm;
  }
  return frames;
}

function midpoint(
  a: NamedLandmark | undefined,
  b: NamedLandmark | undefined
): { x: number; y: number } | null {
  if (isVisible(a) && isVisible(b)) return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  if (isVisible(a)) return { x: a.x, y: a.y };
  if (isVisible(b)) return { x: b.x, y: b.y };
  return null;
}

type BodyFrame = {
  hip: { x: number; y: number };
  torso: number;
};

/** Hip origin + torso length (aspect-corrected) used as the similarity-transform basis. */
function bodyFrameOf(lm: NamedLandmarks, aspect: number): BodyFrame | null {
  const hip = midpoint(lm.LEFT_HIP, lm.RIGHT_HIP);
  const shoulder = midpoint(lm.LEFT_SHOULDER, lm.RIGHT_SHOULDER);
  if (!hip || !shoulder) return null;
  const dx = (shoulder.x - hip.x) * aspect;
  const dy = shoulder.y - hip.y;
  const torso = Math.hypot(dx, dy);
  if (!Number.isFinite(torso) || torso < 1e-4) return null;
  return { hip, torso };
}

/**
 * Put the pro skeleton in the user's camera frame: hip midpoints coincide, pro limb lengths
 * scale to the user's torso, and the pose mirrors when handedness disagrees. Without this the
 * control clip carries the pro's position, body size, and viewpoint.
 */
export function retargetProToUser(
  proLm: NamedLandmarks,
  userLm: NamedLandmarks,
  opts?: { aspect?: number; mirror?: boolean }
): NamedLandmarks {
  const aspect = opts?.aspect && opts.aspect > 0 ? opts.aspect : 1;
  const proFrame = bodyFrameOf(proLm, aspect);
  const userFrame = bodyFrameOf(userLm, aspect);
  if (!proFrame || !userFrame) return proLm;

  const scale = userFrame.torso / proFrame.torso;
  const sx = opts?.mirror ? -scale : scale;
  const out: NamedLandmarks = {};
  for (const [name, lm] of Object.entries(proLm)) {
    if (!lm || typeof lm.x !== "number" || typeof lm.y !== "number") continue;
    out[name] = {
      ...lm,
      x: userFrame.hip.x + (lm.x - proFrame.hip.x) * sx,
      y: userFrame.hip.y + (lm.y - proFrame.hip.y) * scale,
    };
  }
  return out;
}

/**
 * Which landmark arm swings, from wrist reach across the window. Pro clips carry no handedness
 * metadata (only landmarks), so the mirror decision has to come out of the pose itself. Summing
 * reach over the window rather than reading one frame keeps it stable through occlusion.
 *
 * Only ever compare this against another call of the same function. It reports a side in
 * MediaPipe's LEFT_/RIGHT_ naming, which is not reliably the athlete's real-world handedness;
 * what makes the mirror decision sound is that both sequences are measured the same way.
 * Returns null when the two arms are too close to call, so callers can decline to mirror.
 */
export function inferSwingSideFromLandmarks(
  frames: NamedLandmarks[],
  aspect = 1,
  minMargin = SWING_SIDE_MIN_MARGIN
): "LEFT" | "RIGHT" | null {
  let left = 0;
  let right = 0;
  for (const lm of frames) {
    const hip = midpoint(lm.LEFT_HIP, lm.RIGHT_HIP);
    if (!hip) continue;
    const reach = (w: NamedLandmark | undefined): number | null => {
      if (!isVisible(w)) return null;
      return Math.hypot((w.x - hip.x) * aspect, w.y - hip.y);
    };
    const l = reach(lm.LEFT_WRIST);
    const r = reach(lm.RIGHT_WRIST);
    if (l != null) left += l;
    if (r != null) right += r;
  }
  if (left <= 0 && right <= 0) return null;
  const margin = Math.abs(left - right) / Math.max(left, right);
  if (margin < minMargin) return null;
  return right > left ? "RIGHT" : "LEFT";
}

/** Interpolate the user's pose toward the retargeted pro pose (0 = user, 1 = full pro). */
export function blendLandmarks(
  userLm: NamedLandmarks,
  proLm: NamedLandmarks,
  alpha: number
): NamedLandmarks {
  const a = Math.max(0, Math.min(1, alpha));
  const names = new Set([...Object.keys(userLm), ...Object.keys(proLm)]);
  const out: NamedLandmarks = {};
  for (const name of names) {
    const u = userLm[name];
    const p = proLm[name];
    if (isVisible(u) && isVisible(p)) {
      out[name] = {
        x: u.x + (p.x - u.x) * a,
        y: u.y + (p.y - u.y) * a,
        z: typeof p.z === "number" ? p.z : u.z,
        visibility: Math.min(
          typeof u.visibility === "number" ? u.visibility : 1,
          typeof p.visibility === "number" ? p.visibility : 1
        ),
      };
    } else if (isVisible(p)) {
      out[name] = p;
    } else if (isVisible(u)) {
      out[name] = u;
    }
  }
  return out;
}

/**
 * Blend fraction toward the pro pose; 1 reproduces the old full-puppeteering behaviour.
 *
 * 0.4 measured best on a swept clip: it moves joints about 5% of the frame height, which reads
 * as a correction, while frame-to-frame wrist travel stays near the athlete's own motion
 * (peak/mean 3.4 against their natural 2.9). Higher values reimport the pro's sampling jerk
 * faster than they add useful correction: 0.65 buys 47% more movement for a peak/mean of 5.1.
 */
export function correctionPoseBlend(): number {
  const n = Number(process.env.CORRECTION_POSE_BLEND);
  if (Number.isFinite(n) && n >= 0 && n <= 1) return n;
  return 0.4;
}

/**
 * Per-frame control poses: retarget the pro into the user's frame, then blend the user
 * toward it so the clip reads as a correction of this athlete rather than a pose swap.
 */
export function coachedControlLandmarkFrames(opts: {
  userFrames: NamedLandmarks[];
  proFrames: NamedLandmarks[];
  aspect?: number;
  mirror?: boolean;
  blend?: number;
}): NamedLandmarks[] {
  const blend = opts.blend ?? correctionPoseBlend();
  const count = Math.min(opts.userFrames.length, opts.proFrames.length);
  const out: NamedLandmarks[] = [];
  for (let i = 0; i < count; i++) {
    const userLm = opts.userFrames[i] ?? {};
    const proLm = opts.proFrames[i] ?? {};
    if (!Object.keys(userLm).length) {
      out.push(proLm);
      continue;
    }
    const retargeted = retargetProToUser(proLm, userLm, {
      aspect: opts.aspect,
      mirror: opts.mirror,
    });
    out.push(blendLandmarks(userLm, retargeted, blend));
  }
  return smoothLandmarkTrack(out, correctionPoseSmoothing());
}

/**
 * Centred moving average over each joint's track. The window is sampled well below the
 * source frame rate, so a fast swing aliases and the control signal picks up steps that the
 * athlete's real motion does not have. Endpoints shrink the window rather than clamping, so
 * contact at the centre of the clip keeps its extremes.
 */
export function smoothLandmarkTrack(
  frames: NamedLandmarks[],
  radius: number
): NamedLandmarks[] {
  if (radius < 1 || frames.length < 3) return frames;
  return frames.map((frame, i) => {
    const out: NamedLandmarks = {};
    for (const name of Object.keys(frame)) {
      const centre = frame[name];
      if (!isVisible(centre)) continue;
      let sx = 0;
      let sy = 0;
      let n = 0;
      const lo = Math.max(0, i - radius);
      const hi = Math.min(frames.length - 1, i + radius);
      for (let j = lo; j <= hi; j++) {
        const lm = frames[j]?.[name];
        if (!isVisible(lm)) continue;
        sx += lm.x;
        sy += lm.y;
        n++;
      }
      out[name] = n ? { ...centre, x: sx / n, y: sy / n } : centre;
    }
    return out;
  });
}

/** Half-width of the smoothing window, in frames. 0 disables it. */
export function correctionPoseSmoothing(): number {
  const n = Number(process.env.CORRECTION_POSE_SMOOTHING);
  if (Number.isFinite(n) && n >= 0 && n <= 5) return Math.floor(n);
  return 1;
}

/**
 * Control-clip canvas, square at `correctionCanvasSize()` by default.
 *
 * Matching the user's footage aspect instead lands on sizes WAN cannot resolve. Divisibility
 * is not the constraint: 624x768 and 848x1024 are both clean multiples of 16 and need no
 * latent padding, yet both decode with the DiT patch grid visible as a 16px lattice (8x VAE
 * downsample times patch_size 2). The same model at the same step count is clean at 768x768,
 * which is near a size it was trained on. Aspect fitting stays available behind
 * CORRECTION_CANVAS_ASPECT for probing candidate sizes, on a multiple of 32.
 */
export function controlCanvasSize(
  videoWidth?: number | null,
  videoHeight?: number | null
): { width: number; height: number } {
  const size = correctionCanvasSize();
  if (process.env.CORRECTION_CANVAS_ASPECT !== "1") {
    return { width: size, height: size };
  }

  const w = typeof videoWidth === "number" && videoWidth > 0 ? videoWidth : 0;
  const h = typeof videoHeight === "number" && videoHeight > 0 ? videoHeight : 0;
  if (!w || !h) return { width: size, height: size };

  const scale = size / Math.max(w, h);
  return { width: round32(w * scale), height: round32(h * scale) };
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
  const width = opts.width ?? correctionCanvasSize();
  const height = opts.height ?? correctionCanvasSize();
  const fps = opts.fps ?? correctionFunFps();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "xevo-openpose-"));
  try {
    opts.landmarkFrames.forEach((lm, i) => {
      const rgb = drawOpenPoseRgb(lm, width, height, opts.overlays?.[i]);
      const name = `frame_${String(i).padStart(4, "0")}.ppm`;
      writePpm(path.join(tmp, name), rgb, width, height);
    });
    const outPath = path.join(tmp, "openpose.mp4");
    // Lossless 4:4:4. Default CRF 23 + yuv420p stamped a 16px H.264 quilt on the black
    // field, and Fun Control copied that grid onto the generated court and stands.
    await runFfmpeg([
      "-y",
      "-framerate",
      String(fps),
      "-i",
      path.join(tmp, "frame_%04d.ppm"),
      "-pix_fmt",
      "yuv444p",
      "-c:v",
      "libx264",
      "-qp",
      "0",
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

/**
 * Span of real action the generated clip covers, centred on contact. 2000ms reaches from
 * backswing through follow-through rather than just the contact instant, and on a typical 2s
 * upload it makes the generated clip cover the same moments as the source, so the
 * before/after compare lines up.
 *
 * Deliberately does not read `CORRECTION_IMPACT_WINDOW_MS`: that one is set to 1000 in
 * deployed env to pick image-correction stills near contact, and reusing it here would hold
 * the video at 1s wherever it is set.
 */
export function correctionVideoWindowMs(): number {
  const n = Number(process.env.CORRECTION_VIDEO_WINDOW_MS);
  if (Number.isFinite(n) && n >= 200) return Math.min(Math.floor(n), 4000);
  return 2000;
}

/**
 * Static fallbacks. Runtime code should prefer `correctionFunLength()` and
 * `correctionCanvasSize()` so the env overrides used for tuning sweeps take effect.
 */
export { DEFAULT_LENGTH as FUN_CONTROL_LENGTH, DEFAULT_SIZE as FUN_CONTROL_SIZE };
