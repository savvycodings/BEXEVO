import type { TechniqueCorrectionFrameInsight } from "../db/schema";
import type { FrameLandmarks, LandmarkDelta } from "./correctionPrompt";
import type { LabeledPoseFrame } from "./impactPoseContext";
import { MEDIAPIPE_POSE_LANDMARK_NAMES } from "./poseEmbedding";

const PRO_GAP_MIN_SQ = 0.0004;

type GapRow = {
  dist: number;
  name: string;
  axis: "x" | "y";
  coach: string;
};

function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function landmarkHumanLabel(name: string): string {
  return name
    .replace(/^LEFT_/i, "Left ")
    .replace(/^RIGHT_/i, "Right ")
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function proGapCoachingLine(
  name: string,
  axis: "x" | "y",
  userVal: number,
  proVal: number
): string {
  const delta = userVal - proVal;
  if (Math.abs(delta) < 0.008) return "";
  const human = landmarkHumanLabel(name);
  if (axis === "y") {
    if (delta > 0) {
      return `${human} sits lower than the pro — raise it toward the pro position.`;
    }
    return `${human} sits higher than the pro — lower it toward the pro position.`;
  }
  if (delta > 0) {
    return `${human} is farther right than the pro — shift left toward the pro.`;
  }
  return `${human} is farther left than the pro — shift right toward the pro.`;
}

function collectProGapRows(user: FrameLandmarks, pro: FrameLandmarks): GapRow[] {
  const rows: GapRow[] = [];
  for (const name of MEDIAPIPE_POSE_LANDMARK_NAMES) {
    const u = user[name];
    const p = pro[name];
    if (
      !u ||
      !p ||
      typeof u.x !== "number" ||
      typeof u.y !== "number" ||
      typeof p.x !== "number" ||
      typeof p.y !== "number"
    ) {
      continue;
    }
    const dx = u.x - p.x;
    const dy = u.y - p.y;
    const dist = dx * dx + dy * dy;
    if (dist < PRO_GAP_MIN_SQ) continue;
    const axis: "x" | "y" = Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
    const coach =
      proGapCoachingLine(name, axis, axis === "x" ? u.x : u.y, axis === "x" ? p.x : p.y) ||
      `${landmarkHumanLabel(name)}: align toward the pro reference.`;
    rows.push({ dist, name, axis, coach });
  }
  rows.sort((a, b) => b.dist - a.dist);
  return rows;
}

function proMatchPercent(user: FrameLandmarks, pro: FrameLandmarks | null | undefined): number {
  if (!pro) return 55;
  const rows = collectProGapRows(user, pro);
  if (rows.length === 0) return 92;
  const meanSq = rows.reduce((s, r) => s + r.dist, 0) / rows.length;
  const meanDist = Math.sqrt(meanSq);
  return clampPercent(100 - meanDist * 420);
}

function adjustmentNeedPercent(deltas: LandmarkDelta[]): number {
  if (deltas.length === 0) return 12;
  let score = 0;
  for (const d of deltas) {
    score += d.magnitude === "large" ? 28 : d.magnitude === "moderate" ? 16 : 8;
  }
  return clampPercent(Math.min(100, score));
}

function stabilityPercent(lm: FrameLandmarks): number {
  const lh = lm.LEFT_HIP;
  const rh = lm.RIGHT_HIP;
  const ls = lm.LEFT_SHOULDER;
  const rs = lm.RIGHT_SHOULDER;
  const lk = lm.LEFT_KNEE;
  const rk = lm.RIGHT_KNEE;
  if (!lh || !rh || !ls || !rs) return 50;
  const hipW = Math.hypot(lh.x - rh.x, lh.y - rh.y);
  const shoulderW = Math.hypot(ls.x - rs.x, ls.y - rs.y);
  if (hipW < 1e-4) return 50;
  const ratio = shoulderW / hipW;
  let base = clampPercent(70 - Math.abs(ratio - 1.1) * 40);
  if (lk && rk) {
    const kneeW = Math.hypot(lk.x - rk.x, lk.y - rk.y);
    base = clampPercent((base + clampPercent((kneeW / hipW) * 55)) / 2);
  }
  return base;
}

function powerLinePercent(lm: FrameLandmarks, dominantHand?: string): number {
  const rw = lm.RIGHT_WRIST;
  const lw = lm.LEFT_WRIST;
  const rs = lm.RIGHT_SHOULDER;
  const ls = lm.LEFT_SHOULDER;
  if (!rw || !lw || !rs || !ls) return 50;
  const useRight = dominantHand !== "left-handed";
  const wrist = useRight ? rw : lw;
  const shoulder = useRight ? rs : ls;
  const elbow = useRight ? lm.RIGHT_ELBOW : lm.LEFT_ELBOW;
  if (!elbow) return 50;
  const reach = Math.hypot(wrist.x - shoulder.x, wrist.y - shoulder.y);
  const upper = Math.hypot(elbow.x - shoulder.x, elbow.y - shoulder.y);
  const fore = Math.hypot(wrist.x - elbow.x, wrist.y - elbow.y);
  if (upper < 1e-4) return 50;
  const extension = clampPercent((fore / (upper + fore + 1e-6)) * 100);
  return clampPercent((extension + clampPercent(reach * 120)) / 2);
}

function phaseForFrame(
  frame: number,
  impactSequence?: LabeledPoseFrame[] | null
): TechniqueCorrectionFrameInsight["phase"] {
  if (!impactSequence?.length) return "other";
  let best: LabeledPoseFrame | null = null;
  let bestD = Infinity;
  for (const p of impactSequence) {
    const d = Math.abs(p.frame - frame);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  if (!best || bestD > 8) return "other";
  return best.phase;
}

function phasePhrase(phase: TechniqueCorrectionFrameInsight["phase"]): string {
  switch (phase) {
    case "preparation":
      return "preparation phase";
    case "impact":
      return "contact moment";
    case "follow_through":
      return "follow-through";
    default:
      return "this moment in your clip";
  }
}

function buildSummary(
  phase: TechniqueCorrectionFrameInsight["phase"],
  gapRows: GapRow[],
  shotName: string
): string {
  const phaseText = phasePhrase(phase);
  const shot = shotName.trim() && shotName !== "unknown" ? shotName.trim() : "your shot";
  if (gapRows.length === 0) {
    return `This image shows ${phaseText}. Your pose is already close to the pro library reference for ${shot}.`;
  }
  const first = gapRows[0]!.coach.replace(/\.$/, "");
  const second =
    gapRows.length > 1
      ? gapRows[1]!.coach.replace(/\.$/, "")
      : `The corrected image moves you toward the pro match for ${shot}.`;
  return `This image focuses on ${phaseText}. ${first}. ${second}.`;
}

export type BuildCorrectionFrameInsightParams = {
  frame: number;
  imageIndex: number;
  userLandmarks: FrameLandmarks;
  proLandmarks?: FrameLandmarks | null;
  frameDeltas: LandmarkDelta[];
  shotName?: string;
  dominantHand?: string;
  impactPoseSequence?: LabeledPoseFrame[] | null;
};

export function buildCorrectionFrameInsight(
  p: BuildCorrectionFrameInsightParams
): TechniqueCorrectionFrameInsight {
  const gapRows = p.proLandmarks ? collectProGapRows(p.userLandmarks, p.proLandmarks) : [];
  const phase = phaseForFrame(p.frame, p.impactPoseSequence);
  const shotName = p.shotName ?? "your shot";
  const topAdjustments = p.frameDeltas.slice(0, 4).map((d) => ({
    joint: landmarkHumanLabel(d.landmark),
    axis: d.axis,
    direction: d.direction,
  }));

  return {
    frame: p.frame,
    label: `Image ${p.imageIndex}`,
    phase,
    summary: buildSummary(phase, gapRows, shotName),
    focus_joints: gapRows.slice(0, 3).map((r) => landmarkHumanLabel(r.name)),
    stats: {
      pro_match: proMatchPercent(p.userLandmarks, p.proLandmarks),
      adjustment_need: adjustmentNeedPercent(p.frameDeltas),
      stability: stabilityPercent(p.userLandmarks),
      power_line: powerLinePercent(p.userLandmarks, p.dominantHand),
    },
    top_adjustments: topAdjustments.length > 0 ? topAdjustments : undefined,
  };
}

/** Re-label Image 1..N in display order (sorted by frame). */
export function orderFrameInsights(
  insights: TechniqueCorrectionFrameInsight[],
  frameOrder: number[]
): TechniqueCorrectionFrameInsight[] {
  const byFrame = new Map(insights.map((i) => [i.frame, i]));
  return frameOrder.map((frame, idx) => {
    const base = byFrame.get(frame);
    if (!base) {
      return {
        frame,
        label: `Image ${idx + 1}`,
        summary: "Corrected pose for this frame.",
        focus_joints: [],
        stats: {
          pro_match: 50,
          adjustment_need: 50,
          stability: 50,
          power_line: 50,
        },
      };
    }
    return { ...base, label: `Image ${idx + 1}` };
  });
}
