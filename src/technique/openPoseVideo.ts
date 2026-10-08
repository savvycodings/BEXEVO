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
  ball_conf?: number | null;
};

export type ControlOverlay = {
  racket?: { cx: number; cy: number; w: number; h: number };
  /** Grip at the wrist, pointing along the forearm; `length` is the whole racket, in pixels. */
  racketOutline?: { x: number; y: number; angle: number; length: number };
  ball?: { cx: number; cy: number; r: number };
};

const RACKET_RGB: [number, number, number] = [255, 0, 180];
/** Neutral grey: no limb uses it, so it cannot read as part of the skeleton. */
const RACKET_OUTLINE_RGB: [number, number, number] = [160, 160, 160];

/**
 * Padel racket proportions as fractions of overall length (45.5 cm): handle about a third, an
 * oval head 26 cm wide over the remaining two thirds.
 */
const RACKET_HANDLE_FRAC = 0.33;
const RACKET_HEAD_WIDTH_FRAC = 0.57;
/** Racket length over forearm length (about 45 cm over 25 cm). Fallback without YOLO boxes. */
const RACKET_FOREARM_RATIO = 1.8;
/** Bounds on a YOLO-derived length, in forearms, so a stray box cannot draw a giant racket. */
const RACKET_FOREARM_MIN = 1.2;
const RACKET_FOREARM_MAX = 2.6;
const BALL_RGB: [number, number, number] = [255, 220, 0];

/**
 * Off by default. A saturated filled rectangle is a very strong control signal, and WAN paints
 * it in literally as a striped slab instead of a paddle. With it gone, the racket has to come
 * from the start frame and the prompt, which is what keeps it looking like the athlete's own.
 */
function drawRacketBox(): boolean {
  return String(process.env.CORRECTION_DRAW_RACKET_BOX ?? "").trim().toLowerCase() === "true";
}

/**
 * Thin outline instead of a filled box: a handle line from the wrist and an unfilled oval head.
 * It tells Fun Control where the racket points without handing it a solid shape to paint in.
 * Off by default until a render confirms WAN draws a paddle from it rather than the outline.
 */
function drawRacketOutline(): boolean {
  return String(process.env.CORRECTION_DRAW_RACKET_OUTLINE ?? "").trim().toLowerCase() === "true";
}

function strokeRacketOutline(
  buf: Uint8Array,
  width: number,
  height: number,
  r: NonNullable<ControlOverlay["racketOutline"]>
): void {
  const ux = Math.cos(r.angle);
  const uy = Math.sin(r.angle);
  const handle = r.length * RACKET_HANDLE_FRAC;
  const a = (r.length - handle) / 2;
  const b = (r.length * RACKET_HEAD_WIDTH_FRAC) / 2;
  const hx = r.x + ux * handle;
  const hy = r.y + uy * handle;
  drawThickLine(buf, width, height, Math.round(r.x), Math.round(r.y), Math.round(hx), Math.round(hy), 2, RACKET_OUTLINE_RGB);
  const cx = hx + ux * a;
  const cy = hy + uy * a;
  const steps = 48;
  let prev: [number, number] | null = null;
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const along = Math.cos(t) * a;
    const across = Math.sin(t) * b;
    const pt: [number, number] = [
      Math.round(cx + ux * along - uy * across),
      Math.round(cy + uy * along + ux * across),
    ];
    if (prev) drawThickLine(buf, width, height, prev[0], prev[1], pt[0], pt[1], 1, RACKET_OUTLINE_RGB);
    prev = pt;
  }
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

function racketWristName(handedness: string): "LEFT_WRIST" | "RIGHT_WRIST" {
  return handedness.toLowerCase().includes("left") ? "LEFT_WRIST" : "RIGHT_WRIST";
}

/**
 * Which labelled wrist holds the racket, from YOLO racket boxes. On a volley the free arm
 * reaches out for balance, so wrist reach (`inferSwingSideFromLandmarks`) can name the wrong arm;
 * the box sits on the racket itself.
 *
 * A frame votes only when the box centre is clearly nearer one wrist (at most
 * `RACKET_HAND_CLEAR_RATIO` of the other distance). In the padel ready position and backswing the
 * free hand holds the throat, right under the head, so whole-clip votes split or point at the free
 * hand; pass `around` to vote only near contact, where the hands are apart. Needs
 * `RACKET_HAND_MIN_FRAMES` votes and a 2:1 majority. `centres` are normalized and index-aligned
 * with `frames`. Null when the boxes are too few or split.
 */
export function racketSideFromBoxes(
  frames: NamedLandmarks[],
  centres: Array<{ x: number; y: number } | null>,
  aspect = 1,
  around?: { index: number; radius: number }
): "LEFT" | "RIGHT" | null {
  let nearLeft = 0;
  let nearRight = 0;
  centres.forEach((c, i) => {
    if (around && Math.abs(i - around.index) > around.radius) return;
    const lm = frames[i];
    if (!c || !lm || !isVisible(lm.LEFT_WRIST) || !isVisible(lm.RIGHT_WRIST)) return;
    const dl = Math.hypot((c.x - lm.LEFT_WRIST.x) * aspect, c.y - lm.LEFT_WRIST.y);
    const dr = Math.hypot((c.x - lm.RIGHT_WRIST.x) * aspect, c.y - lm.RIGHT_WRIST.y);
    if (Math.min(dl, dr) > RACKET_HAND_CLEAR_RATIO * Math.max(dl, dr)) return;
    if (dl < dr) nearLeft++;
    else nearRight++;
  });
  if (nearLeft + nearRight < RACKET_HAND_MIN_FRAMES) return null;
  if (nearLeft >= 2 * nearRight) return "LEFT";
  if (nearRight >= 2 * nearLeft) return "RIGHT";
  return null;
}

/** A racket box votes for a wrist only when at most this fraction of its distance to the other. */
const RACKET_HAND_CLEAR_RATIO = 0.5;
/** Seconds either side of contact whose racket boxes vote on the racket hand. */
export const RACKET_HAND_CONTACT_S = 0.15;

/** Frames with a racket box near a wrist needed before the boxes, not the profile, pick the hand. */
const RACKET_HAND_MIN_FRAMES = 3;
/**
 * Where a held racket's box centre can sit, in racket lengths from the wrist. The head's centre
 * is about two thirds of the way out; the margins allow for foreshortening and loose boxes.
 */
const RACKET_CENTRE_MIN = 0.15;
const RACKET_CENTRE_MAX = 1.2;

/** Shift each angle by whole turns so it is within half a turn of the previous one. */
function unwrapAngles(angles: number[]): number[] {
  const out: number[] = [];
  for (const a of angles) {
    if (!out.length) {
      out.push(a);
      continue;
    }
    let v = a;
    const prev = out[out.length - 1]!;
    while (v - prev > Math.PI) v -= 2 * Math.PI;
    while (v - prev < -Math.PI) v += 2 * Math.PI;
    out.push(v);
  }
  return out;
}

/**
 * Per-frame racket angle from wrist to racket-box centre, with gaps interpolated, ends held and
 * a radius-1 average to steady it. Null when no frame has a usable box, so callers fall back to
 * the forearm direction.
 */
export function racketOutlineAngles(opts: {
  centres: Array<{ x: number; y: number } | null>;
  wrists: Array<{ x: number; y: number } | null>;
  length: number | null;
}): number[] | null {
  if (opts.length == null) return null;
  const n = opts.centres.length;
  const known: Array<{ i: number; a: number }> = [];
  for (let i = 0; i < n; i++) {
    const c = opts.centres[i];
    const w = opts.wrists[i];
    if (!c || !w) continue;
    const d = Math.hypot(c.x - w.x, c.y - w.y);
    if (d < RACKET_CENTRE_MIN * opts.length || d > RACKET_CENTRE_MAX * opts.length) continue;
    known.push({ i, a: Math.atan2(c.y - w.y, c.x - w.x) });
  }
  if (!known.length) return null;
  const unwrapped = unwrapAngles(known.map((k) => k.a));
  known.forEach((k, j) => (k.a = unwrapped[j]!));
  const filled: number[] = [];
  let k = 0;
  for (let i = 0; i < n; i++) {
    while (k < known.length - 1 && known[k + 1]!.i <= i) k++;
    const lo = known[k]!;
    const hi = known[k + 1];
    if (i <= lo.i || !hi) filled.push(lo.a);
    else filled.push(lo.a + ((hi.a - lo.a) * (i - lo.i)) / (hi.i - lo.i));
  }
  return filled.map((_, i) => {
    const near = filled.slice(Math.max(0, i - 1), i + 2);
    return near.reduce((s, a) => s + a, 0) / near.length;
  });
}

/**
 * Fastest plausible ball, in frame widths (longest canvas side) per second. A volleyed ball filmed
 * close leaves the racket at about 5 widths/s (0.08 per frame at 60 fps); a cap of 3 cut the
 * track at contact. Static-object removal and confidence scoring keep noise out, not this cap.
 */
const BALL_MAX_SPEED = 6;
/** Longest run of missed detections bridged inside one ball track. */
const BALL_MAX_GAP_S = 0.25;
/** Detections this close (fraction of the longest canvas side) on 3+ frames are a fixed object. */
const BALL_STATIC_RADIUS = 0.015;
const BALL_STATIC_MIN_FRAMES = 3;

export type BallDetection = { frame: number; box: NormBox; conf: number };

/**
 * The single ball track a real ball could have followed, from raw per-frame YOLO boxes.
 *
 * YOLO's ball class fires on court lights, glass reflections and balls lying on the floor. Those
 * sit still across many frames at low confidence, while the struck ball moves every frame. So:
 * drop anything that keeps reappearing in the same spot, then keep the highest-confidence chain
 * of detections whose frame-to-frame jumps a ball could make, bridging only short gaps.
 */
export function cleanBallTrack(
  rows: PoseYoloRow[],
  opts?: { width?: number; height?: number; fps?: number; contactFrame?: number }
): BallDetection[] {
  const width = opts?.width ?? DEFAULT_SIZE;
  const height = opts?.height ?? DEFAULT_SIZE;
  const fps = opts?.fps && opts.fps > 0 ? opts.fps : 30;
  const side = Math.max(width, height);
  const centre = (b: NormBox) => ({ x: ((b[0] + b[2]) / 2) * width, y: ((b[1] + b[3]) / 2) * height });

  const raw: BallDetection[] = rows
    .filter((r) => r.ball_bbox && boxSize(r.ball_bbox).w > 0.005 && Number.isFinite(r.frame))
    .map((r) => ({ frame: r.frame, box: r.ball_bbox!, conf: Number(r.ball_conf) || 0.1 }))
    .sort((a, b) => a.frame - b.frame);

  const isStatic = raw.map((d) => {
    const c = centre(d.box);
    const frames = new Set<number>();
    for (const o of raw) {
      const q = centre(o.box);
      if (Math.hypot(q.x - c.x, q.y - c.y) <= BALL_STATIC_RADIUS * side) frames.add(o.frame);
    }
    return frames.size >= BALL_STATIC_MIN_FRAMES;
  });
  const moving = raw.filter((_, i) => !isStatic[i]);
  if (!moving.length) return [];

  const maxStep = (BALL_MAX_SPEED * side) / fps;
  const maxGap = Math.max(1, Math.round(BALL_MAX_GAP_S * fps));
  const score = moving.map((d) => d.conf);
  const prev = moving.map(() => -1);
  for (let i = 0; i < moving.length; i++) {
    const ci = centre(moving[i]!.box);
    for (let j = 0; j < i; j++) {
      const gap = moving[i]!.frame - moving[j]!.frame;
      if (gap <= 0 || gap > maxGap) continue;
      const cj = centre(moving[j]!.box);
      if (Math.hypot(ci.x - cj.x, ci.y - cj.y) > maxStep * gap) continue;
      if (score[j]! + moving[i]!.conf > score[i]!) {
        score[i] = score[j]! + moving[i]!.conf;
        prev[i] = j;
      }
    }
  }
  const chainEndingAt = (end: number): BallDetection[] => {
    const chain: BallDetection[] = [];
    for (let i = end; i >= 0; i = prev[i]!) chain.unshift(moving[i]!);
    return chain;
  };
  let best = 0;
  for (let i = 1; i < moving.length; i++) if (score[i]! > score[best]!) best = i;

  // The ball that matters is the one being hit. A brighter chain elsewhere in the clip (a ball
  // in another rally, a lob before the volley) otherwise wins, and 19 of the stored volleys lost
  // a ball YOLO had seen within 4 frames of contact.
  const contact = opts?.contactFrame;
  if (contact != null && Number.isFinite(contact)) {
    let bestNear: number | null = null;
    for (let i = 0; i < moving.length; i++) {
      const chain = chainEndingAt(i);
      if (chain.length < 2) continue;
      if (!chain.some((d) => Math.abs(d.frame - contact) <= maxGap)) continue;
      if (bestNear == null || score[i]! > score[bestNear]!) bestNear = i;
    }
    if (bestNear != null) return chainEndingAt(bestNear);
  }
  return chainEndingAt(best);
}

/**
 * Median YOLO racket size in the window; the ball from `cleanBallTrack`, interpolated between
 * its detections and absent outside them.
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
  /** Source frame rate, to judge how far a ball can travel between frames. */
  fps?: number;
  /**
   * The athlete's own poses in canvas space, index-aligned with `userFrameIndices`. With them
   * the racket hand and racket angle come from where YOLO saw the racket in the footage.
   */
  userLandmarks?: NamedLandmarks[];
  /**
   * Source frame of contact. With it the ball is moved onto the racket head at contact (see
   * `meetBallAtContact`); without it the ball stays where the footage put it.
   */
  contactFrame?: number;
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
  const racketCentreAt = (frame: number): { x: number; y: number } | null => {
    let best: PoseYoloRow | null = null;
    for (const r of opts.poseRows) {
      if (!r.racket_bbox || Math.abs(r.frame - frame) > 1) continue;
      if (!best || Math.abs(r.frame - frame) < Math.abs(best.frame - frame)) best = r;
    }
    if (!best?.racket_bbox) return null;
    const b = best.racket_bbox;
    return { x: ((b[0] + b[2]) / 2) * width, y: ((b[1] + b[3]) / 2) * height };
  };
  const racketCentres = opts.userFrameIndices.map(racketCentreAt);

  // MediaPipe's LEFT_/RIGHT_ labels do not reliably follow the athlete's real hand, so when the
  // footage clearly shows which wrist the racket sits next to, that beats profile handedness.
  let wristKey: "LEFT_WRIST" | "RIGHT_WRIST" = racketWristName(opts.handedness);
  if (opts.userLandmarks) {
    const centresNorm = racketCentres.map((c) => (c ? { x: c.x / width, y: c.y / height } : null));
    const contactIdx =
      opts.contactFrame != null && Number.isFinite(opts.contactFrame)
        ? nearestIndex(opts.userFrameIndices, opts.contactFrame)
        : null;
    const step =
      opts.userFrameIndices.length > 1
        ? Math.max(1, (opts.userFrameIndices.at(-1)! - opts.userFrameIndices[0]!) / (opts.userFrameIndices.length - 1))
        : 1;
    const radius = Math.max(2, Math.round((RACKET_HAND_CONTACT_S * (opts.fps ?? 30)) / step));
    const side =
      (contactIdx != null
        ? racketSideFromBoxes(opts.userLandmarks, centresNorm, width / height, { index: contactIdx, radius })
        : null) ?? racketSideFromBoxes(opts.userLandmarks, centresNorm, width / height);
    if (side) wristKey = `${side}_WRIST`;
  }
  const elbowKey = wristKey === "LEFT_WRIST" ? "LEFT_ELBOW" : "RIGHT_ELBOW";

  // Outline length: the YOLO box's long side, kept within plausible forearm multiples, else a
  // fixed multiple of the forearm. One length for the window so the racket does not pulse.
  const forearms: number[] = [];
  for (const lm of opts.controlLandmarks) {
    const w = lm[wristKey];
    const e = lm[elbowKey];
    if (!isVisible(w) || !isVisible(e)) continue;
    const wp = toPixel(w, width, height);
    const ep = toPixel(e, width, height);
    forearms.push(Math.hypot(wp.x - ep.x, wp.y - ep.y));
  }
  const forearm = median(forearms);
  const yoloLength = rw != null && rh != null ? Math.max(rw * width, rh * height) : null;
  const outlineLength =
    forearm == null
      ? null
      : yoloLength == null
        ? forearm * RACKET_FOREARM_RATIO
        : Math.max(forearm * RACKET_FOREARM_MIN, Math.min(forearm * RACKET_FOREARM_MAX, yoloLength));

  // Racket angle from the footage: wrist to YOLO racket centre on each frame, when the box sits
  // where a held racket's centre can be. On a volley the wrist is laid back and the racket
  // points across the body, so the forearm direction alone draws it facing the wrong way.
  const racketAngles = racketOutlineAngles({
    centres: racketCentres,
    wrists: opts.userFrameIndices.map((_, i) => {
      const w = opts.userLandmarks?.[i]?.[wristKey];
      return isVisible(w) ? toPixel(w, width, height) : null;
    }),
    length: outlineLength,
  });

  const track = cleanBallTrack(opts.poseRows, {
    width,
    height,
    fps: opts.fps,
    contactFrame: opts.contactFrame,
  });
  // Inside the track only: before the first or after the last detection there is no ball to
  // place, and holding an end box froze a dot on screen for the rest of the clip.
  const lerpBox = (frame: number): NormBox | null => {
    if (!track.length || frame < track[0]!.frame || frame > track[track.length - 1]!.frame) {
      return null;
    }
    let k = 0;
    while (k < track.length - 1 && track[k + 1]!.frame <= frame) k++;
    const prev = track[k]!;
    if (prev.frame === frame || k === track.length - 1) return prev.box;
    const next = track[k + 1]!;
    const t = (frame - prev.frame) / (next.frame - prev.frame);
    return [
      prev.box[0] + (next.box[0] - prev.box[0]) * t,
      prev.box[1] + (next.box[1] - prev.box[1]) * t,
      prev.box[2] + (next.box[2] - prev.box[2]) * t,
      prev.box[3] + (next.box[3] - prev.box[3]) * t,
    ] as NormBox;
  };

  const overlays = opts.controlLandmarks.map((lm, i) => {
    const overlay: ControlOverlay = {};
    const wristLm = lm[wristKey];
    const elbowLm = lm[elbowKey];
    if (outlineLength != null && isVisible(wristLm)) {
      const wp = toPixel(wristLm, width, height);
      let angle = racketAngles?.[i] ?? null;
      if (angle == null && isVisible(elbowLm)) {
        const ep = toPixel(elbowLm, width, height);
        if (wp.x !== ep.x || wp.y !== ep.y) angle = Math.atan2(wp.y - ep.y, wp.x - ep.x);
      }
      if (angle != null) {
        overlay.racketOutline = { x: wp.x, y: wp.y, angle, length: outlineLength };
      }
    }
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
    const ball = lerpBox(opts.userFrameIndices[i] ?? -1);
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
  if (opts.contactFrame == null || !Number.isFinite(opts.contactFrame)) return overlays;
  return meetBallAtContact(overlays, nearestIndex(opts.userFrameIndices, opts.contactFrame));
}

/** Index of the frame number in `frames` closest to `frame`. */
function nearestIndex(frames: number[], frame: number): number {
  let best = 0;
  frames.forEach((f, i) => {
    if (Math.abs(f - frame) < Math.abs(frames[best]! - frame)) best = i;
  });
  return best;
}

/** Frames either side of contact searched for a ball to put on the racket. */
const BALL_CONTACT_SEARCH = 2;

/**
 * Translate the whole ball track so the ball sits on the racket head centre at contact.
 *
 * The control skeleton is a correction: its racket wrist is blended toward the pro, so the
 * racket is no longer where the footage had it, while the ball is. On the stored forehand
 * volleys the footage shows the racket on the ball at contact, yet the skeleton's racket head
 * missed it by 0.5 to 3.9 racket lengths. A rigid shift keeps the filmed flight path and timing
 * and makes the hit land on the racket that is actually drawn. When no ball is tracked near
 * contact, or there is no racket to meet, the ball is dropped: a ball flying past the racket
 * is a worse instruction than none.
 */
export function meetBallAtContact(overlays: ControlOverlay[], contactIdx: number): ControlOverlay[] {
  let j: number | null = null;
  for (let d = 0; d <= BALL_CONTACT_SEARCH && j == null; d++) {
    for (const k of [contactIdx - d, contactIdx + d]) {
      if (overlays[k]?.ball && overlays[k]?.racketOutline) {
        j = k;
        break;
      }
    }
  }
  if (j == null) return overlays.map(({ ball: _ball, ...rest }) => rest);
  const r = overlays[j]!.racketOutline!;
  const reach = r.length * (RACKET_HANDLE_FRAC + (1 - RACKET_HANDLE_FRAC) / 2);
  const dx = Math.round(r.x + Math.cos(r.angle) * reach - overlays[j]!.ball!.cx);
  const dy = Math.round(r.y + Math.sin(r.angle) * reach - overlays[j]!.ball!.cy);
  return overlays.map((o) =>
    o.ball ? { ...o, ball: { ...o.ball, cx: o.ball.cx + dx, cy: o.ball.cy + dy } } : o
  );
}

/** OpenPose hand: 21 points, wrist 0, then four per finger from thumb (1-4) to little (17-20). */
const HAND_EDGES: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [0, 9], [9, 10], [10, 11], [11, 12],
  [0, 13], [13, 14], [14, 15], [15, 16],
  [0, 17], [17, 18], [18, 19], [19, 20],
];
export const HAND_POINTS = 21;

export function handPointName(side: "LEFT" | "RIGHT", i: number): string {
  return `${side}_HAND_${i}`;
}

function hasHand(lm: NamedLandmarks, side: "LEFT" | "RIGHT"): boolean {
  let n = 0;
  for (let i = 0; i < HAND_POINTS; i++) if (isVisible(lm[handPointName(side, i)])) n++;
  return n >= HAND_MIN_POINTS;
}

/** Visible points a hand needs before it is drawn instead of the wrist-to-index stub. */
const HAND_MIN_POINTS = 8;

/** Edge colours as in controlnet_aux's draw_handpose: hue steps once per edge. */
function handEdgeColor(i: number): [number, number, number] {
  const h = (i / HAND_EDGES.length) * 6;
  const f = h - Math.floor(h);
  const q = Math.round(255 * (1 - f));
  const t = Math.round(255 * f);
  switch (Math.floor(h) % 6) {
    case 0: return [255, t, 0];
    case 1: return [q, 255, 0];
    case 2: return [0, 255, t];
    case 3: return [0, q, 255];
    case 4: return [t, 0, 255];
    default: return [255, 0, q];
  }
}

function drawHand(
  buf: Uint8Array,
  width: number,
  height: number,
  lm: NamedLandmarks,
  side: "LEFT" | "RIGHT"
): void {
  if (!hasHand(lm, side)) return;
  HAND_EDGES.forEach(([a, b], i) => {
    const pa = lm[handPointName(side, a)];
    const pb = lm[handPointName(side, b)];
    if (!isVisible(pa) || !isVisible(pb)) return;
    const A = toPixel(pa, width, height);
    const B = toPixel(pb, width, height);
    drawThickLine(buf, width, height, A.x, A.y, B.x, B.y, 1, handEdgeColor(i));
  });
  // Keypoint dots sized to the hand: fixed 4 px dots, as controlnet_aux draws them, swallow a
  // hand only a dozen pixels across into one red blob.
  const w0 = lm[handPointName(side, 0)];
  const tip = lm[handPointName(side, 12)];
  const span = isVisible(w0) && isVisible(tip)
    ? Math.hypot((tip.x - w0.x) * width, (tip.y - w0.y) * height)
    : 0;
  const dot = Math.max(0, Math.min(3, Math.round(span / 20)));
  for (let i = 0; i < HAND_POINTS; i++) {
    const p = lm[handPointName(side, i)];
    if (!isVisible(p)) continue;
    const P = toPixel(p, width, height);
    drawDisk(buf, width, height, P.x, P.y, dot, [255, 0, 0]);
  }
}

export function drawOpenPoseRgb(
  landmarks: NamedLandmarks,
  width = DEFAULT_SIZE,
  height = DEFAULT_SIZE,
  overlay?: ControlOverlay
): Buffer {
  const buf = new Uint8Array(width * height * 3);
  // Under the skeleton, so the wrist joint and forearm stay intact where the handle starts.
  if (overlay?.racketOutline && drawRacketOutline()) {
    strokeRacketOutline(buf, width, height, overlay.racketOutline);
  }
  for (const [a, b, color] of BONES) {
    // A full 21-point hand replaces MediaPipe's single wrist-to-index stub.
    if (b.endsWith("_INDEX") && !b.includes("FOOT") && hasHand(landmarks, b.startsWith("LEFT") ? "LEFT" : "RIGHT")) {
      continue;
    }
    const la = landmarks[a];
    const lb = landmarks[b];
    if (!isVisible(la) || !isVisible(lb)) continue;
    const pa = toPixel(la, width, height);
    const pb = toPixel(lb, width, height);
    drawThickLine(buf, width, height, pa.x, pa.y, pb.x, pb.y, 4, color);
  }
  for (const side of ["LEFT", "RIGHT"] as const) drawHand(buf, width, height, landmarks, side);
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

/** LEFT_WRIST <-> RIGHT_WRIST and so on; names without a side keep theirs. */
function mirroredJointName(name: string): string {
  if (name.startsWith("LEFT_")) return `RIGHT_${name.slice(5)}`;
  if (name.startsWith("RIGHT_")) return `LEFT_${name.slice(6)}`;
  return name;
}

export type Facing = "FRONT" | "BACK";

/**
 * Whether the body faces the camera, from the image order of the shoulders and hips. Facing the
 * camera, the body's left side is on the image's right. OpenPose limb colours encode that order,
 * so Fun Control reads it as which way the player faces. Null when the window is too mixed or
 * side-on to call.
 */
export function inferFacing(frames: NamedLandmarks[]): Facing | null {
  let front = 0;
  let back = 0;
  for (const lm of frames) {
    let v = 0;
    if (isVisible(lm.LEFT_SHOULDER) && isVisible(lm.RIGHT_SHOULDER)) v += lm.LEFT_SHOULDER.x - lm.RIGHT_SHOULDER.x;
    if (isVisible(lm.LEFT_HIP) && isVisible(lm.RIGHT_HIP)) v += lm.LEFT_HIP.x - lm.RIGHT_HIP.x;
    if (v > FACING_MIN_SPREAD) front++;
    else if (v < -FACING_MIN_SPREAD) back++;
  }
  if (front >= 2 * back && front >= FACING_MIN_FRAMES) return "FRONT";
  if (back >= 2 * front && back >= FACING_MIN_FRAMES) return "BACK";
  return null;
}

/** Shoulder plus hip spread, in frame widths, below which a frame counts as side-on. */
const FACING_MIN_SPREAD = 0.01;
const FACING_MIN_FRAMES = 4;

/**
 * How to bring the pro into the athlete's orientation. Two independent mismatches:
 * - the swinging arm differs: swap LEFT_/RIGHT_ names, so blending pairs racket arm with racket arm;
 * - the camera sees the other side of the body (front vs behind): flip x, which turns the
 *   skeleton round in the image while each joint keeps its name.
 * A real mirror image (other arm, same facing) needs both. Flipping without the swap, as the
 * old code did for every mismatch, paired the wrong arms; swapping with the flip on a pro filmed
 * from behind drew a skeleton facing away, and Fun Control rendered the athlete's back.
 * Unknown sides or facing count as matching, which leaves the pro as it is.
 */
export function proOrientationPlan(opts: {
  userSide: "LEFT" | "RIGHT" | null;
  proSide: "LEFT" | "RIGHT" | null;
  userFacing: Facing | null;
  proFacing: Facing | null;
}): { swapSides: boolean; flipX: boolean } {
  const swapSides = Boolean(opts.userSide && opts.proSide && opts.userSide !== opts.proSide);
  const facingDiffers = Boolean(
    opts.userFacing && opts.proFacing && opts.userFacing !== opts.proFacing
  );
  return { swapSides, flipX: swapSides !== facingDiffers };
}

/**
 * Put the pro skeleton in the user's camera frame: hip midpoints coincide, pro limb lengths
 * scale to the user's torso, and `flipX` / `swapSides` (see `proOrientationPlan`) bring the pro
 * into the athlete's facing and swinging arm. Without this the control clip carries the pro's
 * position, body size, and viewpoint.
 */
export function retargetProToUser(
  proLm: NamedLandmarks,
  userLm: NamedLandmarks,
  opts?: { aspect?: number; flipX?: boolean; swapSides?: boolean; scale?: number }
): NamedLandmarks {
  const aspect = opts?.aspect && opts.aspect > 0 ? opts.aspect : 1;
  const proFrame = bodyFrameOf(proLm, aspect);
  const userFrame = bodyFrameOf(userLm, aspect);
  if (!proFrame || !userFrame) return proLm;

  const scale =
    opts?.scale && Number.isFinite(opts.scale) && opts.scale > 0
      ? opts.scale
      : userFrame.torso / proFrame.torso;
  const sx = opts?.flipX ? -scale : scale;
  const out: NamedLandmarks = {};
  for (const [name, lm] of Object.entries(proLm)) {
    if (!lm || typeof lm.x !== "number" || typeof lm.y !== "number") continue;
    out[opts?.swapSides ? mirroredJointName(name) : name] = {
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
    // Both or neither: an occluded arm would otherwise add zero reach and lose by default.
    if (l == null || r == null) continue;
    left += l;
    right += r;
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
 * One pro-to-user size factor for the whole window: median user torso over median pro torso.
 * The per-frame ratio jumps whenever either torso foreshortens through trunk rotation, and
 * because retargeting scales about the hips, the whole skeleton shrinks and the feet lift on
 * that frame. Null when no frame resolves a torso on both sides.
 */
export function windowRetargetScale(
  userFrames: NamedLandmarks[],
  proFrames: NamedLandmarks[],
  aspect = 1
): number | null {
  const count = Math.min(userFrames.length, proFrames.length);
  const userTorsos: number[] = [];
  const proTorsos: number[] = [];
  for (let i = 0; i < count; i++) {
    const u = bodyFrameOf(userFrames[i] ?? {}, aspect);
    const p = bodyFrameOf(proFrames[i] ?? {}, aspect);
    if (!u || !p) continue;
    userTorsos.push(u.torso);
    proTorsos.push(p.torso);
  }
  const u = median(userTorsos);
  const p = median(proTorsos);
  if (u == null || p == null) return null;
  return u / p;
}

const BODY_SIZE_BONES: ReadonlyArray<readonly [string, string]> = [
  ["LEFT_SHOULDER", "RIGHT_SHOULDER"],
  ["LEFT_HIP", "RIGHT_HIP"],
  ["LEFT_SHOULDER", "LEFT_HIP"],
  ["RIGHT_SHOULDER", "RIGHT_HIP"],
  ["LEFT_SHOULDER", "LEFT_ELBOW"],
  ["RIGHT_SHOULDER", "RIGHT_ELBOW"],
  ["LEFT_HIP", "LEFT_KNEE"],
  ["RIGHT_HIP", "RIGHT_KNEE"],
  ["LEFT_KNEE", "LEFT_ANKLE"],
  ["RIGHT_KNEE", "RIGHT_ANKLE"],
];

/** Frames either side whose median body size a frame is judged against. Wider than a 2-frame tracker jump. */
const BODY_SIZE_LOCAL_RADIUS = 4;

/** Fractional deviation of a frame's body size from its neighbours' before it counts as a bad detection. */
export function correctionBodySizeTolerance(): number {
  const n = Number(process.env.CORRECTION_BODY_SIZE_TOLERANCE);
  if (Number.isFinite(n) && n > 0 && n < 1) return n;
  return 0.2;
}

/**
 * Each frame's body size relative to the window: for every bone, its length on this frame over
 * its median length across the window, then the median of those ratios. A real swing shortens
 * some bones through foreshortening while others hold, so the median stays near 1. A frame
 * where the tracker jumped to a smaller figure shrinks every bone at once. Null when too few
 * bones resolve to judge.
 */
export function bodySizeRatios(frames: NamedLandmarks[], aspect = 1): Array<number | null> {
  const lengths = frames.map((lm) =>
    BODY_SIZE_BONES.map(([a, b]) => {
      const p = lm[a];
      const q = lm[b];
      if (!isVisible(p) || !isVisible(q)) return null;
      return Math.hypot((p.x - q.x) * aspect, p.y - q.y);
    })
  );
  const boneMedians = BODY_SIZE_BONES.map((_, k) =>
    median(lengths.map((row) => row[k]).filter((n): n is number => n != null))
  );
  return lengths.map((row) => {
    const ratios: number[] = [];
    row.forEach((len, k) => {
      const ref = boneMedians[k];
      if (len != null && ref != null && ref > 0) ratios.push(len / ref);
    });
    return ratios.length >= 4 ? median(ratios) : null;
  });
}

/**
 * Rebuild frames whose body size is off their neighbours' by more than `tolerance`, interpolating
 * every joint from the nearest good frames on each side (or copying the nearest at the ends).
 * Pose tracks occasionally lock onto a background figure for a frame or two; retargeting and
 * smoothing then shrink the control skeleton across several frames. Returns the input
 * unchanged when no frame is flagged, or when every frame is.
 */
export function rejectBodySizeOutliers(
  frames: NamedLandmarks[],
  opts?: { aspect?: number; tolerance?: number }
): { frames: NamedLandmarks[]; replaced: number[] } {
  const tolerance = opts?.tolerance ?? correctionBodySizeTolerance();
  const ratios = bodySizeRatios(frames, opts?.aspect ?? 1);
  // Judge each frame against its neighbours, not the whole window: an athlete closing on the
  // net grows steadily through the clip (0.84 to 1.32 on one stored volley), and a window-wide
  // reference flagged the last frames as tracker jumps and rebuilt them as collapsed poses.
  const bad = ratios.map((r, i) => {
    if (r == null) return false;
    const near = ratios
      .slice(Math.max(0, i - BODY_SIZE_LOCAL_RADIUS), i + BODY_SIZE_LOCAL_RADIUS + 1)
      .filter((n): n is number => n != null);
    const ref = median(near);
    return ref != null && Math.abs(r / ref - 1) > tolerance;
  });
  const replaced = bad.flatMap((b, i) => (b ? [i] : []));
  if (!replaced.length || replaced.length === frames.length) return { frames, replaced: [] };

  const goodBefore = (i: number) => {
    for (let j = i - 1; j >= 0; j--) if (!bad[j]) return j;
    return null;
  };
  const goodAfter = (i: number) => {
    for (let j = i + 1; j < frames.length; j++) if (!bad[j]) return j;
    return null;
  };
  const out = frames.map((frame, i) => {
    if (!bad[i]) return frame;
    const lo = goodBefore(i);
    const hi = goodAfter(i);
    if (lo == null) return frames[hi!]!;
    if (hi == null) return frames[lo]!;
    const t = (i - lo) / (hi - lo);
    const a = frames[lo]!;
    const b = frames[hi]!;
    const lm: NamedLandmarks = {};
    for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const p = a[name];
      const q = b[name];
      if (isVisible(p) && isVisible(q)) {
        lm[name] = {
          ...p,
          x: p.x + (q.x - p.x) * t,
          y: p.y + (q.y - p.y) * t,
          visibility: Math.min(p.visibility ?? 1, q.visibility ?? 1),
        };
      } else {
        // Prefer whichever side actually sees the joint; `??` alone kept an invisible one.
        const seen = isVisible(p) ? p : isVisible(q) ? q : undefined;
        lm[name] = seen ?? (t < 0.5 ? (p ?? q) : (q ?? p));
      }
    }
    return lm;
  });
  return { frames: out, replaced };
}

/** Share of window frames a joint must be seen on before its gaps are filled. */
const GAP_FILL_MIN_COVERAGE = 0.3;

/**
 * Fill frames where a joint is missing by interpolating between the nearest frames that see it,
 * holding the nearest value at the window ends. A joint dropped for a few frames otherwise
 * vanishes from the skeleton, and in blending the other side's joint stands in at full weight,
 * so the frame jumps from a partial correction to the raw pro pose. Joints seen on less than
 * `minCoverage` of the window are left alone rather than invented.
 */
export function fillJointGaps(
  frames: NamedLandmarks[],
  minCoverage = GAP_FILL_MIN_COVERAGE
): { frames: NamedLandmarks[]; filled: number } {
  if (frames.length < 2) return { frames, filled: 0 };
  const names = new Set(frames.flatMap((lm) => Object.keys(lm)));
  const out = frames.map((lm) => ({ ...lm }));
  let filled = 0;
  for (const name of names) {
    const seen = frames.flatMap((lm, i) => (isVisible(lm[name]) ? [i] : []));
    if (!seen.length || seen.length === frames.length) continue;
    if (seen.length / frames.length < minCoverage) continue;
    let k = 0;
    for (let i = 0; i < frames.length; i++) {
      if (isVisible(frames[i]![name])) continue;
      while (k < seen.length && seen[k]! < i) k++;
      const lo = k > 0 ? seen[k - 1]! : null;
      const hi = k < seen.length ? seen[k]! : null;
      const a = lo != null ? frames[lo]![name]! : null;
      const b = hi != null ? frames[hi]![name]! : null;
      if (a && b) {
        const t = (i - lo!) / (hi! - lo!);
        out[i]![name] = {
          ...a,
          x: a.x + (b.x - a.x) * t,
          y: a.y + (b.y - a.y) * t,
          visibility: Math.min(a.visibility ?? 1, b.visibility ?? 1),
        };
      } else {
        out[i]![name] = { ...(a ?? b)! };
      }
      filled++;
    }
  }
  return { frames: out, filled };
}

/**
 * Per-frame control poses: retarget the pro into the user's frame, then blend the user
 * toward it so the clip reads as a correction of this athlete rather than a pose swap.
 */
export function coachedControlLandmarkFrames(opts: {
  userFrames: NamedLandmarks[];
  proFrames: NamedLandmarks[];
  aspect?: number;
  flipX?: boolean;
  swapSides?: boolean;
  blend?: number;
  /** Pro size factor; defaults to `windowRetargetScale`, else per-frame torso ratio. */
  scale?: number | null;
  /**
   * Labelled side that holds the racket. With it the other (free) arm follows the athlete's own
   * motion, blended only `freeArmBlend` toward the pro; without it every joint blends alike.
   */
  racketSide?: "LEFT" | "RIGHT" | null;
  freeArmBlend?: number;
}): NamedLandmarks[] {
  const blend = opts.blend ?? correctionPoseBlend();
  const count = Math.min(opts.userFrames.length, opts.proFrames.length);
  const freeBlend = opts.freeArmBlend ?? correctionFreeArmBlend() ?? blend;
  const scale =
    opts.scale !== undefined
      ? opts.scale
      : windowRetargetScale(opts.userFrames, opts.proFrames, opts.aspect);
  const out: NamedLandmarks[] = new Array(count);
  const pairs: Array<{ i: number; userLm: NamedLandmarks; retargeted: NamedLandmarks; blended: NamedLandmarks }> = [];
  for (let i = 0; i < count; i++) {
    const userLm = opts.userFrames[i] ?? {};
    const proLm = opts.proFrames[i] ?? {};
    if (!Object.keys(userLm).length) {
      out[i] = proLm;
      continue;
    }
    const retargeted = retargetProToUser(withoutHands(proLm), userLm, {
      aspect: opts.aspect,
      flipX: opts.flipX,
      swapSides: opts.swapSides,
      scale: scale ?? undefined,
    });
    pairs.push({ i, userLm, retargeted, blended: blendLandmarks(userLm, retargeted, blend) });
  }
  // One elbow-bend direction per arm for the whole window, so neighbouring frames cannot bend
  // opposite ways and be averaged into a straight or kinked arm by the smoothing below.
  const bendSigns = elbowBendSignTrack(
    pairs.map((p) => p.userLm),
    pairs.map((p) => p.retargeted),
    { aspect: opts.aspect, racketSide: opts.racketSide ?? null, blend, freeArmBlend: freeBlend }
  );
  pairs.forEach((p, k) => {
    out[p.i] = blendArmsByAngle(p.blended, p.userLm, p.retargeted, {
      aspect: opts.aspect,
      racketSide: opts.racketSide ?? null,
      blend,
      freeArmBlend: freeBlend,
      bendSigns: bendSigns[k],
    });
  });
  // Restore before smoothing: a bone that flips between restored and untouched on neighbouring
  // frames makes the wrist jump, and the moving average evens that out.
  return smoothLandmarkTrack(
    attachHands(restoreLimbLengths(out, opts.userFrames, opts.aspect), opts.userFrames, opts.aspect),
    correctionPoseSmoothing()
  );
}

/**
 * How far the free arm turns toward the pro's, separately from the body blend. Unset: same as
 * the body (`CORRECTION_POSE_BLEND`). 0 keeps the athlete's own free arm.
 */
export function correctionFreeArmBlend(): number | null {
  const raw = process.env.CORRECTION_FREE_ARM_BLEND;
  if (raw == null || raw.trim() === "") return null;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0 && n <= 1) return n;
  return null;
}

const ARM_CHAINS = {
  LEFT: { joints: ["LEFT_SHOULDER", "LEFT_ELBOW", "LEFT_WRIST"], hand: ["LEFT_INDEX", "LEFT_PINKY", "LEFT_THUMB"] },
  RIGHT: { joints: ["RIGHT_SHOULDER", "RIGHT_ELBOW", "RIGHT_WRIST"], hand: ["RIGHT_INDEX", "RIGHT_PINKY", "RIGHT_THUMB"] },
} as const;

/** Signed elbow bend: forearm direction relative to the upper arm, in aspect-corrected space. */
function elbowRel(lm: NamedLandmarks, side: "LEFT" | "RIGHT", a: number): number | null {
  const [s, e, w] = ARM_CHAINS[side].joints.map((n) => lm[n]);
  if (!isVisible(s) || !isVisible(e) || !isVisible(w)) return null;
  return angleDelta(Math.atan2(e.y - s.y, (e.x - s.x) * a), Math.atan2(w.y - e.y, (w.x - e.x) * a));
}

/**
 * Which way each elbow bends on screen over the whole window: the sign of the blend-weighted sum
 * of the athlete's and the pro's signed bends. Chosen per frame, the direction flipped wherever
 * one arm was near straight, and the moving average then folded the two directions into a
 * straight or kinked arm on frames around the flip.
 */
export function windowElbowBendSigns(
  userFrames: NamedLandmarks[],
  proFrames: NamedLandmarks[],
  opts: { aspect?: number; racketSide: "LEFT" | "RIGHT" | null; blend: number; freeArmBlend: number }
): Partial<Record<"LEFT" | "RIGHT", 1 | -1>> {
  const a = opts.aspect && opts.aspect > 0 ? opts.aspect : 1;
  const out: Partial<Record<"LEFT" | "RIGHT", 1 | -1>> = {};
  for (const side of ["LEFT", "RIGHT"] as const) {
    const b = opts.racketSide && side !== opts.racketSide ? opts.freeArmBlend : opts.blend;
    let sum = 0;
    let n = 0;
    userFrames.forEach((u, i) => {
      const ur = elbowRel(u, side, a);
      const pr = elbowRel(proFrames[i] ?? {}, side, a);
      if (ur == null && pr == null) return;
      sum += (1 - b) * (ur ?? 0) + b * (pr ?? 0);
      n++;
    });
    if (n && Math.abs(sum) > 1e-6) out[side] = sum > 0 ? 1 : -1;
  }
  return out;
}

/**
 * Elbow-bend direction per arm per frame, with hysteresis: it starts at the window's direction
 * and changes only on a frame where the athlete and the pro both clearly bend the other way.
 * Letting near-straight frames choose their own direction made it flip back and forth, and the
 * moving average folded the two directions into a straight arm (166-178 degrees through one
 * follow-through where the athlete bent to 89 and the pro to 133).
 */
export function elbowBendSignTrack(
  userFrames: NamedLandmarks[],
  proFrames: NamedLandmarks[],
  opts: { aspect?: number; racketSide: "LEFT" | "RIGHT" | null; blend: number; freeArmBlend: number }
): Array<Partial<Record<"LEFT" | "RIGHT", 1 | -1>>> {
  const a = opts.aspect && opts.aspect > 0 ? opts.aspect : 1;
  const start = windowElbowBendSigns(userFrames, proFrames, opts);
  const current: Partial<Record<"LEFT" | "RIGHT", 1 | -1>> = { ...start };
  return userFrames.map((u, i) => {
    for (const side of ["LEFT", "RIGHT"] as const) {
      const ur = elbowRel(u, side, a);
      const pr = elbowRel(proFrames[i] ?? {}, side, a);
      if (
        ur != null &&
        pr != null &&
        Math.abs(ur) >= ELBOW_CLEAR_BEND &&
        Math.abs(pr) >= ELBOW_CLEAR_BEND &&
        Math.sign(ur) === Math.sign(pr)
      ) {
        current[side] = ur > 0 ? 1 : -1;
      }
    }
    return { ...current };
  });
}

/** Elbow bend (radians away from straight) above which an arm's bend direction is trusted. */
const ELBOW_CLEAR_BEND = (25 * Math.PI) / 180;

/** Signed smallest turn from angle a to angle b, in (-pi, pi]. */
function angleDelta(a: number, b: number): number {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}

/**
 * Rebuild each arm by turning its bones toward the pro's instead of moving its joints.
 *
 * Position blending interpolates each joint on a straight line, which cuts across the arc between
 * two arm poses: the arm comes out shorter and straighter than either. On one forehand volley the
 * player's free arm hung at 150-177 degrees and the pro held his bent at about 100 for balance;
 * blended by position it locked at 171-179, stiff and pressed to the body. Turning the upper arm
 * and forearm by `blend` of the angle between athlete and pro, from the blended shoulder, keeps
 * the athlete's bone lengths and bends the elbow partway toward the pro's (160 to 136 at 0.4).
 * Applied to the free arm only (`freeArmBlend`; 0 keeps the athlete's own) when the racket side
 * is known, to both arms at `blend` when it is not. Hand points turn with the forearm.
 */
export function blendArmsByAngle(
  blended: NamedLandmarks,
  user: NamedLandmarks,
  pro: NamedLandmarks,
  opts: {
    aspect?: number;
    racketSide: "LEFT" | "RIGHT" | null;
    blend: number;
    freeArmBlend: number;
    /** Elbow-bend direction per arm for this frame (see `elbowBendSignTrack`). */
    bendSigns?: Partial<Record<"LEFT" | "RIGHT", 1 | -1>>;
  }
): NamedLandmarks {
  const a = opts.aspect && opts.aspect > 0 ? opts.aspect : 1;
  const out: NamedLandmarks = { ...blended };
  for (const side of ["LEFT", "RIGHT"] as const) {
    // The racket arm keeps the position blend: rebuilt by angle it held on to more of the
    // athlete's low racket (beside the thigh at contact instead of out in front) and the render
    // turned the racket into a thin smear. The correction is about that arm moving; the free arm
    // only needs to look natural.
    if (opts.racketSide && side === opts.racketSide) continue;
    const b = opts.racketSide ? opts.freeArmBlend : opts.blend;
    const { joints, hand } = ARM_CHAINS[side];
    let parent: NamedLandmark | undefined = out[joints[0]];
    if (!isVisible(parent)) continue;
    let turnSoFar = 0;
    // Upper arm: absolute direction. Forearm: its bend relative to the upper arm, so the elbow
    // ends up between the athlete's bend and the pro's. Blending both bones' absolute directions
    // could line them up straighter than either pose when they turn different ways.
    let uPrevAng: number | null = null;
    let pPrevAng: number | null = null;
    let cPrevAng: number | null = null;
    for (let k = 1; k < joints.length; k++) {
      const up = user[joints[k - 1]!];
      const uc = user[joints[k]!];
      if (!isVisible(up) || !isVisible(uc)) break;
      const ux = (uc.x - up.x) * a;
      const uy = uc.y - up.y;
      const len = Math.hypot(ux, uy);
      const uAng = Math.atan2(uy, ux);
      const pp = pro[joints[k - 1]!];
      const pc = pro[joints[k]!];
      const pAng = isVisible(pp) && isVisible(pc) ? Math.atan2(pc.y - pp.y, (pc.x - pp.x) * a) : null;
      let ang: number;
      if (pAng == null) {
        ang = cPrevAng != null && uPrevAng != null ? cPrevAng + angleDelta(uPrevAng, uAng) : uAng;
      } else if (cPrevAng != null && uPrevAng != null && pPrevAng != null) {
        // Blend how much the elbow bends, not the signed angle: when the two arms bend opposite
        // ways on screen, the signed blend passes through zero, a straight arm. The direction
        // comes from whichever arm clearly bends, preferring the pro's.
        const uRel = angleDelta(uPrevAng, uAng);
        const pRel = angleDelta(pPrevAng, pAng);
        const mag = Math.abs(uRel) + (Math.abs(pRel) - Math.abs(uRel)) * b;
        // Both arms clearly bending the same way is a real direction; follow it. Otherwise use the
        // window's direction so near-straight frames cannot flip it.
        const bothClear =
          Math.abs(pRel) >= ELBOW_CLEAR_BEND &&
          Math.abs(uRel) >= ELBOW_CLEAR_BEND &&
          Math.sign(pRel) === Math.sign(uRel);
        const sign =
          opts.bendSigns?.[side] ??
          (bothClear
            ? Math.sign(pRel)
            : Math.abs(pRel) >= ELBOW_CLEAR_BEND || Math.abs(uRel) < 1e-3
              ? Math.sign(pRel) || 1
              : Math.sign(uRel));
        ang = cPrevAng + sign * mag;
      } else {
        ang = uAng + angleDelta(uAng, pAng) * b;
      }
      uPrevAng = uAng;
      pPrevAng = pAng;
      cPrevAng = ang;
      const child: NamedLandmark = {
        ...uc,
        x: parent!.x + (Math.cos(ang) * len) / a,
        y: parent!.y + Math.sin(ang) * len,
      };
      out[joints[k]!] = child;
      turnSoFar = ang - uAng;
      parent = child;
    }
    // Hand points follow the wrist, turned with the forearm.
    const uW = user[joints[2]];
    const cW = out[joints[2]];
    if (!isVisible(uW) || !isVisible(cW)) continue;
    const cos = Math.cos(turnSoFar);
    const sin = Math.sin(turnSoFar);
    for (const name of hand) {
      const p = user[name];
      if (!isVisible(p)) continue;
      const dx = (p.x - uW.x) * a;
      const dy = p.y - uW.y;
      out[name] = { ...p, x: cW.x + (dx * cos - dy * sin) / a, y: cW.y + dx * sin + dy * cos };
    }
  }
  return out;
}

/**
 * Labelled side holding the racket for this window: racket boxes near contact when they settle
 * it (see `racketSideFromBoxes`), else the profile's handedness.
 */
export function racketSideForWindow(opts: {
  userFrames: NamedLandmarks[];
  poseRows: PoseYoloRow[];
  userFrameIndices: number[];
  contactFrame: number | null;
  fps: number;
  handedness: string;
  aspect?: number;
}): "LEFT" | "RIGHT" {
  const centres = opts.userFrameIndices.map((f) => {
    const r = opts.poseRows.find((row) => Math.abs(row.frame - f) <= 1 && row.racket_bbox);
    return r?.racket_bbox
      ? { x: (r.racket_bbox[0] + r.racket_bbox[2]) / 2, y: (r.racket_bbox[1] + r.racket_bbox[3]) / 2 }
      : null;
  });
  let side: "LEFT" | "RIGHT" | null = null;
  if (opts.contactFrame != null && opts.userFrameIndices.length) {
    const idx = nearestIndex(opts.userFrameIndices, opts.contactFrame);
    const step =
      opts.userFrameIndices.length > 1
        ? Math.max(1, (opts.userFrameIndices.at(-1)! - opts.userFrameIndices[0]!) / (opts.userFrameIndices.length - 1))
        : 1;
    const radius = Math.max(2, Math.round((RACKET_HAND_CONTACT_S * opts.fps) / step));
    side = racketSideFromBoxes(opts.userFrames, centres, opts.aspect ?? 1, { index: idx, radius });
  }
  side ??= racketSideFromBoxes(opts.userFrames, centres, opts.aspect ?? 1);
  return side ?? (racketWristName(opts.handedness) === "LEFT_WRIST" ? "LEFT" : "RIGHT");
}

function withoutHands(lm: NamedLandmarks): NamedLandmarks {
  const out: NamedLandmarks = {};
  for (const [name, v] of Object.entries(lm)) if (!name.includes("_HAND_")) out[name] = v;
  return out;
}

/**
 * Put the athlete's own hand shape on each corrected wrist.
 *
 * Only the athlete's hands are used: blending finger points toward another person's collapses
 * them the way blending an arm did. Each hand point keeps its offset from the athlete's wrist,
 * turned and scaled with the forearm (elbow to wrist) between the athlete's pose and the
 * corrected one, so the hand stays on the arm. A side without a usable forearm on both loses its
 * hand points rather than leaving them where the athlete's hand was.
 */
export function attachHands(
  frames: NamedLandmarks[],
  userFrames: NamedLandmarks[],
  aspect = 1
): NamedLandmarks[] {
  const a = aspect > 0 ? aspect : 1;
  return frames.map((frame, i) => {
    const user = userFrames[i] ?? {};
    const out: NamedLandmarks = { ...frame };
    for (const side of ["LEFT", "RIGHT"] as const) {
      const names = Array.from({ length: HAND_POINTS }, (_, k) => handPointName(side, k));
      for (const n of names) delete out[n];
      if (!hasHand(user, side)) continue;
      const uW = user[`${side}_WRIST`];
      const uE = user[`${side}_ELBOW`];
      const cW = frame[`${side}_WRIST`];
      const cE = frame[`${side}_ELBOW`];
      if (!isVisible(uW) || !isVisible(uE) || !isVisible(cW) || !isVisible(cE)) continue;
      const uLen = Math.hypot((uW.x - uE.x) * a, uW.y - uE.y);
      const cLen = Math.hypot((cW.x - cE.x) * a, cW.y - cE.y);
      if (uLen < 1e-6 || cLen < 1e-6) continue;
      const turn =
        Math.atan2(cW.y - cE.y, (cW.x - cE.x) * a) - Math.atan2(uW.y - uE.y, (uW.x - uE.x) * a);
      const k = Math.max(HAND_SCALE_MIN, Math.min(HAND_SCALE_MAX, cLen / uLen));
      const cos = Math.cos(turn) * k;
      const sin = Math.sin(turn) * k;
      for (const n of names) {
        const p = user[n];
        if (!isVisible(p)) continue;
        const dx = (p.x - uW.x) * a;
        const dy = p.y - uW.y;
        out[n] = { ...p, x: cW.x + (dx * cos - dy * sin) / a, y: cW.y + dx * sin + dy * cos };
      }
    }
    return out;
  });
}

/** Bounds on how much a hand grows or shrinks with its forearm, so a foreshortened arm keeps a hand. */
const HAND_SCALE_MIN = 0.8;
const HAND_SCALE_MAX = 1.25;

/** Limb chains from the torso outward; each later joint hangs off the one before it. */
const LIMB_CHAINS: ReadonlyArray<{ chain: readonly string[]; carry: readonly string[] }> = [
  { chain: ["LEFT_SHOULDER", "LEFT_ELBOW", "LEFT_WRIST"], carry: ["LEFT_INDEX", "LEFT_PINKY", "LEFT_THUMB"] },
  { chain: ["RIGHT_SHOULDER", "RIGHT_ELBOW", "RIGHT_WRIST"], carry: ["RIGHT_INDEX", "RIGHT_PINKY", "RIGHT_THUMB"] },
  { chain: ["LEFT_HIP", "LEFT_KNEE", "LEFT_ANKLE"], carry: ["LEFT_HEEL", "LEFT_FOOT_INDEX"] },
  { chain: ["RIGHT_HIP", "RIGHT_KNEE", "RIGHT_ANKLE"], carry: ["RIGHT_HEEL", "RIGHT_FOOT_INDEX"] },
];

/** A bone may foreshorten to this fraction of the athlete's typical length before it is restored. */
const LIMB_MIN_LENGTH = 0.75;
/** Percentile of the athlete's own bone lengths taken as its full, unforeshortened length. */
const LIMB_REFERENCE_PERCENTILE = 0.8;

/**
 * Lengthen limb bones that have collapsed, keeping each bone's direction.
 *
 * Blending moves every joint in a straight line from the athlete's position toward the pro's.
 * Between two differently rotated arms that line cuts across the arc, so the blended bone comes
 * out shorter than either input: on one forehand volley the free forearm measured 0.054 (athlete)
 * and 0.055 (pro) but 0.028 blended, and Fun Control drew it as a stump or left it out. The pose
 * tracker adds to it by parking a hidden wrist almost on the elbow at low confidence.
 *
 * Reference length per bone is a high percentile of the athlete's own lengths over the window,
 * since 2D projection only ever shortens a bone. A bone shorter than `LIMB_MIN_LENGTH` of that is
 * extended along its direction, and every joint further down the chain moves with it.
 */
export function restoreLimbLengths(
  frames: NamedLandmarks[],
  reference: NamedLandmarks[],
  aspect = 1
): NamedLandmarks[] {
  const a = aspect > 0 ? aspect : 1;
  const boneLen = (lm: NamedLandmarks, p: string, c: string): number | null => {
    const P = lm[p];
    const C = lm[c];
    if (!isVisible(P) || !isVisible(C)) return null;
    return Math.hypot((C.x - P.x) * a, C.y - P.y);
  };
  const percentile = (xs: number[], q: number): number | null => {
    const v = xs.filter((n) => Number.isFinite(n) && n > 0).sort((x, y) => x - y);
    if (!v.length) return null;
    return v[Math.min(v.length - 1, Math.floor(q * (v.length - 1) + 0.5))]!;
  };
  const refs = LIMB_CHAINS.map(({ chain }) =>
    chain.slice(1).map((c, k) =>
      percentile(
        reference.map((lm) => boneLen(lm, chain[k]!, c)).filter((n): n is number => n != null),
        LIMB_REFERENCE_PERCENTILE
      )
    )
  );
  return frames.map((frame) => {
    const out: NamedLandmarks = { ...frame };
    LIMB_CHAINS.forEach(({ chain, carry }, ci) => {
      for (let k = 1; k < chain.length; k++) {
        const parent = out[chain[k - 1]!];
        const child = out[chain[k]!];
        const ref = refs[ci]![k - 1];
        if (!isVisible(parent) || !isVisible(child) || ref == null) continue;
        const dx = (child.x - parent.x) * a;
        const dy = child.y - parent.y;
        const len = Math.hypot(dx, dy);
        const min = ref * LIMB_MIN_LENGTH;
        if (len >= min || len < 1e-6) continue;
        const k2 = min / len;
        const shiftX = (dx * k2 - dx) / a;
        const shiftY = dy * k2 - dy;
        // Move this joint and everything hanging off it by the same amount.
        for (const name of [...chain.slice(k), ...carry]) {
          const lm = out[name];
          if (!lm) continue;
          out[name] = { ...lm, x: lm.x + shiftX, y: lm.y + shiftY };
        }
      }
    });
    return out;
  });
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

/** Region of the source frame, in source pixels, that the start image and control clip share. */
export type ControlCrop = { x: number; y: number; w: number; h: number };

/**
 * Largest rectangle at the canvas aspect, centred on the user's median hip across the window
 * and clamped inside the source. Fun Control center-crops `ref_image` to the canvas on its own,
 * while the skeleton used to be stretched over the whole frame, so on a portrait clip the two
 * disagreed on the player's size. Cropping here, once, gives both inputs the same frame and
 * leaves ComfyUI's resize nothing to change. One crop per request: no per-frame pan.
 */
export function pickControlCrop(opts: {
  srcW: number;
  srcH: number;
  canvasW: number;
  canvasH: number;
  userFrames: NamedLandmarks[];
}): ControlCrop {
  const { srcW, srcH } = opts;
  const aspect = opts.canvasW / opts.canvasH;
  let w = srcW;
  let h = srcW / aspect;
  if (h > srcH) {
    h = srcH;
    w = srcH * aspect;
  }
  w = Math.round(w);
  h = Math.round(h);

  if (correctionCropMode() === "player") {
    const fit = playerCrop(opts, w, h, aspect);
    if (fit) return fit;
  }

  const hipXs: number[] = [];
  const hipYs: number[] = [];
  for (const lm of opts.userFrames) {
    const hip = midpoint(lm.LEFT_HIP, lm.RIGHT_HIP);
    if (!hip) continue;
    hipXs.push(hip.x);
    hipYs.push(hip.y);
  }
  // `median` drops non-positive values, which are off-frame for hips anyway.
  const cx = (median(hipXs) ?? 0.5) * srcW;
  const cy = (median(hipYs) ?? 0.5) * srcH;
  const x = Math.round(Math.max(0, Math.min(srcW - w, cx - w / 2)));
  const y = Math.round(Math.max(0, Math.min(srcH - h, cy - h / 2)));
  return { x, y, w, h };
}

/**
 * `frame` (default) keeps the largest crop; `player` zooms to the athlete. With the whole frame,
 * a player standing at the net can fill under half the canvas height, which leaves each hand
 * about 12 px on a 768 canvas: under the model's 16 px patch, so it draws fists and stumps.
 */
export function correctionCropMode(): "frame" | "player" {
  return String(process.env.CORRECTION_CROP ?? "").trim().toLowerCase() === "player" ? "player" : "frame";
}

/** Margin around the athlete's extent, as a fraction of its height: room for the racket head. */
const PLAYER_CROP_PAD = 0.2;
/** Smallest player crop, as a fraction of the full crop's side, so a far-away player is not upscaled into mush. */
const PLAYER_CROP_MIN = 0.4;

/**
 * Crop at the canvas aspect around everything the athlete reaches over the window: every visible
 * landmark on every frame (hands included), padded for the racket. One crop for the whole clip,
 * so the camera does not move. Null when no landmark is visible.
 */
function playerCrop(
  opts: { srcW: number; srcH: number; userFrames: NamedLandmarks[] },
  maxW: number,
  maxH: number,
  aspect: number
): ControlCrop | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const lm of opts.userFrames) {
    for (const p of Object.values(lm)) {
      if (!isVisible(p) || p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) continue;
      x0 = Math.min(x0, p.x * opts.srcW);
      x1 = Math.max(x1, p.x * opts.srcW);
      y0 = Math.min(y0, p.y * opts.srcH);
      y1 = Math.max(y1, p.y * opts.srcH);
    }
  }
  if (!Number.isFinite(x0)) return null;
  const pad = (y1 - y0) * PLAYER_CROP_PAD;
  const needW = x1 - x0 + 2 * pad;
  const needH = y1 - y0 + 2 * pad;
  let h = Math.max(needH, needW / aspect, maxH * PLAYER_CROP_MIN);
  let w = h * aspect;
  if (w > maxW || h > maxH) {
    w = maxW;
    h = maxH;
  }
  w = Math.round(w);
  h = Math.round(h);
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const x = Math.round(Math.max(0, Math.min(opts.srcW - w, cx - w / 2)));
  const y = Math.round(Math.max(0, Math.min(opts.srcH - h, cy - h / 2)));
  return { x, y, w, h };
}

/** Normalized source point to normalized canvas point through `crop`. Off-crop values are kept. */
export function frameToCanvas(
  lm: NamedLandmark,
  crop: ControlCrop,
  srcW: number,
  srcH: number
): NamedLandmark {
  return {
    ...lm,
    x: (lm.x * srcW - crop.x) / crop.w,
    y: (lm.y * srcH - crop.y) / crop.h,
  };
}

export function framesToCanvas(
  frames: NamedLandmarks[],
  crop: ControlCrop,
  srcW: number,
  srcH: number
): NamedLandmarks[] {
  return frames.map((frame) => {
    const out: NamedLandmarks = {};
    for (const [name, lm] of Object.entries(frame)) {
      if (!lm || typeof lm.x !== "number" || typeof lm.y !== "number") continue;
      out[name] = frameToCanvas(lm, crop, srcW, srcH);
    }
    return out;
  });
}

/** YOLO box in normalized source coordinates to normalized canvas coordinates. */
export function boxToCanvas(
  box: NormBox,
  crop: ControlCrop,
  srcW: number,
  srcH: number
): NormBox {
  return [
    (box[0] * srcW - crop.x) / crop.w,
    (box[1] * srcH - crop.y) / crop.h,
    (box[2] * srcW - crop.x) / crop.w,
    (box[3] * srcH - crop.y) / crop.h,
  ];
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
