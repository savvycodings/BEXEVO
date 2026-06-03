import {
  resolveImpactFrameIndex,
  type ImpactFrameSource,
} from "./resolveImpactFrame";

export type FrameLandmarks = Record<string, { x: number; y: number }>;

export type ClipMsRange = { startMs: number; endMs: number };

export type LabeledPoseFrame = {
  phase: "preparation" | "impact" | "follow_through";
  frame: number;
  landmarks: FrameLandmarks;
};

/**
 * Client should send duration; if missing or 0, infer wall-clock length from Modal
 * `total_frames` (and optionally max pose frame index) so impact mapping still runs.
 */
export function resolveVideoDurationMsForImpact(
  clientMs: number | undefined,
  totalFrames: number,
  poseData?: Array<{ frame: number }>,
  defaultFps = 30
): number | undefined {
  if (typeof clientMs === "number" && clientMs > 0) {
    return clientMs;
  }
  let lastFrameIdx = totalFrames > 0 ? totalFrames - 1 : 0;
  if (poseData?.length) {
    const maxPose = Math.max(...poseData.map((p) => p.frame), 0);
    lastFrameIdx = Math.max(lastFrameIdx, maxPose);
  }
  if (lastFrameIdx <= 0) return undefined;
  return Math.round(((lastFrameIdx + 1) / defaultFps) * 1000);
}

/** Estimate FPS from Modal output + client-reported duration. */
export function estimateFps(totalFrames: number, videoDurationMs: number): number {
  if (videoDurationMs > 0 && totalFrames > 0) {
    const sec = videoDurationMs / 1000;
    const f = totalFrames / sec;
    if (Number.isFinite(f) && f > 0) return Math.min(120, Math.max(12, f));
  }
  return 30;
}

/** Convert impact time (end of clip = ball impact) to approximate frame index. */
export function impactMsToFrameIndex(impactMs: number, fps: number): number {
  return Math.round((impactMs / 1000) * fps);
}

/**
 * Pick up to three pose samples around the impact frame: best prep (before), closest to impact, first follow-through (after).
 */
export function selectBeforeImpactAfterSequence(
  poseData: Array<{ frame: number; landmarks: FrameLandmarks }>,
  impactFrameIndex: number
): LabeledPoseFrame[] {
  if (!Array.isArray(poseData) || poseData.length === 0) return [];

  const sorted = [...poseData].sort((a, b) => a.frame - b.frame);

  let closest = sorted[0];
  let bestDist = Math.abs(sorted[0].frame - impactFrameIndex);
  for (const p of sorted) {
    const d = Math.abs(p.frame - impactFrameIndex);
    if (d < bestDist) {
      bestDist = d;
      closest = p;
    }
  }

  const before = sorted.filter((p) => p.frame < closest.frame);
  const after = sorted.filter((p) => p.frame > closest.frame);

  const prep = before.length ? before[before.length - 1] : null;
  const fol = after.length ? after[0] : null;

  const out: LabeledPoseFrame[] = [];

  if (prep) {
    out.push({
      phase: "preparation",
      frame: prep.frame,
      landmarks: prep.landmarks,
    });
  }
  out.push({
    phase: "impact",
    frame: closest.frame,
    landmarks: closest.landmarks,
  });
  if (fol) {
    out.push({
      phase: "follow_through",
      frame: fol.frame,
      landmarks: fol.landmarks,
    });
  }

  return out;
}

export function buildImpactPoseSequenceForMetrics(
  poseData: Array<{ frame: number; landmarks: FrameLandmarks }> | undefined,
  totalFrames: number,
  videoDurationMs: number | undefined,
  clips: ClipMsRange[] | undefined,
  impactFrameIndex?: number
): LabeledPoseFrame[] | null {
  if (!poseData?.length || !clips?.length || !videoDurationMs || videoDurationMs <= 0) {
    return null;
  }
  const clip = clips[0]!;
  const fps = estimateFps(totalFrames, videoDurationMs);
  const resolved =
    typeof impactFrameIndex === "number" && Number.isFinite(impactFrameIndex)
      ? Math.max(0, Math.min(totalFrames - 1, Math.round(impactFrameIndex)))
      : impactMsToFrameIndex(clip.endMs, fps);
  return selectBeforeImpactAfterSequence(poseData, resolved);
}

/** Build impact sequence using YOLO/contact-aware frame resolution (after detection summary exists). */
export function applyUserClipImpactToMetrics(
  metrics: {
    pose_data?: Array<{ frame: number; landmarks: FrameLandmarks }>;
    total_frames?: number;
    video_duration_ms?: number;
    detection_summary?: { contact_window_frames?: number[] };
    impact_frame_resolved?: number;
    impact_frame_source?: ImpactFrameSource;
  },
  clips: ClipMsRange[],
  videoDurationMs: number
): {
  impact_pose_sequence: LabeledPoseFrame[] | null;
  impact_frame_resolved: number;
  impact_frame_source: ImpactFrameSource;
} | null {
  if (!metrics.pose_data?.length || !clips.length || videoDurationMs <= 0) {
    return null;
  }
  const totalFrames = metrics.total_frames ?? 0;
  const clip = clips[0]!;
  const resolved = resolveImpactFrameIndex({
    clip,
    totalFrames,
    videoDurationMs,
    contactFrames: metrics.detection_summary?.contact_window_frames,
  });

  const seq = buildImpactPoseSequenceForMetrics(
    metrics.pose_data,
    totalFrames,
    videoDurationMs,
    clips,
    resolved.impactFrameIndex
  );
  return {
    impact_pose_sequence: seq,
    impact_frame_resolved: resolved.impactFrameIndex,
    impact_frame_source: resolved.source,
  };
}
