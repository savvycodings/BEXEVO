/**
 * Independent lob signal from the YOLO ball path.
 *
 * The pose/mesh embeddings capture body swing but NOT the ball's flight, so a lob and a
 * flat drive/return with the same swing can be indistinguishable to k-NN. Here we read the
 * detected ball's vertical trajectory around impact: a lob sends the ball sharply upward to
 * a high apex. This is a genuinely independent cue used only as a tie-breaker between
 * lob-family and non-lob labels when the retrieval vote is close.
 */

import type { TechniqueRetrievalResult } from "../db/schema";

export type BallDetectionInput = {
  frame: number;
  label: string;
  /** Normalized bbox * 10000 (as persisted in DetectionRow). */
  boxX: number;
  boxY: number;
  boxW: number;
  boxH: number;
};

export type BallPoint = { frame: number; cx: number; cy: number };

export type LobSignal = {
  available: boolean;
  /** Trustworthy (enough ball points to believe a negative). */
  confident: boolean;
  is_lob: boolean;
  /** 0..1 strength of the lob cue. */
  lob_score: number;
  points: number;
  contact_y: number | null;
  apex_y: number | null;
  apex_frame: number | null;
  /** contact_y - apex_y (positive = ball travelled upward). */
  rise: number;
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

const RISE_MIN = () => envNum("LOB_RISE_MIN", 0.12);
const APEX_MAX_Y = () => envNum("LOB_APEX_MAX_Y", 0.55);
const MIN_POINTS = () => envNum("LOB_MIN_POINTS", 4);
/** Lob-family neighbor may be promoted over the top only if within this cosine window. */
const PROMOTE_WINDOW = () => envNum("LOB_PROMOTE_WINDOW", 0.06);
const STRONG = () => envNum("LOB_SCORE_STRONG", 0.6);

export function ballPointsFromDetections(rows: BallDetectionInput[]): BallPoint[] {
  const pts: BallPoint[] = [];
  for (const r of rows) {
    if (r.label !== "sports_ball") continue;
    const x = (r.boxX + r.boxW / 2) / 10000;
    const y = (r.boxY + r.boxH / 2) / 10000;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    pts.push({ frame: r.frame, cx: x, cy: y });
  }
  return pts.sort((a, b) => a.frame - b.frame);
}

export function computeLobSignal(
  balls: BallPoint[],
  opts: { impactFrame?: number | null; totalFrames?: number | null } = {}
): LobSignal {
  const empty: LobSignal = {
    available: false,
    confident: false,
    is_lob: false,
    lob_score: 0,
    points: balls.length,
    contact_y: null,
    apex_y: null,
    apex_frame: null,
    rise: 0,
  };
  if (balls.length < 3) return empty;

  const impactFrame =
    typeof opts.impactFrame === "number" && Number.isFinite(opts.impactFrame)
      ? opts.impactFrame
      : null;

  // Contact reference: ball nearest to impact (or first point if unknown).
  let contact = balls[0]!;
  if (impactFrame != null) {
    contact = balls.reduce((best, p) =>
      Math.abs(p.frame - impactFrame) < Math.abs(best.frame - impactFrame) ? p : best
    );
  }

  // Apex from contact onward (ball rising after being struck). y=0 is top of frame.
  const post = balls.filter((p) => p.frame >= contact.frame);
  const arc = post.length >= 2 ? post : balls;
  let apex = arc[0]!;
  for (const p of arc) if (p.cy < apex.cy) apex = p;

  const contactY = contact.cy;
  const apexY = apex.cy;
  const rise = contactY - apexY;

  const riseScore = clamp01(rise / 0.35);
  const apexScore = clamp01((APEX_MAX_Y() - apexY) / APEX_MAX_Y());
  const lob_score = clamp01(0.65 * riseScore + 0.35 * apexScore);
  const is_lob = rise >= RISE_MIN() && apexY <= APEX_MAX_Y();
  const confident = balls.length >= MIN_POINTS();

  return {
    available: true,
    confident,
    is_lob: is_lob && confident,
    lob_score,
    points: balls.length,
    contact_y: Number(contactY.toFixed(4)),
    apex_y: Number(apexY.toFixed(4)),
    apex_frame: apex.frame,
    rise: Number(rise.toFixed(4)),
  };
}

function labelIsLob(label: string | null | undefined, preset: string | null | undefined): boolean {
  return /lob/i.test((label ?? "").toString()) || /lob/i.test((preset ?? "").toString());
}

export type LobTieBreak = {
  retrieval: TechniqueRetrievalResult;
  applied: boolean;
  note: string;
};

/**
 * Nudge the retrieval hypothesis toward/away from a lob label using the independent ball
 * trajectory, but ONLY when a competing neighbor is close (within PROMOTE_WINDOW). Never
 * invents a label that is not already a near neighbor, so it cannot fabricate shots.
 */
export function applyLobTieBreak(
  retrieval: TechniqueRetrievalResult,
  lob: LobSignal
): LobTieBreak {
  const neighbors = retrieval.neighbors ?? [];
  if (!lob.available || neighbors.length === 0 || !retrieval.shot_hypothesis) {
    return { retrieval, applied: false, note: "no_signal_or_neighbors" };
  }

  const top = neighbors[0]!;
  const topIsLob = labelIsLob(top.stroke_label, top.stroke_preset);
  const hyp = retrieval.shot_hypothesis;
  const hypIsLob = labelIsLob(hyp.stroke_label, hyp.stroke_preset);

  const promoteFrom = (
    target: (typeof neighbors)[number],
    confidence: number,
    note: string
  ): LobTieBreak => ({
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
    note,
  });

  // Strong lob cue but hypothesis is not a lob → promote nearest lob-family neighbor if close.
  // NOTE: we deliberately only PROMOTE toward a lob, never demote away from one. A lob arc is
  // frequently missed by the ball detector (the ball leaves the frame or is lost at the apex),
  // so a low lob_score is not trustworthy evidence of "not a lob" and must not override a strong
  // pose/mesh match that already resolved to a lob.
  if (lob.is_lob && lob.lob_score >= STRONG() && !hypIsLob) {
    const lobN = neighbors.find((n) => labelIsLob(n.stroke_label, n.stroke_preset));
    if (lobN && lobN.distance - top.distance <= PROMOTE_WINDOW()) {
      const conf = Math.max(hyp.confidence ?? 0, clamp01(lob.lob_score));
      return promoteFrom(lobN, conf, "promoted_lob_from_ball_arc");
    }
  }

  // Hypothesis already agrees with the ball cue → mild confirmation only.
  if (lob.is_lob && lob.lob_score >= STRONG() && hypIsLob && topIsLob) {
    return { retrieval, applied: false, note: "confirmed_lob" };
  }

  return { retrieval, applied: false, note: "no_change" };
}
