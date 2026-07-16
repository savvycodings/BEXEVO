/**
 * Independent forehand/backhand (racket-side) signal from pose geometry.
 *
 * The pose/mesh k-NN embeddings do NOT reliably encode which side of the body the racket
 * arm swings on (no mirror/facing canonicalization, depth is dropped, and the mesh channel
 * is currently a proxy of the same landmarks). So a backhand routinely lands in a forehand
 * neighborhood. This module derives forehand-vs-backhand directly from the racket-hand wrist
 * path around impact, anchored on a KNOWN dominant hand (user profile first, racket-detection
 * consensus as fallback). It is used only as a family tie-break between forehand- and
 * backhand-labeled neighbors when the retrieval vote is close, and it deliberately abstains
 * (low confidence) when the pose is degenerate (tiny/side-on figure), so it never fabricates
 * a side from unreliable tracking.
 *
 * Body-relative convention: for the dominant shoulder we compute
 *   offset = (wrist.x - shoulderCenterX) * sign(dominantShoulder.x - shoulderCenterX)
 * which is POSITIVE when the racket hand is on the player's dominant side and NEGATIVE when it
 * has crossed to the non-dominant side — independent of whether the camera is in front of or
 * behind the player. Around impact the racket hand sits on the DOMINANT side for a BACKHAND
 * (the arm extends out to the dominant side through contact) and crosses toward center / the
 * non-dominant side for a FOREHAND. So offset > 0 → backhand, offset < 0 → forehand. This
 * convention was validated against labeled clips (both known backhands and forehands).
 */

import type { TechniqueRetrievalResult } from "../db/schema";

export type SideFrameLandmarks = Record<
  string,
  { x: number; y: number; visibility?: number }
>;

export type StrokeSideFrame = {
  frame: number;
  phase?: "preparation" | "impact" | "follow_through";
  landmarks: SideFrameLandmarks;
};

export type DominantHand = "left" | "right" | null;

export type StrokeSideSignal = {
  available: boolean;
  /** Trustworthy enough to act on (good pose scale + clear, consistent offset). */
  confident: boolean;
  side: "forehand" | "backhand" | null;
  /** 0..1 strength of the side cue. */
  score: number;
  dominant_hand: DominantHand;
  dominant_hand_source: "profile" | "racket_consensus" | "geometry" | null;
  facing: "front" | "behind" | "ambiguous";
  /** Mean body-relative wrist offset during the backswing (dominant-side positive). */
  prep_offset: number;
  /** Mean body-relative wrist offset during the follow-through. */
  follow_offset: number;
  frames_used: number;
};

function envNum(name: string, def: number): number {
  const raw = (process.env[name] ?? "").trim();
  if (raw === "") return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** Minimum shoulder width (fraction of frame) for facing to be trustworthy; below = side-on. */
const MIN_SHOULDER_WIDTH = () => envNum("STROKE_SIDE_MIN_SHOULDER_WIDTH", 0.06);
/** Normalized |prep offset| that maps to full score. */
const OFFSET_SCALE = () => envNum("STROKE_SIDE_OFFSET_SCALE", 0.5);
/** Minimum score to be considered confident. */
const MIN_SCORE = () => envNum("STROKE_SIDE_MIN_SCORE", 0.35);
/** Score at/above which the tie-break may re-rank the family. */
const STRONG = () => envNum("STROKE_SIDE_STRONG", 0.5);
/** A competing-family neighbor may be promoted only if within this cosine window of the top. */
const PROMOTE_WINDOW = () => envNum("STROKE_SIDE_PROMOTE_WINDOW", 0.08);

/**
 * Build the swing window for the side signal. Prefers the dense `pose_data` frames within
 * ±window of impact (fuller backswing→follow-through arc); falls back to the labeled
 * `impact_pose_sequence` (which carries explicit phases but is only ~3 frames).
 */
export function strokeSideFramesFromMetrics(
  metrics: {
    pose_data?: Array<{ frame: number; landmarks: SideFrameLandmarks }> | null;
    impact_pose_sequence?: Array<{
      phase: "preparation" | "impact" | "follow_through";
      frame: number;
      landmarks: SideFrameLandmarks;
    }> | null;
  } | null | undefined,
  impactFrame: number | null,
  window = envNum("STROKE_SIDE_WINDOW", 8)
): StrokeSideFrame[] {
  const pd = Array.isArray(metrics?.pose_data) ? metrics!.pose_data! : [];
  if (pd.length && impactFrame != null && Number.isFinite(impactFrame)) {
    const w = Math.max(3, Math.floor(window));
    const win = pd
      .filter(
        (p) =>
          p?.landmarks &&
          typeof p.frame === "number" &&
          Math.abs(p.frame - impactFrame) <= w
      )
      .sort((a, b) => a.frame - b.frame)
      .map((p) => ({ frame: p.frame, landmarks: p.landmarks }));
    if (win.length >= 3) return win;
  }

  const seq = Array.isArray(metrics?.impact_pose_sequence)
    ? metrics!.impact_pose_sequence!
    : [];
  if (seq.length) {
    return seq
      .filter((p) => p?.landmarks)
      .map((p) => ({ frame: p.frame, phase: p.phase, landmarks: p.landmarks }));
  }

  if (pd.length) {
    return pd
      .filter((p) => p?.landmarks)
      .sort((a, b) => a.frame - b.frame)
      .map((p) => ({ frame: p.frame, landmarks: p.landmarks }));
  }
  return [];
}

export function profileHandToDominant(raw: string | null | undefined): DominantHand {
  const s = (raw ?? "").toString().trim().toLowerCase();
  if (!s) return null;
  if (s.includes("left")) return "left";
  if (s.includes("right")) return "right";
  return null;
}

function pt(lm: SideFrameLandmarks, name: string): { x: number; y: number } | null {
  const p = lm?.[name];
  if (!p || typeof p.x !== "number" || typeof p.y !== "number") return null;
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
  return { x: p.x, y: p.y };
}

type PerFrame = {
  frame: number;
  phase?: StrokeSideFrame["phase"];
  offset: number;
  shoulderWidth: number;
  facingSign: number;
};

function analyzeFrame(
  f: StrokeSideFrame,
  dominant: Exclude<DominantHand, null>
): PerFrame | null {
  const lm = f.landmarks;
  const ls = pt(lm, "LEFT_SHOULDER");
  const rs = pt(lm, "RIGHT_SHOULDER");
  if (!ls || !rs) return null;

  const lh = pt(lm, "LEFT_HIP");
  const rh = pt(lm, "RIGHT_HIP");

  const centerX = (ls.x + rs.x) / 2;
  const shoulderWidth = Math.abs(ls.x - rs.x);

  const shoulderMidY = (ls.y + rs.y) / 2;
  const hipMidY = lh && rh ? (lh.y + rh.y) / 2 : shoulderMidY + shoulderWidth;
  const torsoLen = Math.abs(hipMidY - shoulderMidY);
  // Horizontal scale that does not blow up on side-on views (small shoulder width).
  const normalizer = Math.max(shoulderWidth, 0.6 * torsoLen, 0.04);

  const domShoulder = dominant === "right" ? rs : ls;
  const domWrist = pt(lm, dominant === "right" ? "RIGHT_WRIST" : "LEFT_WRIST");
  if (!domWrist) return null;

  const facingSign = Math.sign(domShoulder.x - centerX) || 1;
  const offset = ((domWrist.x - centerX) * facingSign) / normalizer;

  return { frame: f.frame, phase: f.phase, offset, shoulderWidth, facingSign };
}

/**
 * Compute the forehand/backhand signal from a swing window (ideally spanning backswing →
 * impact → follow-through). Frames may carry an explicit `phase`; otherwise they are split
 * around `impactFrame`.
 */
export function computeStrokeSideSignal(
  frames: StrokeSideFrame[],
  opts: {
    dominantHand: DominantHand;
    dominantHandSource?: StrokeSideSignal["dominant_hand_source"];
    impactFrame?: number | null;
  }
): StrokeSideSignal {
  const empty: StrokeSideSignal = {
    available: false,
    confident: false,
    side: null,
    score: 0,
    dominant_hand: opts.dominantHand,
    dominant_hand_source: opts.dominantHandSource ?? null,
    facing: "ambiguous",
    prep_offset: 0,
    follow_offset: 0,
    frames_used: 0,
  };

  const dominant = opts.dominantHand;
  if (dominant !== "left" && dominant !== "right") return empty;
  if (!Array.isArray(frames) || frames.length === 0) return empty;

  const analyzed = frames
    .map((f) => analyzeFrame(f, dominant))
    .filter((x): x is PerFrame => x != null);
  if (analyzed.length === 0) return empty;

  const impactFrame =
    typeof opts.impactFrame === "number" && Number.isFinite(opts.impactFrame)
      ? opts.impactFrame
      : null;

  const isPrep = (p: PerFrame) =>
    p.phase === "preparation" ||
    (p.phase == null && impactFrame != null && p.frame < impactFrame);
  const isFollow = (p: PerFrame) =>
    p.phase === "follow_through" ||
    (p.phase == null && impactFrame != null && p.frame > impactFrame);

  let prep = analyzed.filter(isPrep);
  let follow = analyzed.filter(isFollow);
  // Fallbacks when phases/impact are unknown: use first/last thirds by frame order.
  if (prep.length === 0 || follow.length === 0) {
    const sorted = [...analyzed].sort((a, b) => a.frame - b.frame);
    const third = Math.max(1, Math.floor(sorted.length / 3));
    if (prep.length === 0) prep = sorted.slice(0, third);
    if (follow.length === 0) follow = sorted.slice(-third);
  }

  const mean = (xs: PerFrame[]) =>
    xs.length ? xs.reduce((s, p) => s + p.offset, 0) / xs.length : 0;
  // Weight the frames nearest impact most (contact position is the cleanest discriminator);
  // use the pre-impact window as the primary measure since follow-through direction is noisy.
  const prepOffset = mean(prep);
  const followOffset = mean(follow);

  const medShoulderWidth = median(analyzed.map((p) => p.shoulderWidth));
  const facingConsistent =
    analyzed.filter((p) => p.facingSign > 0).length === 0 ||
    analyzed.filter((p) => p.facingSign < 0).length === 0;

  // Racket-hand side around impact is the discriminator: dominant side → backhand,
  // center / crossed → forehand. (Follow-through direction proved inconsistent, so it is
  // reported for debugging but not used in the decision.)
  const side: "forehand" | "backhand" = prepOffset >= 0 ? "backhand" : "forehand";
  const score = clamp01(Math.abs(prepOffset) / Math.max(OFFSET_SCALE(), 1e-6));

  const facing: StrokeSideSignal["facing"] =
    medShoulderWidth < MIN_SHOULDER_WIDTH()
      ? "ambiguous"
      : analyzed[Math.floor(analyzed.length / 2)]!.facingSign >= 0
        ? "behind"
        : "front";

  const confident =
    medShoulderWidth >= MIN_SHOULDER_WIDTH() &&
    facingConsistent &&
    score >= MIN_SCORE() &&
    prep.length >= 1 &&
    analyzed.length >= 3;

  return {
    available: true,
    confident,
    side,
    score,
    dominant_hand: dominant,
    dominant_hand_source: opts.dominantHandSource ?? null,
    facing,
    prep_offset: Number(prepOffset.toFixed(4)),
    follow_offset: Number(followOffset.toFixed(4)),
    frames_used: analyzed.length,
  };
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Forehand / backhand family of a stroke label+preset (null = neutral: overhead/serve). */
export function labelSideFamily(
  label: string | null | undefined,
  preset: string | null | undefined
): "forehand" | "backhand" | null {
  const p = (preset ?? "").toString().toLowerCase();
  if (p.includes("backhand")) return "backhand";
  if (p.includes("forehand")) return "forehand";
  const l = (label ?? "").toString().toLowerCase();
  if (/backhand|revez|rev[eé]s/.test(l)) return "backhand";
  if (/forehand/.test(l)) return "forehand";
  return null;
}

export type StrokeSideTieBreak = {
  retrieval: TechniqueRetrievalResult;
  applied: boolean;
  note: string;
};

/**
 * Re-rank the retrieval hypothesis toward the geometrically-determined stroke side when the
 * current hypothesis is a forehand/backhand label of the OPPOSITE side and a same-side neighbor
 * sits within PROMOTE_WINDOW of the top match. Never invents a label that is not already a near
 * neighbor, and never touches neutral (overhead/serve/bandeja) hypotheses.
 */
export function applyStrokeSideTieBreak(
  retrieval: TechniqueRetrievalResult,
  signal: StrokeSideSignal
): StrokeSideTieBreak {
  const enabled =
    (process.env.STROKE_SIDE_TIEBREAK_ENABLED ?? "true").trim().toLowerCase() !==
    "false";
  const neighbors = retrieval.neighbors ?? [];
  const hyp = retrieval.shot_hypothesis;
  if (
    !enabled ||
    !signal.available ||
    !signal.confident ||
    signal.score < STRONG() ||
    !signal.side ||
    neighbors.length === 0 ||
    !hyp
  ) {
    return { retrieval, applied: false, note: !enabled ? "disabled" : "no_signal_or_neighbors" };
  }

  const hypFamily = labelSideFamily(hyp.stroke_label, hyp.stroke_preset);
  if (hypFamily == null) return { retrieval, applied: false, note: "neutral_hypothesis" };
  if (hypFamily === signal.side) {
    return { retrieval, applied: false, note: "confirmed_side" };
  }

  const top = neighbors[0]!;
  const target = neighbors.find(
    (n) => labelSideFamily(n.stroke_label, n.stroke_preset) === signal.side
  );
  if (!target || target.distance - top.distance > PROMOTE_WINDOW()) {
    return { retrieval, applied: false, note: "no_same_side_neighbor_in_window" };
  }

  const confidence = Math.max(hyp.confidence ?? 0, clamp01(signal.score));
  return {
    retrieval: {
      ...retrieval,
      shot_hypothesis: {
        stroke_label: target.stroke_label,
        stroke_preset: target.stroke_preset,
        category: target.category,
        skill_level: target.skill_level,
        confidence,
      },
    },
    applied: true,
    note: `promoted_${signal.side}_from_pose_geometry`,
  };
}
