import type { ClipMsRange } from "./impactPoseContext";
import { estimateFps, impactMsToFrameIndex } from "./impactPoseContext";

const CLIP_FRAME_PADDING = 15;
const FULL_CLIP_SPAN_RATIO = 0.85;
const NARROW_CLIP_SPAN_RATIO = 0.7;

export type ImpactFrameSource =
  | "yolo_median"
  | "yolo_global_median"
  | "clip_center"
  | "clip_end";

export type ResolveImpactFrameResult = {
  impactFrameIndex: number;
  impactMs: number;
  source: ImpactFrameSource;
};

export type ResolveImpactFrameOpts = {
  clip: ClipMsRange;
  totalFrames: number;
  videoDurationMs: number;
  contactFrames?: number[];
  clipPaddingFrames?: number;
};

function clipFrameRange(
  clip: ClipMsRange,
  fps: number,
  totalFrames: number,
  padding: number
): { start: number; end: number } {
  const start = Math.max(0, impactMsToFrameIndex(clip.startMs, fps) - padding);
  const end = Math.min(
    Math.max(0, totalFrames - 1),
    impactMsToFrameIndex(clip.endMs, fps) + padding
  );
  return { start, end };
}

function medianFrame(frames: number[]): number {
  const sorted = [...frames].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

function contactsInClipRange(
  contactFrames: number[],
  clip: ClipMsRange,
  fps: number,
  totalFrames: number,
  padding: number
): number[] {
  const { start, end } = clipFrameRange(clip, fps, totalFrames, padding);
  return contactFrames.filter((f) => f >= start && f <= end);
}

function frameToMs(frame: number, fps: number): number {
  return Math.round((frame / fps) * 1000);
}

/**
 * Resolve ball-impact frame for retrieval / impact_pose_sequence.
 * Prefers YOLO contact inside clip; avoids using clip.endMs when it disagrees with contacts.
 */
export function resolveImpactFrameIndex(
  opts: ResolveImpactFrameOpts
): ResolveImpactFrameResult {
  const { clip, totalFrames, videoDurationMs } = opts;
  const fps = estimateFps(totalFrames, videoDurationMs);
  const padding = opts.clipPaddingFrames ?? CLIP_FRAME_PADDING;
  const clipEndFrame = impactMsToFrameIndex(clip.endMs, fps);
  const clipSpanMs = clip.endMs - clip.startMs;
  const spanRatio = clipSpanMs / Math.max(1, videoDurationMs);

  const rawContacts = (opts.contactFrames ?? [])
    .map((f) => Math.round(f))
    .filter((f) => Number.isFinite(f) && f >= 0 && f < totalFrames);

  const inClip = contactsInClipRange(rawContacts, clip, fps, totalFrames, padding);

  if (inClip.length > 0) {
    const frame = medianFrame(inClip);
    return {
      impactFrameIndex: frame,
      impactMs: frameToMs(frame, fps),
      source: "yolo_median",
    };
  }

  if (
    rawContacts.length > 0 &&
    spanRatio >= FULL_CLIP_SPAN_RATIO
  ) {
    const frame = medianFrame(rawContacts);
    return {
      impactFrameIndex: frame,
      impactMs: frameToMs(frame, fps),
      source: "yolo_global_median",
    };
  }

  if (spanRatio < NARROW_CLIP_SPAN_RATIO) {
    const centerMs = Math.round((clip.startMs + clip.endMs) / 2);
    const frame = impactMsToFrameIndex(centerMs, fps);
    return {
      impactFrameIndex: frame,
      impactMs: centerMs,
      source: "clip_center",
    };
  }

  return {
    impactFrameIndex: clipEndFrame,
    impactMs: clip.endMs,
    source: "clip_end",
  };
}
