import type { ClipMsRange, FrameLandmarks } from "./impactPoseContext";
import { estimateFps, impactMsToFrameIndex } from "./impactPoseContext";

const CLIP_FRAME_PADDING = 15;
const FULL_CLIP_SPAN_RATIO = 0.85;
const NARROW_CLIP_SPAN_RATIO = 0.7;
/** Contacts further apart than this start a new run (YOLO can skip a frame or two mid-hit). */
const CONTACT_RUN_MAX_GAP = 3;

export type ImpactFrameSource =
  | "user_marked"
  | "yolo_cluster"
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
  /** Ball contact the user marked in the app; wins over every detector. */
  userContactMs?: number;
  /** Used to pick the contact run nearest the wrist speed peak. */
  poseData?: Array<{ frame: number; landmarks: FrameLandmarks }>;
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

/** Sorted, de-duplicated contacts split into runs of nearby frames. */
export function contactRuns(frames: number[], maxGap = CONTACT_RUN_MAX_GAP): number[][] {
  const sorted = [...new Set(frames)].sort((a, b) => a - b);
  const runs: number[][] = [];
  for (const f of sorted) {
    const last = runs[runs.length - 1];
    if (last && f - last[last.length - 1]! <= maxGap) last.push(f);
    else runs.push([f]);
  }
  return runs;
}

const WRIST_KEYS = ["LEFT_WRIST", "RIGHT_WRIST"] as const;

/**
 * Frame of peak wrist speed (faster of the two wrists, 3-frame smoothed) inside [start, end].
 * Returns null when there is not enough pose data to tell.
 */
export function wristSpeedPeakFrame(
  poseData: Array<{ frame: number; landmarks: FrameLandmarks }>,
  start: number,
  end: number
): number | null {
  const byFrame = new Map<number, FrameLandmarks>();
  for (const p of poseData) {
    if (p.frame >= start - 1 && p.frame <= end + 1) byFrame.set(p.frame, p.landmarks);
  }
  const speeds = new Map<number, number>();
  for (let f = start; f <= end; f++) {
    const a = byFrame.get(f - 1);
    const b = byFrame.get(f);
    if (!a || !b) continue;
    let best = 0;
    for (const k of WRIST_KEYS) {
      const pa = a[k];
      const pb = b[k];
      if (!pa || !pb) continue;
      best = Math.max(best, Math.hypot(pb.x - pa.x, pb.y - pa.y));
    }
    speeds.set(f, best);
  }
  if (speeds.size < 5) return null;
  let peak: number | null = null;
  let peakSpeed = 0;
  for (const f of speeds.keys()) {
    let sum = 0;
    let n = 0;
    for (let d = -1; d <= 1; d++) {
      const s = speeds.get(f + d);
      if (s != null) {
        sum += s;
        n++;
      }
    }
    const smoothed = sum / n;
    if (smoothed > peakSpeed) {
      peakSpeed = smoothed;
      peak = f;
    }
  }
  return peakSpeed > 0 ? peak : null;
}

/**
 * Pick the contact frame from YOLO ball+racket frames. A ball is often visible next to the racket
 * well before the hit, so the median of all contacts can land in the backswing. Prefer the run
 * nearest the wrist speed peak; without pose data, the last run (the ball leaves fast after impact).
 */
function pickContactFromRuns(
  contacts: number[],
  poseData: ResolveImpactFrameOpts["poseData"],
  range: { start: number; end: number }
): number {
  const runs = contactRuns(contacts);
  const peak = poseData?.length ? wristSpeedPeakFrame(poseData, range.start, range.end) : null;
  if (peak == null) return medianFrame(runs[runs.length - 1]!);
  let bestRun = runs[0]!;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const run of runs) {
    const lo = run[0]!;
    const hi = run[run.length - 1]!;
    const dist = peak < lo ? lo - peak : peak > hi ? peak - hi : 0;
    if (dist <= bestDist) {
      bestDist = dist;
      bestRun = run;
    }
  }
  const lo = bestRun[0]!;
  const hi = bestRun[bestRun.length - 1]!;
  return Math.max(lo, Math.min(hi, peak));
}

/**
 * Resolve ball-impact frame for retrieval / impact_pose_sequence.
 * User-marked contact wins; then YOLO contact runs inside the clip; avoids using clip.endMs when it disagrees with contacts.
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

  const userMs = opts.userContactMs;
  if (typeof userMs === "number" && Number.isFinite(userMs) && userMs >= 0 && userMs <= videoDurationMs) {
    const frame = Math.max(0, Math.min(Math.max(0, totalFrames - 1), impactMsToFrameIndex(userMs, fps)));
    return { impactFrameIndex: frame, impactMs: Math.round(userMs), source: "user_marked" };
  }

  const rawContacts = (opts.contactFrames ?? [])
    .map((f) => Math.round(f))
    .filter((f) => Number.isFinite(f) && f >= 0 && f < totalFrames);

  const inClip = contactsInClipRange(rawContacts, clip, fps, totalFrames, padding);

  if (inClip.length > 0) {
    const frame = pickContactFromRuns(
      inClip,
      opts.poseData,
      clipFrameRange(clip, fps, totalFrames, padding)
    );
    return {
      impactFrameIndex: frame,
      impactMs: frameToMs(frame, fps),
      source: "yolo_cluster",
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

  // Contacts exist but none land inside the user clip → clip midpoint is safer than
  // clip.endMs (which may be far from the actual hit when YOLO fired elsewhere).
  // When YOLO saw NO ball at all, prefer clip.endMs: the UI marks the hit at endMs.
  if (rawContacts.length > 0 && spanRatio < NARROW_CLIP_SPAN_RATIO) {
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
