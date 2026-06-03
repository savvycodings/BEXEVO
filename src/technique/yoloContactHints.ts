import type { TechniqueDetectionSummary } from "../db/schema";
import type { ClipMsRange, LabeledPoseFrame } from "./impactPoseContext";
import { estimateFps, impactMsToFrameIndex } from "./impactPoseContext";

const CLIP_FRAME_PADDING = 15;

export function yoloContactMaxImpactDelta(): number {
  const n = Number(process.env.YOLO_CONTACT_MAX_IMPACT_DELTA ?? 60);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 60;
}

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

/**
 * Keep YOLO ball+racket contact frames inside the user-marked clip and near impact.
 * Returns empty when contacts are misleading (long upload, far from impact).
 */
export function filterContactFramesForUserClip(
  contactFrames: number[],
  opts: {
    totalFrames: number;
    videoDurationMs: number;
    userClips?: ClipMsRange[];
    impactPoseSequence?: LabeledPoseFrame[];
    clipPaddingFrames?: number;
    maxImpactDelta?: number;
  }
): number[] {
  if (!contactFrames.length) return [];
  const tf = Math.max(1, opts.totalFrames);
  const vdur = opts.videoDurationMs;
  if (!vdur || vdur <= 0) return [];

  const padding = opts.clipPaddingFrames ?? CLIP_FRAME_PADDING;
  const fps = estimateFps(tf, vdur);
  const clip = opts.userClips?.[0];
  let inRange = contactFrames;

  if (clip) {
    const { start, end } = clipFrameRange(clip, fps, tf, padding);
    inRange = contactFrames.filter((f) => f >= start && f <= end);
  }

  if (!inRange.length) return [];

  const impactFrame = opts.impactPoseSequence?.find((p) => p.phase === "impact")?.frame;
  if (impactFrame == null) {
    return [...inRange].sort((a, b) => a - b);
  }

  const maxDelta = opts.maxImpactDelta ?? yoloContactMaxImpactDelta();
  const nearImpact = inRange.filter((f) => Math.abs(f - impactFrame) <= maxDelta);
  if (nearImpact.length > 0) {
    return [...nearImpact].sort((a, b) => a - b);
  }

  const minDelta = Math.min(...inRange.map((f) => Math.abs(f - impactFrame)));
  if (minDelta > maxDelta) return [];
  return [...inRange].sort((a, b) => a - b);
}

export function attachClipLocalContactFrames(
  summary: TechniqueDetectionSummary,
  metrics: {
    total_frames?: number;
    video_duration_ms?: number;
    user_clips?: ClipMsRange[];
    impact_pose_sequence?: LabeledPoseFrame[];
  }
): TechniqueDetectionSummary {
  const raw = summary.contact_window_frames ?? [];
  const tf = metrics.total_frames ?? 0;
  const vdur = metrics.video_duration_ms ?? 0;
  if (!raw.length || !tf || !vdur) {
    return { ...summary, contact_window_frames_prompt: undefined };
  }
  const filtered = filterContactFramesForUserClip(raw, {
    totalFrames: tf,
    videoDurationMs: vdur,
    userClips: metrics.user_clips,
    impactPoseSequence: metrics.impact_pose_sequence,
  });
  return {
    ...summary,
    contact_window_frames_prompt: filtered.length > 0 ? filtered : undefined,
  };
}

/** Prompt-safe contacts: clip-local field when present, else raw (short clips). */
export function contactFramesForPrompt(
  summary: TechniqueDetectionSummary | null | undefined
): number[] | undefined {
  if (!summary) return undefined;
  if (Array.isArray(summary.contact_window_frames_prompt)) {
    return summary.contact_window_frames_prompt.length > 0
      ? summary.contact_window_frames_prompt
      : undefined;
  }
  return summary.contact_window_frames;
}
