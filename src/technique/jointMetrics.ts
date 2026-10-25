/**
 * Contact-frame joint angles for the Smart 3D joint views: the player vs the matched pro at
 * ball contact, on the racket side. MediaPipe landmark names (LEFT_ELBOW, ...), image-plane angles.
 */

export type ContactJoint = "shoulder" | "elbow" | "wrist" | "torso" | "knee";
export type JointSide = "LEFT" | "RIGHT";
export type JointStatus = "good" | "warn" | "bad";

/** Which way the player is off from the pro; the app turns `joints.<joint>.<direction>` into a sentence. */
export type JointDirection =
  | "match"
  | "more_flexed"
  | "more_extended"
  | "arm_lower"
  | "arm_higher"
  | "leaning_more"
  | "more_upright";

export type LandmarkPt = { x: number; y: number; visibility?: number };
export type Landmarks = Record<string, LandmarkPt | undefined>;

export type JointReading = {
  /** Player's angle at contact, degrees. */
  you: number | null;
  /** Pro's angle at their contact, degrees. */
  pro: number | null;
  idealMin: number | null;
  idealMax: number | null;
  /** you - pro; negative = smaller angle than the pro. */
  deltaDeg: number | null;
  status: JointStatus | null;
  direction: JointDirection | null;
  messageKey: string | null;
};

export const CONTACT_JOINTS: ContactJoint[] = ["shoulder", "elbow", "wrist", "torso", "knee"];

/** Within this many degrees of the pro counts as matching; twice it is a warning, beyond is bad. */
export const JOINT_TOLERANCE_DEG: Record<ContactJoint, number> = {
  shoulder: 10,
  elbow: 8,
  wrist: 10,
  torso: 6,
  knee: 8,
};

const VIS_MIN = 0.5;

/** Pro angle ± tolerance, kept inside 0..180. */
function idealRange(joint: ContactJoint, pro: number): { idealMin: number; idealMax: number } {
  const tol = JOINT_TOLERANCE_DEG[joint];
  return { idealMin: Math.max(0, pro - tol), idealMax: Math.min(180, pro + tol) };
}

function usable(p: LandmarkPt | undefined): p is LandmarkPt {
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return false;
  return typeof p.visibility !== "number" || p.visibility >= VIS_MIN;
}

/** Interior angle at b, degrees. */
function angleAt(a: LandmarkPt, b: LandmarkPt, c: LandmarkPt): number | null {
  const bax = a.x - b.x;
  const bay = a.y - b.y;
  const bcx = c.x - b.x;
  const bcy = c.y - b.y;
  const denom = Math.hypot(bax, bay) * Math.hypot(bcx, bcy);
  if (denom < 1e-8) return null;
  const cos = Math.max(-1, Math.min(1, (bax * bcx + bay * bcy) / denom));
  return (Math.acos(cos) * 180) / Math.PI;
}

function triple(lm: Landmarks, a: string, b: string, c: string): number | null {
  const pa = lm[a];
  const pb = lm[b];
  const pc = lm[c];
  if (!usable(pa) || !usable(pb) || !usable(pc)) return null;
  const deg = angleAt(pa, pb, pc);
  return deg == null ? null : Math.round(deg);
}

function midpoint(a: LandmarkPt | undefined, b: LandmarkPt | undefined): LandmarkPt | null {
  if (!usable(a) || !usable(b)) return null;
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** Trunk lean from vertical (0 = upright), hips to shoulders; image y grows downward. */
function trunkLean(lm: Landmarks): number | null {
  const hips = midpoint(lm.LEFT_HIP, lm.RIGHT_HIP);
  const shoulders = midpoint(lm.LEFT_SHOULDER, lm.RIGHT_SHOULDER);
  if (!hips || !shoulders) return null;
  const dx = shoulders.x - hips.x;
  const up = hips.y - shoulders.y;
  if (Math.hypot(dx, up) < 1e-8) return null;
  return Math.round((Math.atan2(Math.abs(dx), up) * 180) / Math.PI);
}

export function contactJointAngles(
  lm: Landmarks | null | undefined,
  side: JointSide
): Record<ContactJoint, number | null> {
  if (!lm) return { shoulder: null, elbow: null, wrist: null, torso: null, knee: null };
  const S = side;
  return {
    shoulder: triple(lm, `${S}_ELBOW`, `${S}_SHOULDER`, `${S}_HIP`),
    elbow: triple(lm, `${S}_SHOULDER`, `${S}_ELBOW`, `${S}_WRIST`),
    wrist: triple(lm, `${S}_ELBOW`, `${S}_WRIST`, `${S}_INDEX`),
    torso: trunkLean(lm),
    knee: triple(lm, `${S}_HIP`, `${S}_KNEE`, `${S}_ANKLE`),
  };
}

function directionFor(joint: ContactJoint, delta: number): JointDirection {
  switch (joint) {
    case "shoulder":
      return delta < 0 ? "arm_lower" : "arm_higher";
    case "torso":
      return delta > 0 ? "leaning_more" : "more_upright";
    default:
      // A smaller hinge angle is a more bent joint.
      return delta < 0 ? "more_flexed" : "more_extended";
  }
}

export function buildJointReading(joint: ContactJoint, you: number | null, pro: number | null): JointReading {
  const tol = JOINT_TOLERANCE_DEG[joint];
  if (you == null || pro == null) {
    return {
      you,
      pro,
      ...(pro == null ? { idealMin: null, idealMax: null } : idealRange(joint, pro)),
      deltaDeg: null,
      status: null,
      direction: null,
      messageKey: null,
    };
  }
  const delta = you - pro;
  const abs = Math.abs(delta);
  const status: JointStatus = abs <= tol ? "good" : abs <= tol * 2 ? "warn" : "bad";
  const direction: JointDirection = status === "good" ? "match" : directionFor(joint, delta);
  return {
    you,
    pro,
    ...idealRange(joint, pro),
    deltaDeg: delta,
    status,
    direction,
    messageKey: `joints.${joint}.${direction}`,
  };
}

export function buildContactJointReadings(
  you: Landmarks | null | undefined,
  pro: Landmarks | null | undefined,
  side: JointSide
): Record<ContactJoint, JointReading> {
  const y = contactJointAngles(you, side);
  const p = contactJointAngles(pro, side);
  return Object.fromEntries(
    CONTACT_JOINTS.map((j) => [j, buildJointReading(j, y[j], p[j])])
  ) as Record<ContactJoint, JointReading>;
}

/** Pose row at or nearest to `frame`. */
export function nearestByFrame<T>(rows: T[], frame: number, frameOf: (row: T) => number): T | null {
  let best: T | null = null;
  let bestDist = Infinity;
  for (const row of rows) {
    const d = Math.abs(frameOf(row) - frame);
    if (d < bestDist) {
      best = row;
      bestDist = d;
    }
  }
  return best;
}
