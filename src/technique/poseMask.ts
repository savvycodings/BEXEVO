import sharp from "sharp";
import type { FrameLandmarks } from "./correctionPrompt";

/**
 * Builds a soft-edged player mask PNG suitable for ComfyUI inpainting.
 *
 * Algorithm:
 *   1. Project all landmarks to pixel space (`width` × `height`).
 *   2. Compute the 2-D convex hull (Andrew's monotone chain).
 *   3. Dilate the hull outward by ~`dilatePct` of the larger image dimension
 *      so racket, hair, and extended limbs are not clipped.
 *   4. Rasterize the hull as a white SVG polygon on a black background via Sharp.
 *   5. Apply Gaussian blur for soft mask edges (less seam-y blending).
 *
 * Returns a single-channel PNG buffer (grayscale, white = "regenerate this area",
 * black = "preserve from source"). Downstream the Comfy graph extracts this as
 * a MASK and feeds `SetLatentNoiseMask`.
 */
export interface BuildPoseMaskOptions {
  /** Target mask PNG dimensions. Should match the upscaled player frame's pixel size. */
  width: number;
  height: number;
  /**
   * Hull dilation as a fraction of `max(width, height)`. 0.12 ≈ 12% covers
   * hair/racket/extended arms while still leaving the court visible.
   */
  dilatePct?: number;
  /** Edge blur radius in pixels. 0 = hard edge; 8 = soft. */
  blurSigma?: number;
}

interface Pt {
  x: number;
  y: number;
}

function landmarksToPoints(
  landmarks: FrameLandmarks,
  width: number,
  height: number
): Pt[] {
  const out: Pt[] = [];
  for (const key of Object.keys(landmarks)) {
    const lm = landmarks[key];
    if (!lm || typeof lm.x !== "number" || typeof lm.y !== "number") continue;
    // Clamp to canvas; out-of-frame landmarks happen near phone-tilted clips.
    const px = Math.max(0, Math.min(width, lm.x * width));
    const py = Math.max(0, Math.min(height, lm.y * height));
    out.push({ x: px, y: py });
  }
  return out;
}

/** Andrew's monotone chain convex hull. O(n log n). */
function convexHull(points: Pt[]): Pt[] {
  if (points.length < 3) return points.slice();
  const sorted = points.slice().sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  const cross = (o: Pt, a: Pt, b: Pt): number =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const lower: Pt[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/**
 * Dilates a polygon outward from its centroid.
 * Cheap and good enough for player-silhouette masks where we want a buffer
 * around the hull rather than a precise offset polygon.
 */
function dilateHull(hull: Pt[], pixels: number): Pt[] {
  if (hull.length === 0) return hull;
  const cx = hull.reduce((s, p) => s + p.x, 0) / hull.length;
  const cy = hull.reduce((s, p) => s + p.y, 0) / hull.length;
  return hull.map((p) => {
    const dx = p.x - cx;
    const dy = p.y - cy;
    const len = Math.hypot(dx, dy) || 1;
    return {
      x: p.x + (dx / len) * pixels,
      y: p.y + (dy / len) * pixels,
    };
  });
}

export async function buildPoseMaskPng(
  landmarks: FrameLandmarks,
  options: BuildPoseMaskOptions
): Promise<Buffer> {
  const width = Math.max(64, Math.round(options.width));
  const height = Math.max(64, Math.round(options.height));
  const dilatePct = options.dilatePct ?? 0.12;
  const blurSigma = options.blurSigma ?? 6;

  const points = landmarksToPoints(landmarks, width, height);
  let hull = convexHull(points);

  // Fallback: if we have <3 landmarks, mask the full frame (== no mask effect, but won't crash).
  if (hull.length < 3) {
    hull = [
      { x: 0, y: 0 },
      { x: width, y: 0 },
      { x: width, y: height },
      { x: 0, y: height },
    ];
  } else {
    const dilatePx = Math.max(width, height) * dilatePct;
    hull = dilateHull(hull, dilatePx);
    // Re-clamp post-dilation.
    hull = hull.map((p) => ({
      x: Math.max(0, Math.min(width, p.x)),
      y: Math.max(0, Math.min(height, p.y)),
    }));
  }

  const polygonPoints = hull.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="black"/>
  <polygon points="${polygonPoints}" fill="white"/>
</svg>`;

  let pipeline = sharp(Buffer.from(svg)).resize(width, height, { fit: "fill" });
  if (blurSigma > 0) pipeline = pipeline.blur(blurSigma);
  return pipeline.grayscale().png().toBuffer();
}

/**
 * Reads image dimensions without decoding the full pixel buffer.
 * Used by `comfyCorrection.ts` so we can build a mask that matches the
 * uploaded player frame's aspect ratio.
 */
export async function readImageDimensions(
  buf: Buffer
): Promise<{ width: number; height: number }> {
  const meta = await sharp(buf).metadata();
  const w = typeof meta.width === "number" ? meta.width : 0;
  const h = typeof meta.height === "number" ? meta.height : 0;
  if (w <= 0 || h <= 0) {
    throw new Error("[poseMask] sharp.metadata returned no dimensions");
  }
  return { width: w, height: h };
}
