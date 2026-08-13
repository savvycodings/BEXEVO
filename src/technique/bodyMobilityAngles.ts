/**
 * Server-side MediaPipe joint angles for body-mobility gauges (You vs Ideal).
 * Mirrors app/src/lib/bodyMobility.ts + poseJointAngles angleDeg.
 */

export type BodySide = "LEFT" | "RIGHT";
export type MobilityJointKey = "head" | "shoulder" | "wrist" | "knee";
export type MobilityStatus = "good" | "okay" | "bad";

export type LandmarkPt = { x: number; y: number; visibility?: number; z?: number };

export type SideMobilityAngles = Record<MobilityJointKey, number | null>;

export type MobilityJointReading = {
  you: number | null;
  ideal: number | null;
  matchPct: number | null;
  status: MobilityStatus | null;
  gaugeDeg: number | null;
};

export type SideMobilityReadings = Record<MobilityJointKey, MobilityJointReading>;

const VIS_MIN = 0.5;
const GAUGE_MAX_DEG = 180;
const GAUGE_SEGMENTS = 5;
const MATCH_REF_DEG = 90;
const GAUGE_ERROR_SCALE = 1;
const JOINT_KEYS: MobilityJointKey[] = ["head", "shoulder", "wrist", "knee"];

/** Left→right wedge colors matching design per joint. */
export const GAUGE_SEGMENT_COLORS_BY_JOINT: Record<
  MobilityJointKey,
  readonly [string, string, string, string, string]
> = {
  head: ["#FF0000", "#FFDD00", "#00FFA6", "#FFDD00", "#FF0000"],
  shoulder: ["#FF0000", "#FFDD00", "#00FFA6", "#FFDD00", "#FF0000"],
  wrist: ["#FFDD00", "#00FFA6", "#FFDD00", "#FF0000", "#FF0000"],
  knee: ["#FFDD00", "#00FFA6", "#FFDD00", "#FF0000", "#FF0000"],
};

export const GAUGE_GREEN_CENTER_DEG: Record<MobilityJointKey, number> = {
  head: 90,
  shoulder: 90,
  wrist: 54,
  knee: 54,
};

function clampDeg(n: number): number {
  return Math.max(0, Math.min(GAUGE_MAX_DEG, Math.round(n)));
}

function clampGauge(n: number): number {
  return Math.max(0, Math.min(GAUGE_MAX_DEG, n));
}

function landmarkVisOk(lm: LandmarkPt | undefined): boolean {
  if (!lm || typeof lm.x !== "number" || typeof lm.y !== "number") return false;
  if (!Number.isFinite(lm.x) || !Number.isFinite(lm.y)) return false;
  const v = lm.visibility;
  if (typeof v === "number" && Number.isFinite(v) && v < VIS_MIN) return false;
  return true;
}

function angleDeg(
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number }
): number | null {
  const bax = a.x - b.x;
  const bay = a.y - b.y;
  const bcx = c.x - b.x;
  const bcy = c.y - b.y;
  const denom = Math.hypot(bax, bay) * Math.hypot(bcx, bcy);
  if (denom < 1e-8) return null;
  let cos = (bax * bcx + bay * bcy) / denom;
  cos = Math.max(-1, Math.min(1, cos));
  return (Math.acos(cos) * 180) / Math.PI;
}

function tripleAngle(
  lm: Record<string, LandmarkPt | undefined>,
  a: string,
  b: string,
  c: string
): number | null {
  const pa = lm[a];
  const pb = lm[b];
  const pc = lm[c];
  if (!landmarkVisOk(pa) || !landmarkVisOk(pb) || !landmarkVisOk(pc)) return null;
  const deg = angleDeg(pa!, pb!, pc!);
  if (deg == null || !Number.isFinite(deg)) return null;
  return clampDeg(deg);
}

export function computeSideMobilityAngles(
  landmarks: Record<string, LandmarkPt | undefined> | null | undefined,
  side: BodySide
): SideMobilityAngles {
  const empty: SideMobilityAngles = {
    head: null,
    shoulder: null,
    wrist: null,
    knee: null,
  };
  if (!landmarks) return empty;
  const S = side;
  return {
    head: tripleAngle(landmarks, `${S}_EAR`, "NOSE", `${S}_SHOULDER`),
    shoulder: tripleAngle(landmarks, `${S}_ELBOW`, `${S}_SHOULDER`, `${S}_HIP`),
    wrist: tripleAngle(landmarks, `${S}_ELBOW`, `${S}_WRIST`, `${S}_INDEX`),
    knee: tripleAngle(landmarks, `${S}_HIP`, `${S}_KNEE`, `${S}_ANKLE`),
  };
}

const HEAD_COLLAPSED_MAX_DEG = 12;
const HEAD_USABLE_MIN_DEG = 25;

function isCollapsedHead(deg: number | null): boolean {
  return deg == null || deg <= HEAD_COLLAPSED_MAX_DEG;
}

function isUsableHead(deg: number | null): boolean {
  return deg != null && deg >= HEAD_USABLE_MIN_DEG;
}

/**
 * Far-side EAR–NOSE–SHOULDER often collapses to ~0° in 2D. One head:
 * if exactly one side is collapsed and the other is usable, copy the usable angle.
 */
export function reconcileHeadAngles(
  left: SideMobilityAngles,
  right: SideMobilityAngles
): { left: SideMobilityAngles; right: SideMobilityAngles } {
  const lCollapsed = isCollapsedHead(left.head);
  const rCollapsed = isCollapsedHead(right.head);
  const lUsable = isUsableHead(left.head);
  const rUsable = isUsableHead(right.head);
  if (lCollapsed && rUsable && !rCollapsed) {
    return { left: { ...left, head: right.head }, right };
  }
  if (rCollapsed && lUsable && !lCollapsed) {
    return { left, right: { ...right, head: left.head } };
  }
  return { left, right };
}

export function mobilityMatchPct(you: number | null, ideal: number | null): number | null {
  if (you == null || ideal == null) return null;
  const delta = Math.abs(you - ideal);
  return Math.max(0, Math.min(100, Math.round(100 - (delta / MATCH_REF_DEG) * 100)));
}

export function gaugeDisplayDeg(
  joint: MobilityJointKey,
  you: number | null,
  ideal: number | null
): number | null {
  if (you == null || ideal == null) return null;
  if (!Number.isFinite(you) || !Number.isFinite(ideal)) return null;
  const center = GAUGE_GREEN_CENTER_DEG[joint];
  return clampGauge(center + (you - ideal) * GAUGE_ERROR_SCALE);
}

export function gaugeBinFromDeg(gaugeDeg: number | null): number | null {
  if (gaugeDeg == null || !Number.isFinite(gaugeDeg)) return null;
  const clamped = Math.max(0, Math.min(GAUGE_MAX_DEG - 0.001, gaugeDeg));
  return Math.min(GAUGE_SEGMENTS - 1, Math.floor(clamped / (GAUGE_MAX_DEG / GAUGE_SEGMENTS)));
}

export function statusFromWedgeColor(
  joint: MobilityJointKey,
  bin: number | null
): MobilityStatus | null {
  if (bin == null || bin < 0 || bin > 4) return null;
  const color = GAUGE_SEGMENT_COLORS_BY_JOINT[joint][bin];
  if (color === "#00FFA6") return "good";
  if (color === "#FFDD00") return "okay";
  if (color === "#FF0000") return "bad";
  return null;
}

export function buildJointReading(
  joint: MobilityJointKey,
  you: number | null,
  ideal: number | null
): MobilityJointReading {
  const matchPct = mobilityMatchPct(you, ideal);
  const gaugeDeg = gaugeDisplayDeg(joint, you, ideal);
  const bin = gaugeBinFromDeg(gaugeDeg);
  return {
    you,
    ideal,
    matchPct,
    gaugeDeg,
    status: statusFromWedgeColor(joint, bin),
  };
}

export function buildSideReadings(
  you: SideMobilityAngles,
  ideal: SideMobilityAngles | null
): SideMobilityReadings {
  const out = {} as SideMobilityReadings;
  for (const key of JOINT_KEYS) {
    out[key] = buildJointReading(key, you[key], ideal?.[key] ?? null);
  }
  return out;
}

export function nearestPoseRowByFrame<T extends { frame: number }>(
  rows: T[],
  targetFrame: number
): T | null {
  if (!rows.length) return null;
  let best = rows[0]!;
  let bestD = Math.abs(best.frame - targetFrame);
  for (const row of rows) {
    const d = Math.abs(row.frame - targetFrame);
    if (d < bestD) {
      bestD = d;
      best = row;
    }
  }
  return best;
}

export function midClipFrameIndex(totalFrames: number): number {
  const tf = Math.max(1, totalFrames);
  return Math.floor((tf - 1) / 2);
}
