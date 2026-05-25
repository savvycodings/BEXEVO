import type { LabeledPoseFrame } from "./impactPoseContext";
import { MEDIAPIPE_POSE_LANDMARK_NAMES } from "./poseEmbedding";
import { fal } from "@fal-ai/client";
import { runChat, chatContent } from "../lib/chatProvider";
import {
  parseFlexibleJsonFromLlmContent,
  parseJsonArrayFromLlmContent,
} from "../lib/llmResponse";

/** fal.subscribe hits queue.fal.run; on DNS issues retry with fal.run (sync), same as falLoraRouter. */
function getNetworkErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as { code?: string; cause?: { code?: string } };
  return e.cause?.code || e.code;
}

function getErrHostname(err: unknown): string | undefined {
  const c =
    err && typeof err === "object"
      ? (err as { cause?: { hostname?: string } }).cause
      : undefined;
  return c?.hostname;
}

function shouldFallbackSubscribeToRun(err: unknown): boolean {
  const code = getNetworkErrorCode(err);
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ECONNREFUSED") {
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/queue\.fal\.run/i.test(msg)) return true;
  return false;
}

const GEMINI_API_BASE =
  "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_MODEL = "gemini-2.5-flash-image";
const GEMINI_IMAGE_MAX_ATTEMPTS = 4;
const GEMINI_RETRY_BASE_MS = 900;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type Landmark = { x: number; y: number };
export type FrameLandmarks = Record<string, Landmark>;

export interface LandmarkDelta {
  landmark: string;
  axis: "x" | "y";
  direction: "increase" | "decrease";
  magnitude: "small" | "moderate" | "large";
  reason: string;
}

export interface CorrectionResult {
  frame: number;
  originalImage: string;
  correctedImage: string;
}

export type DominantHand = "right-handed" | "left-handed" | "unknown";

export interface HandednessClassification {
  dominant_hand: DominantHand;
  confidence: number;
  evidence: string[];
}

export interface ShotClassification {
  shot_family: string;
  shot_name: string;
  variant: string;
  tactical_phase: string;
  court_zone: string;
  ball_context: string;
  player_side: string;
  contact_height: string;
  contact_timing: string;
  spin_profile: string;
  objective: string;
  diagnostic_features: string[];
  confidence: number;
}

export interface ShotAndHandedness {
  shot: ShotClassification;
  handedness: HandednessClassification;
}

const DEFAULT_SHOT_AND_HANDEDNESS: ShotAndHandedness = {
  shot: {
    shot_family: "unknown",
    shot_name: "unknown",
    variant: "unknown",
    tactical_phase: "unknown",
    court_zone: "unknown",
    ball_context: "unknown",
    player_side: "unknown",
    contact_height: "unknown",
    contact_timing: "unknown",
    spin_profile: "unknown",
    objective: "unknown",
    diagnostic_features: [],
    confidence: 0,
  },
  handedness: {
    dominant_hand: "unknown",
    confidence: 0,
    evidence: [],
  },
};

/**
 * When `CORRECTION_IMAGES_ASSUME_RIGHT_HANDED=true`, correction images always use a right-handed striker
 * (legacy escape hatch). Default is off; prefer `mergeCorrectionShotAndHandedness` with profile + geometry hints.
 */
export function correctionImagesAssumeRightHanded(): boolean {
  return String(process.env.CORRECTION_IMAGES_ASSUME_RIGHT_HANDED ?? "").trim() === "true";
}

export type HandednessMergeHints = {
  /** From `user.dominantHand` when set to left or right. */
  profileDominantHand: DominantHand | null;
  /** From `pose_data[].racket_hand` majority on the correction frame(s). */
  geometryConsensus: DominantHand | null;
};

/** Map app/profile string (e.g. "Left", "right-handed") to left/right, or null if unset/ambiguous. */
export function profileTextToDominantHand(raw: string | null | undefined): DominantHand | null {
  const t = String(raw ?? "").toLowerCase();
  if (t.includes("left")) return "left-handed";
  if (t.includes("right")) return "right-handed";
  return null;
}

/** Majority vote of per-frame `racket_hand` (from MediaPipe wrists vs YOLO racket box). Ties return unknown. */
export function computeRacketHandConsensusForFrames(
  poseData: Array<{ frame: number; racket_hand?: "left" | "right" | null }>,
  frameIndices: number[]
): DominantHand | null {
  let left = 0;
  let right = 0;
  for (const fi of frameIndices) {
    const row = poseData.find((p) => p.frame === fi);
    const h = row?.racket_hand;
    if (h === "left") left += 1;
    else if (h === "right") right += 1;
  }
  if (left + right === 0) return null;
  if (left > right) return "left-handed";
  if (right > left) return "right-handed";
  return null;
}

/**
 * Order: env force-right (legacy) → user profile → pose racket_hand consensus → GPT classification → unknown.
 * Shot text always comes from `classified` when present.
 */
export function mergeCorrectionShotAndHandedness(
  classified: ShotAndHandedness | null,
  hints?: HandednessMergeHints | null
): ShotAndHandedness {
  const shot = classified?.shot ?? DEFAULT_SHOT_AND_HANDEDNESS.shot;

  if (correctionImagesAssumeRightHanded()) {
    return {
      shot,
      handedness: {
        dominant_hand: "right-handed",
        confidence: 1,
        evidence: ["assumed_right_handed_env_override"],
      },
    };
  }

  const p = hints?.profileDominantHand;
  if (p === "left-handed" || p === "right-handed") {
    return {
      shot,
      handedness: {
        dominant_hand: p,
        confidence: 0.9,
        evidence: ["user_profile_dominant_hand"],
      },
    };
  }

  const g = hints?.geometryConsensus;
  if (g === "left-handed" || g === "right-handed") {
    return {
      shot,
      handedness: {
        dominant_hand: g,
        confidence: 0.75,
        evidence: ["pose_racket_hand_consensus"],
      },
    };
  }

  const cl = classified?.handedness;
  if (cl && (cl.dominant_hand === "left-handed" || cl.dominant_hand === "right-handed")) {
    return {
      shot,
      handedness: {
        ...cl,
        evidence: cl.evidence?.length ? cl.evidence : ["gpt_classify_shot_and_handedness"],
      },
    };
  }
  if (cl) {
    return { shot, handedness: cl };
  }
  return { shot, handedness: DEFAULT_SHOT_AND_HANDEDNESS.handedness };
}

/** Use after `mergeCorrectionShotAndHandedness` — do not re-merge (would duplicate policy). */
function shotAndHandednessForImagePrompt(
  merged: ShotAndHandedness | null | undefined
): ShotAndHandedness {
  if (!merged) return DEFAULT_SHOT_AND_HANDEDNESS;
  return {
    shot: merged.shot ?? DEFAULT_SHOT_AND_HANDEDNESS.shot,
    handedness: merged.handedness ?? DEFAULT_SHOT_AND_HANDEDNESS.handedness,
  };
}

function clampConfidence(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function normalizeDominantHand(value: unknown): DominantHand {
  const raw = String(value ?? "").toLowerCase();
  if (raw.includes("left")) return "left-handed";
  if (raw.includes("right")) return "right-handed";
  return "unknown";
}

function formatLandmarksForPrompt(
  landmarks: FrameLandmarks,
  poseSequence?: LabeledPoseFrame[] | null
): string {
  if (poseSequence && poseSequence.length > 0) {
    return `POSE SEQUENCE (chronological — user-marked ball impact; infer shot from preparation → impact → follow-through, not from a single idle frame):
${poseSequence
  .map(
    (p) =>
      `${p.phase.toUpperCase()} (video frame index ${p.frame}):\n${JSON.stringify(p.landmarks, null, 2)}`
  )
  .join("\n\n")}`;
  }
  return `CURRENT LANDMARKS (single sample — weaker context):
${JSON.stringify(landmarks, null, 2)}`;
}

export async function classifyShotAndHandedness(
  recommendations: string[],
  diagnosis: string,
  landmarks: FrameLandmarks,
  poseSequence?: LabeledPoseFrame[] | null
): Promise<ShotAndHandedness> {
  const prompt = `You are a world-class padel biomechanics classifier.

Classify the shot using body movement + context (not name-only), and infer dominant handedness.

COACH DIAGNOSIS:
${diagnosis}

COACH RECOMMENDATIONS:
${recommendations.map((r, i) => `${i + 1}. ${r}`).join("\n")}

${formatLandmarksForPrompt(landmarks, poseSequence)}

Output ONLY valid JSON matching:
{
  "shot": {
    "shot_family": "",
    "shot_name": "",
    "variant": "",
    "tactical_phase": "",
    "court_zone": "",
    "ball_context": "",
    "player_side": "",
    "contact_height": "",
    "contact_timing": "",
    "spin_profile": "",
    "objective": "",
    "diagnostic_features": ["", "", ""],
    "confidence": 0.0
  },
  "handedness": {
    "dominant_hand": "right-handed | left-handed | unknown",
    "confidence": 0.0,
    "evidence": ["", "", ""]
  }
}

Rules:
- When a POSE SEQUENCE is provided, weight preparation + impact + follow-through together; the impact-phase sample is closest to ball contact — do not classify from a random frame that might be standing still before the swing.
- Preserve left-handed interpretation if evidence indicates left dominance.
- Do NOT use camera-left/camera-right as forehand/backhand by itself.
- Base handedness and shot type on pose, racket/body orientation, and movement — not on hairstyle, hair length, clothing style, or other appearance stereotypes.
- If uncertain, return "unknown" with lower confidence.
- Return JSON only.`;

  let content: string | null = null;
  try {
    const res = await runChat(
      {
        model: "gpt-4o-mini",
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You classify padel movement and handedness from biomechanics. Respond only with strict JSON. No markdown fences.",
          },
          { role: "user", content: prompt },
        ],
      },
      { provider: "xevo" }
    );
    content = chatContent(res);
    if (!content) {
      console.error("[CorrectionPrompt] Shot classification returned no content", res);
      return DEFAULT_SHOT_AND_HANDEDNESS;
    }
  } catch (err) {
    console.error("[CorrectionPrompt] Shot classification chat call failed", err);
    return DEFAULT_SHOT_AND_HANDEDNESS;
  }

  try {
    const parsed = parseFlexibleJsonFromLlmContent(content) as Partial<ShotAndHandedness>;
    const shot = parsed?.shot ?? {};
    const handedness = parsed?.handedness ?? {};

    return {
      shot: {
        shot_family: String((shot as any).shot_family ?? "unknown"),
        shot_name: String((shot as any).shot_name ?? "unknown"),
        variant: String((shot as any).variant ?? "unknown"),
        tactical_phase: String((shot as any).tactical_phase ?? "unknown"),
        court_zone: String((shot as any).court_zone ?? "unknown"),
        ball_context: String((shot as any).ball_context ?? "unknown"),
        player_side: String((shot as any).player_side ?? "unknown"),
        contact_height: String((shot as any).contact_height ?? "unknown"),
        contact_timing: String((shot as any).contact_timing ?? "unknown"),
        spin_profile: String((shot as any).spin_profile ?? "unknown"),
        objective: String((shot as any).objective ?? "unknown"),
        diagnostic_features: Array.isArray((shot as any).diagnostic_features)
          ? ((shot as any).diagnostic_features as any[]).map((x) => String(x))
          : [],
        confidence: clampConfidence((shot as any).confidence),
      },
      handedness: {
        dominant_hand: normalizeDominantHand((handedness as any).dominant_hand),
        confidence: clampConfidence((handedness as any).confidence),
        evidence: Array.isArray((handedness as any).evidence)
          ? ((handedness as any).evidence as any[]).map((x) => String(x))
          : [],
      },
    };
  } catch (err) {
    console.error("[CorrectionPrompt] Failed to parse shot classification", err);
    return DEFAULT_SHOT_AND_HANDEDNESS;
  }
}

export async function translateRecommendationsToDeltas(
  recommendations: string[],
  diagnosis: string,
  landmarks: FrameLandmarks,
  poseSequence?: LabeledPoseFrame[] | null
): Promise<LandmarkDelta[]> {
  const prompt = `You are a sports biomechanics expert. Given these padel coach recommendations and the player's body landmark positions (normalized 0-1, origin top-left of video frame), output a JSON array of specific landmark adjustments needed.

COACH DIAGNOSIS:
${diagnosis}

COACH RECOMMENDATIONS:
${recommendations.map((r, i) => `${i + 1}. ${r}`).join("\n")}

${formatLandmarksForPrompt(landmarks, poseSequence)}

Respond ONLY with valid JSON in this shape (no markdown fences):
{ "deltas": [
  {
    "landmark": "LEFT_ANKLE",
    "axis": "x",
    "direction": "decrease",
    "magnitude": "moderate",
    "reason": "wider stance for stability"
  }
] }

Rules:
- Only use landmark names that exist in the input (e.g. LEFT_SHOULDER, RIGHT_KNEE, LEFT_ANKLE, etc.)
- axis: "x" (horizontal) or "y" (vertical, increasing = lower on screen)
- direction: "increase" or "decrease"
- magnitude: "small" (subtle tweak), "moderate" (noticeable change), "large" (significant repositioning)
- Focus on the 3-5 most impactful corrections
- Keep adjustments local to posture (limbs, torso, hips, shoulders); do not imply moving the player to a different court position or side of the frame.
- Do not use head, nose, ear, or eye landmarks to change gaze or head angle — assume the player already looks at the ball; focus corrections from the neck down.
- Preserve the same phase of the shot as in the landmarks (e.g. overhead reach stays overhead — do not phrase deltas as if the player should drop into a neutral ready stance or wait for serve).
- If the pose is overhead preparation (lean, racket loaded behind), deltas must only tweak mechanics within that arc — never imply standing tall with racket down or in front as if the ball has not arrived.
- If landmarks imply impact or mid-swing, do not phrase corrections as if the moment were pre-contact or reception only — stay in the same instant of the stroke.
- Output only skeletal/pose adjustments for biomechanics — never recommendations about hair, face, clothing, or identity.
- Only respond with valid JSON, no markdown, no explanation`;

  let content: string | null = null;
  try {
    const res = await runChat(
      {
        model: "gpt-4o-mini",
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You are a biomechanics assistant. Respond with JSON only: { \"deltas\": [ ... ] }. No markdown fences.",
          },
          { role: "user", content: prompt },
        ],
      },
      { provider: "xevo" }
    );
    content = chatContent(res);
    if (!content) {
      console.error("[CorrectionPrompt] GPT returned no content", res);
      return [];
    }
  } catch (err) {
    console.error("[CorrectionPrompt] Delta translation chat call failed", err);
    return [];
  }

  try {
    return parseJsonArrayFromLlmContent(content) as LandmarkDelta[];
  } catch {
    console.error("[CorrectionPrompt] Failed to parse GPT deltas", content);
    return [];
  }
}

const MAGNITUDE_NORM_STEP: Record<LandmarkDelta["magnitude"], number> = {
  small: 0.025,
  moderate: 0.05,
  large: 0.09,
};

function formatCoord(x: number, y: number): string {
  return `(${x.toFixed(3)}, ${y.toFixed(3)})`;
}

function formatShiftHint(dx: number, dy: number): string {
  const parts: string[] = [];
  if (Math.abs(dx) >= 0.004) {
    parts.push(
      `${dx > 0 ? "right" : "left"} ${(Math.abs(dx) * 100).toFixed(1)}% of frame width`
    );
  }
  if (Math.abs(dy) >= 0.004) {
    parts.push(
      `${dy > 0 ? "down" : "up"} ${(Math.abs(dy) * 100).toFixed(1)}% of frame height`
    );
  }
  return parts.length > 0 ? parts.join(", ") : "minimal pixel shift";
}

/** Coach-only delta: approximate target in normalized 0–1 frame coords when no pro landmark. */
function inferredTargetFromDelta(
  u: Landmark,
  d: LandmarkDelta
): { x: number; y: number } {
  const step = MAGNITUDE_NORM_STEP[d.magnitude];
  let x = u.x;
  let y = u.y;
  if (d.axis === "x") {
    x += d.direction === "increase" ? step : -step;
  } else {
    y += d.direction === "increase" ? step : -step;
  }
  return { x, y };
}

function formatJointMoveLine(
  d: LandmarkDelta,
  userLandmarks?: FrameLandmarks | null,
  proLandmarks?: FrameLandmarks | null
): string {
  const u = userLandmarks?.[d.landmark];
  const p = proLandmarks?.[d.landmark];
  const hasUser =
    u && typeof u.x === "number" && typeof u.y === "number";
  const hasPro =
    p && typeof p.x === "number" && typeof p.y === "number";

  if (hasUser && hasPro) {
    const dx = p.x - u.x;
    const dy = p.y - u.y;
    return (
      `- ${d.landmark}: current ${formatCoord(u.x, u.y)} → target ${formatCoord(p.x, p.y)} ` +
      `(shift ${formatShiftHint(dx, dy)}; ${d.magnitude}) — ${d.reason}`
    );
  }

  if (hasUser) {
    const t = inferredTargetFromDelta(u, d);
    const dx = t.x - u.x;
    const dy = t.y - u.y;
    return (
      `- ${d.landmark}: current ${formatCoord(u.x, u.y)} → target ${formatCoord(t.x, t.y)} ` +
      `(shift ${formatShiftHint(dx, dy)}; ${d.magnitude}) — ${d.reason}`
    );
  }

  const dirWord = d.direction === "increase" ? "move right/lower" : "move left/higher";
  const axisWord = d.axis === "x" ? "horizontally" : "vertically";
  return `- ${d.landmark}: ${dirWord} ${axisWord} (${d.magnitude}) — ${d.reason}`;
}

export function deltasToInstructions(
  deltas: LandmarkDelta[],
  userLandmarks?: FrameLandmarks | null,
  proLandmarks?: FrameLandmarks | null
): string {
  if (deltas.length === 0) {
    return "Apply the coach's recommendations to correct the player's body positioning.";
  }

  return deltas
    .map((d) => formatJointMoveLine(d, userLandmarks, proLandmarks))
    .join("\n");
}

export function formatTopPriorityMove(
  d: LandmarkDelta,
  userLandmarks?: FrameLandmarks | null,
  proLandmarks?: FrameLandmarks | null
): string {
  const line = formatJointMoveLine(d, userLandmarks, proLandmarks);
  return line.replace(/^- /, "");
}

const PRO_GAP_MIN_SQ = 0.0004;

function proGapMagnitude(absDelta: number): LandmarkDelta["magnitude"] {
  if (absDelta < 0.03) return "small";
  if (absDelta < 0.08) return "moderate";
  return "large";
}

/** Plain-language hint for image models (normalized coords: larger y = lower in frame). */
function proGapCoachingLine(
  name: string,
  axis: "x" | "y",
  userVal: number,
  proVal: number
): string {
  const delta = userVal - proVal;
  if (Math.abs(delta) < 0.008) return "";
  if (axis === "y") {
    if (delta > 0) {
      return `${name}: your joint sits lower in the frame than the pro — raise it toward the pro position.`;
    }
    return `${name}: your joint sits higher than the pro — lower it toward the pro position.`;
  }
  if (delta > 0) {
    return `${name}: your joint is farther right than the pro — shift left toward the pro position.`;
  }
  return `${name}: your joint is farther left than the pro — shift right toward the pro position.`;
}

/** Top landmark gaps (user vs pro library frame) in normalized coords — guides img2img toward pro mechanics without changing scene. */
export function summarizeProUserLandmarkGap(
  user: FrameLandmarks,
  pro: FrameLandmarks,
  topK = 10
): string {
  const rows: { dist: number; line: string; coach: string }[] = [];
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
      proGapCoachingLine(
        name,
        axis,
        axis === "x" ? u.x : u.y,
        axis === "x" ? p.x : p.y
      ) || `${name}: align toward pro.`;
    rows.push({
      dist,
      line: `${name}: user(${u.x.toFixed(3)},${u.y.toFixed(3)}) vs pro(${p.x.toFixed(3)},${p.y.toFixed(3)}) — nudge toward pro Δx=${(-dx).toFixed(3)} Δy=${(-dy).toFixed(3)}`,
      coach,
    });
  }
  rows.sort((a, b) => b.dist - a.dist);
  if (rows.length === 0) return "(no overlapping landmarks vs pro reference)";
  const top = rows.slice(0, topK);
  const gapLines = top.map((r) => r.line).join("\n");
  const coachLines = top.map((r) => `- ${r.coach}`).join("\n");
  return `${gapLines}\n\nCoach-readable gaps (what to fix in the photo):\n${coachLines}`;
}

/**
 * Deterministic joint adjustments: move user landmarks toward the retrieved pro pose.
 * Merged into Comfy/Gemini prompts (with Unsloth coach deltas) so diffusion has explicit targets.
 */
export function proGapToLandmarkDeltas(
  user: FrameLandmarks,
  pro: FrameLandmarks,
  topK = 12
): LandmarkDelta[] {
  const rows: {
    dist: number;
    name: string;
    axis: "x" | "y";
    direction: "increase" | "decrease";
    magnitude: LandmarkDelta["magnitude"];
  }[] = [];

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
    const delta = axis === "x" ? dx : dy;
    const direction: "increase" | "decrease" = delta > 0 ? "decrease" : "increase";
    rows.push({
      dist,
      name,
      axis,
      direction,
      magnitude: proGapMagnitude(Math.abs(delta)),
    });
  }

  rows.sort((a, b) => b.dist - a.dist);
  return rows.slice(0, topK).map((r) => {
    const u = user[r.name]!;
    const p = pro[r.name]!;
    return {
      landmark: r.name,
      axis: r.axis,
      direction: r.direction,
      magnitude: r.magnitude,
      reason: `pro library: ${r.name} ${formatCoord(u.x, u.y)} → ${formatCoord(p.x, p.y)}`,
    };
  });
}

/** Pro-library deltas win on the same landmark+axis; coach deltas fill the rest. */
export function mergeLandmarkDeltas(
  proDeltas: LandmarkDelta[],
  coachDeltas: LandmarkDelta[]
): LandmarkDelta[] {
  const key = (d: LandmarkDelta) => `${d.landmark}:${d.axis}`;
  const map = new Map<string, LandmarkDelta>();
  for (const d of coachDeltas) map.set(key(d), d);
  for (const d of proDeltas) map.set(key(d), d);
  return [...map.values()];
}

export interface ProNeighborCorrectionContextParams {
  strokeName: string;
  strokePreset: string;
  skillLevel: string;
  distance: number;
  userLandmarks: FrameLandmarks;
  proLandmarks: FrameLandmarks;
}

/** Text block for Comfy/Gemini: nearest-pro retrieval + target pose + concrete gaps for this frame. */
export function buildProNeighborCorrectionContext(
  p: ProNeighborCorrectionContextParams
): string {
  const gap = summarizeProUserLandmarkGap(p.userLandmarks, p.proLandmarks);
  return `PRO LIBRARY MATCH (vector neighbor, distance ${p.distance.toFixed(4)}): "${p.strokeName}" / ${p.strokePreset} / skill ${p.skillLevel}.
This is the constructive visual target — adjust the user's body in the photo toward the pro's pose at the same moment in the swing. Do not change court, camera, clothing, or identity.

TARGET POSE LANDMARKS from pro clip (normalized 0-1, top-left — match these joint positions):
${JSON.stringify(p.proLandmarks, null, 2)}

USER vs PRO gaps at this frame:
${gap}`;
}

export async function generateCorrectedImage(
  originalImageBase64: string,
  mimeType: string,
  frameNumber: number,
  landmarks: FrameLandmarks,
  deltas: LandmarkDelta[],
  diagnosis: string,
  recommendations: string[],
  shotAndHandedness?: ShotAndHandedness | null,
  proReferenceText?: string | null
): Promise<string | null> {
  const instructions = deltasToInstructions(deltas);
  const { shot, handedness } = shotAndHandednessForImagePrompt(shotAndHandedness);

  const proBlock =
    proReferenceText && proReferenceText.trim().length > 0
      ? `

PRO LIBRARY POSE TARGET (nearest matching pro clip — prioritize moving joints toward these pro positions; same instant in the swing as aligned to this frame):
${proReferenceText.trim()}
`
      : "";

  const textPrompt = `You are a sports visualization engine that creates photorealistic corrected-pose images for athletes.

I am providing you with a single frame (frame ${frameNumber}) from a PADEL / pádel court video (enclosed glass court, padel racket). This is NOT lawn tennis, NOT a strung tennis racquet.

CURRENT POSE LANDMARKS (normalized 0-1, top-left origin):
${JSON.stringify(landmarks, null, 2)}

COACH DIAGNOSIS:
${diagnosis}

COACH RECOMMENDATIONS:
${recommendations.map((r, i) => `${i + 1}. ${r}`).join("\n")}

SHOT CLASSIFICATION (movement/context):
${JSON.stringify(shot, null, 2)}

HANDEDNESS (must be preserved):
${JSON.stringify(handedness, null, 2)}

SPECIFIC BODY ADJUSTMENTS TO MAKE:
${instructions}
${proBlock}
TASK:
Regenerate this EXACT image — same person, same clothing, same court, same camera angle, same lighting, same background — but adjust ONLY the player's body position to reflect the corrections above.

Keep the player anchored in the same spot on the court and in the frame: small joint and posture fixes only — do NOT move or "teleport" the athlete to another side of the court, another zone, or a different place in the image (that breaks alignment with the original for comparison views).

Preserve the SAME moment of play as the source: if the player is reaching overhead, tracking upward, or preparing a specific stroke, keep that action — do NOT re-stage them into a different phase (e.g. neutral "ready" stance, waiting for serve, or relaxed waiting). Keep racket height intent and body lean consistent with the stroke.

HEAD AND EYE LINE (source of truth): Copy the head, neck, face, and apparent eye direction from the source frame exactly — do NOT rotate or tilt the head, redirect the gaze, lift the chin, or "fix" where they are looking. They are already tracking the ball; treat head/eye line as fixed and apply corrections to shoulders, torso, arms, hips, and legs only.

IMPACT / CONTACT: If the source shows the ball at or near the racket, mid-swing, motion blur, or the hitting moment, you MUST keep that same impact instant — this product teaches how to strike the ball better, not a generic stance. Refine joint angles and posture only; do NOT replace a dynamic hit with a passive "waiting for the ball" pose. Preserve ball–racket relationship when both appear, and preserve the sense of motion (blur) if present.

OVERHEAD / SWING ARC (critical): If the source shows preparation for an overhead (smash, bandeja, high volley prep) — e.g. body leaning back, racket loaded behind the head or shoulders, non-hitting arm up for balance/tracking, eyes on an incoming ball above — you MUST keep that full athletic arc and loading. Do NOT collapse this into an upright "the ball has not arrived yet" or neutral ready stance with the racket low or parked in front. The player must still be arcing to strike, not passively waiting for play to start.

COURT FLOOR: Do NOT add, extend, remove, or redraw white lines, service boxes, T-lines, or any painted markings on the blue court. The visible floor graphics must match the source; never hallucinate extra line art on the surface.

SCALE AND FRAMING: Match the source image's zoom and composition exactly — the player must NOT appear larger, smaller, closer, or farther from the camera. Same apparent size in the frame (height/width footprint) as the reference; no crop change, no digital zoom, no "hero shot" enlargement. This is required for side-by-side before/after alignment.

The result must look like a real photograph of the same individual in the same environment, just with improved body mechanics. Hair is frozen to the source: same length, cut, and volume — never lengthen, restyle, or add flowing hair. Match the reference frame for face, hair, apparent age, body build, and gender presentation — do not gender-swap, de-age, "beautify," or change hair length or hairstyle (e.g. short hair must remain short). Do NOT change clothing, face identity, court, or surroundings. Do NOT add or remove the padel racket or the ball — if there is no ball in the source frame, the output must not show a ball. The racket must stay a PADEL racket (short handle, solid perforated face, wrist strap) — never replace with a lawn-tennis strung racquet, squash, or badminton racket. Do NOT add text, labels, or overlays.`;

  const invariantBlock = `
NON-NEGOTIABLE INVARIANTS:
1) Preserve player identity: same face, skin tone, apparent age, and body build as the input image.
2) HAIR FREEZE — Hair length, cut, color, and volume must match the source image exactly. Do NOT lengthen, shorten, restyle, or add flowing/long hair; short or voluminous hair must stay that way. Do not "beautify" or salon-style the hair. This is a hard requirement.
3) APPEARANCE LOCK — match the input photo exactly for: facial hair; glasses, hat, headband, or jewelry; visible clothing and shoes. Do not invent makeup or accessories that are not in the source.
4) Do not change apparent gender presentation or demographics; do not replace the athlete with a different-looking person.
5) Preserve clothing, court, camera angle, and lighting. Do NOT edit the environment: no new white lines, service boxes, or court markings on the blue surface; no redrawn floor graphics — match the source floor exactly.
6) SPATIAL LOCK — The player stays in the same court position and the same region of the image as the source. Do NOT translate or relocate the whole body to a different side of the court, different depth, or different lateral position. Adjust limbs, torso, hips, and shoulders within that fixed footprint; existing visible court lines, net, glass, and walls must align with the source — no sliding the figure across the scene, and do not add lines that were not in the source.
7) HEAD, FACE, AND EYE-LINE FREEZE — Match head orientation, neck angle, face, and where the eyes appear to look from the source pixel-for-pixel in intent. Do NOT change gaze direction, head tilt, or facial pose to "improve" tracking; the source already shows correct ball focus. No new facial expression or eye line.
8) SCALE AND FRAMING LOCK — Match the reference image's field of view and scale exactly. Do NOT zoom, crop differently, or change the player's apparent size (no making the athlete larger/taller in frame or closer to camera). Output must overlay the original for comparison: same pixel extent of the figure, same camera distance feel.
9) MOMENT AND SWING-ARC LOCK — Preserve the same phase of play and tactical intent as the source. If the player is in overhead preparation (lean back, racket behind head/shoulders) or mid-swing, keep that full athletic shape — do NOT collapse into a neutral upright stance, hands-and-racket low in front, or passive reception. Preserve body lean and racket load height; do not re-choreograph into a different stroke moment. Head/eye line stay per (7), not reinterpreted by the model.
10) IMPACT AND CONTACT LOCK — The lesson is better ball striking; the output must show the SAME stroke instant as the source (impact, contact, ball near racket, OR the same preparation/arc if that is what the frame shows). If the source shows a hit or pre-hit loaded arc, keep that — same ball–racket relationship when visible, same swing phase. Do NOT remove the hit or the overhead arc to produce a static waiting pose. Do not "sanitize" motion blur into a stiff catalog pose unless the source was already static.
11) Preserve dominant hand exactly (${handedness.dominant_hand}); do NOT mirror left/right body mechanics.
12) PADEL RACKET AND BALL — Do not add or remove equipment. If the source frame has no visible ball, do NOT add a ball. If a ball is visible, keep it (do not erase it). If the padel racket is not in the frame, do NOT add one; if it is visible, do NOT remove it or replace it with a different racket type. The racket must remain a padel racket (perforated solid face, short grip, wrist strap) — NEVER a lawn-tennis strung racquet or other sport. Only adjust pose; equipment inventory and equipment class must match the source image.
13) Interpret forehand/backhand from player orientation (player-centric), not image left/right.
14) Only modify biomechanical posture needed for corrections (below the neck / without altering head pose per (7)); no cosmetic or stylistic changes.
15) Do not add text, labels, watermarks, skeleton overlays, or extra objects.`;

  const parts: any[] = [
    { text: `${textPrompt}\n\n${invariantBlock}` },
    {
      inline_data: {
        mime_type: mimeType,
        data: originalImageBase64,
      },
    },
  ];

  const apiKey = process.env.GEMINI_API_KEY || "";
  const url = `${GEMINI_API_BASE}/${GEMINI_MODEL}:generateContent`;
  const body = JSON.stringify({
    contents: [{ parts }],
    generationConfig: {
      responseModalities: ["IMAGE"],
    },
  });

  for (let attempt = 1; attempt <= GEMINI_IMAGE_MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body,
      });

      const rawText = await response.text();
      let data: any = {};
      try {
        data = rawText ? JSON.parse(rawText) : {};
      } catch {
        data = { _parseError: true, raw: rawText.slice(0, 200) };
      }

      if (!response.ok) {
        const retryable =
          response.status === 429 ||
          response.status === 408 ||
          response.status >= 500;
        console.warn("[CorrectionPrompt] Gemini HTTP error", {
          frameNumber,
          status: response.status,
          attempt,
          retryable,
          snippet: rawText.slice(0, 200),
        });
        if (retryable && attempt < GEMINI_IMAGE_MAX_ATTEMPTS) {
          await sleep(GEMINI_RETRY_BASE_MS * attempt * attempt);
          continue;
        }
        return null;
      }

      const responseParts = data?.candidates?.[0]?.content?.parts || [];

      const imagePart = responseParts.find((part: any) => {
        const inlineData = part?.inlineData || part?.inline_data;
        return inlineData?.data;
      });

      const inlineData = imagePart?.inlineData || imagePart?.inline_data;
      if (!inlineData?.data) {
        const emptyRetryable =
          attempt < GEMINI_IMAGE_MAX_ATTEMPTS &&
          (data?.error?.code === 429 ||
            data?.error?.status === "RESOURCE_EXHAUSTED");
        console.error(
          "[CorrectionPrompt] Gemini returned no image for frame",
          frameNumber,
          JSON.stringify(data).slice(0, 500)
        );
        if (emptyRetryable) {
          await sleep(GEMINI_RETRY_BASE_MS * attempt * attempt);
          continue;
        }
        return null;
      }

      const outMime =
        inlineData.mimeType || inlineData.mime_type || "image/png";
      return `data:${outMime};base64,${inlineData.data}`;
    } catch (err: any) {
      console.warn("[CorrectionPrompt] Gemini fetch failed", {
        frameNumber,
        attempt,
        message: err?.message,
      });
      if (attempt < GEMINI_IMAGE_MAX_ATTEMPTS) {
        await sleep(GEMINI_RETRY_BASE_MS * attempt * attempt);
        continue;
      }
      return null;
    }
  }

  return null;
}

function resolveFalKeyForCorrections(): string {
  return String(process.env.FAL_API_KEY || process.env.FAL_KEY || "").trim();
}

/** Short English prompt for Flux img2img (fal); keeps same coaching intent as Gemini without huge token load. */
export function buildFalCorrectionPrompt(
  frameNumber: number,
  landmarks: FrameLandmarks,
  deltas: LandmarkDelta[],
  diagnosis: string,
  recommendations: string[],
  shotAndHandedness: ShotAndHandedness | null,
  proReferenceText?: string | null
): string {
  const instructions = deltasToInstructions(deltas);
  const { shot, handedness } = shotAndHandednessForImagePrompt(shotAndHandedness);
  const rec = recommendations.map((r, i) => `${i + 1}. ${r}`).join(" ");
  const trigger = String(process.env.FAL_CORRECTION_TRIGGER_WORD || "").trim();
  const triggerLead = trigger ? `${trigger}. ` : "";
  const proBit =
    proReferenceText && proReferenceText.trim().length > 0
      ? ` Pro library landmark targets (nudge body toward pro, nothing else): ${proReferenceText.trim().replace(/\s+/g, " ")}`
      : "";
  return `${triggerLead}Minimal img2img edit of one padel frame (frame ${frameNumber}). PADEL only — perforated solid racket, short handle, wrist strap; NOT a lawn-tennis strung racquet. Keep the input image as unchanged as possible: same pixels for background, court, glass, lines, lighting, skin tone, clothing, hair, and padel racket. Preserve composition and crop.

ONLY nudge limb and torso posture toward better mechanics — very small joint-angle changes. Do NOT restyle, relight, recolor, beautify, or replace the athlete. Do NOT change the background or floor.

Shot: ${shot.shot_name} (${shot.shot_family}). Striker: ${handedness.dominant_hand}.
Coach diagnosis: ${diagnosis}
Adjustments: ${instructions}
Coaching cues: ${rec}${proBit}

Hard constraints: same framing and scale; keep head pose and gaze; no teleporting; no adding/removing racket or ball; racket must stay padel-style; no new objects.`;
}

/**
 * Rich correction prompt for **ComfyUI + Qwen Image Edit 2511 GGUF**.
 *
 * Qwen 2.5-VL (the text encoder behind the edit model) tolerates a much larger
 * context than Flux. We send the full coach payload — diagnosis, recommendations,
 * shot/handedness JSON, raw landmarks, deltas, pro-library landmark gap, plus the
 * non-negotiable invariants block (head/eye freeze, scale lock, padel-vs-tennis,
 * impact lock, hair freeze, equipment inventory, etc.) — same content as the
 * Gemini path.
 */
/** Rough CLIP token estimate (word-based; SDXL CLIP-L ~77 token cap per encoder). */
export function estimateClipTokens(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  return Math.ceil(words.length * 1.28);
}

const SDXL_CLIP_TOKEN_BUDGET = 70;

function truncateToClipBudget(text: string, maxTokens: number): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  const parts: string[] = [];
  let tokens = 0;
  for (const w of words) {
    const wTok = Math.max(1, Math.ceil(w.length / 4));
    if (tokens + wTok > maxTokens) break;
    parts.push(w);
    tokens += wTok;
  }
  return parts.join(" ");
}

/**
 * Compact CLIP prompt for SDXL + IP-Adapter FaceID correction workflow.
 * Keeps coaching signal within ~70 tokens so CLIPTextEncode does not truncate mid-sentence.
 */
export function buildSdxlCorrectionPrompt(
  frameNumber: number,
  deltas: LandmarkDelta[],
  diagnosis: string,
  recommendations: string[],
  shotAndHandedness: ShotAndHandedness | null,
  proReferenceText?: string | null
): string {
  const { shot, handedness } = shotAndHandednessForImagePrompt(shotAndHandedness);
  const topDeltas = deltas.slice(0, 3).map((d) => {
    const dir = d.direction === "increase" ? (d.axis === "x" ? "right" : "down") : d.axis === "x" ? "left" : "up";
    return `${d.landmark} ${dir}`;
  });
  const deltaBit =
    topDeltas.length > 0 ? topDeltas.join(", ") : "subtle pose fix per coach cues";
  const recBit = recommendations
    .slice(0, 2)
    .map((r) => r.replace(/\s+/g, " ").trim())
    .join("; ");
  const diagShort = truncateToClipBudget(diagnosis.replace(/\s+/g, " ").trim(), 18);
  const proShort =
    proReferenceText && proReferenceText.trim().length > 0
      ? truncateToClipBudget(
          proReferenceText.replace(/\s+/g, " ").trim().slice(0, 200),
          12
        )
      : "";

  const parts = [
    `raw amateur sports photo frame ${frameNumber}, unchanged lighting background skin tone`,
    `padel perforated racket not tennis, ${handedness.dominant_hand} ${shot.shot_name}`,
    diagShort ? `fix: ${diagShort}` : "",
    recBit ? `cues: ${recBit}` : "",
    `joints: ${deltaBit}`,
    proShort ? `toward pro: ${proShort}` : "",
    "freeze head gaze identity, adjust limbs only",
  ].filter(Boolean);

  let prompt = parts.join(", ");
  if (estimateClipTokens(prompt) > SDXL_CLIP_TOKEN_BUDGET) {
    const before = prompt;
    prompt = truncateToClipBudget(prompt, SDXL_CLIP_TOKEN_BUDGET);
    console.warn("[correctionPrompt] SDXL CLIP prompt truncated", {
      frame: frameNumber,
      estTokensBefore: estimateClipTokens(before),
      estTokensAfter: estimateClipTokens(prompt),
    });
  }
  return prompt;
}

export type CorrectionPromptIntensity = "coaching" | "subtle";

export function resolveCorrectionPromptIntensity(): CorrectionPromptIntensity {
  const raw = String(process.env.COMFYUI_CORRECTION_INTENSITY ?? "coaching")
    .trim()
    .toLowerCase();
  return raw === "subtle" ? "subtle" : "coaching";
}

export function buildQwenCorrectionPrompt(
  frameNumber: number,
  landmarks: FrameLandmarks,
  deltas: LandmarkDelta[],
  diagnosis: string,
  recommendations: string[],
  shotAndHandedness: ShotAndHandedness | null,
  proReferenceText?: string | null,
  intensity: CorrectionPromptIntensity = resolveCorrectionPromptIntensity(),
  proLandmarks?: FrameLandmarks | null
): string {
  const instructions = deltasToInstructions(deltas, landmarks, proLandmarks);
  const { shot, handedness } = shotAndHandednessForImagePrompt(shotAndHandedness);
  const coaching = intensity === "coaching";

  const topMoves = deltas
    .slice(0, 5)
    .map((d, i) => `${i + 1}. ${formatTopPriorityMove(d, landmarks, proLandmarks)}`)
    .join("\n");

  const proVisualLine =
    proReferenceText && proReferenceText.trim().length > 0
      ? "Visual target: match pro neighbor body geometry at this swing instant (reference image2 + pose guide).\n"
      : "";

  const proBlock =
    proReferenceText && proReferenceText.trim().length > 0
      ? `

=== PRO LIBRARY VISUAL TARGET (highest priority for body pose) ===
The corrected photo must show the same athlete, but with limbs clearly shifted toward this pro reference at the same swing instant — the before/after should make the coaching mistake obvious.
${proVisualLine}${proReferenceText.trim()}
=== END PRO TARGET ===
`
      : "";

  const sceneBlock = `PHOTOREALISTIC PADEL COURT — preserve scene exactly.

Single frame from a padel match. Scene description (this is what the image SHOWS — preserve all of it):
- Enclosed padel court with glass back walls and side walls; the glass shows minor reflections.
- Blue acrylic floor with crisp white service-box and center lines; floor texture and paint match the source frame.
- White net at the center of the court spanning the full width, with its post and tape exactly where they appear in the source frame.
- Same camera angle, same focal length, same daylight/court lighting, same shadows, same background spectators or equipment (if any).
- Same player: identical face, skin tone, hair length/style/color, facial hair, glasses/hat/headband, clothing colors and cut, shoes, and any visible jewelry.
- Same padel racket (perforated solid face, short grip, wrist strap) — NOT a tennis racquet.
- If a ball is visible in the source, it stays in the same location with the same motion blur; if no ball is visible, do not add one.`;

  const taskLead = coaching
    ? `TASK — visible coaching pose correction (teaching before/after).

Clearly adjust limb and racket-arm positions so the athlete's mistake is obvious compared to the source frame. Movement should be noticeable in a side-by-side view — not a subtle polish.`
    : `TASK — small biomechanical pose correction only.

Adjust ONLY the player's body joints with restrained, subtle changes.`;

  const taskBlock = `${taskLead}
When a PRO LIBRARY VISUAL TARGET section is present, prioritize moving limbs toward those pro joint coordinates (knee height, shoulder angle, elbow path, racket-arm path). Coach and pro targets win on conflicting joint moves.
The court, walls, net, floor lines, camera, lighting, clothing, equipment, face, and head pose must come from the source frame unchanged.

TOP PRIORITY MOVES (coach + pro-library merged — apply these visibly):
${topMoves || "(see per-joint list below)"}

COACH DIAGNOSIS:
${diagnosis}

COACH RECOMMENDATIONS:
${recommendations.map((r, i) => `${i + 1}. ${r}`).join("\n")}

SHOT CLASSIFICATION (for context — do not change shot type or handedness):
- family: ${shot.shot_family}
- name: ${shot.shot_name}
- variant: ${shot.variant}
- handedness: ${handedness.dominant_hand}

CURRENT POSE LANDMARKS (normalized 0-1, top-left origin — for spatial reference):
${JSON.stringify(landmarks, null, 2)}

SPECIFIC PER-JOINT ADJUSTMENTS (normalized 0–1 frame coords: current → target; coach + pro merged):
${instructions}

Paint each joint toward its target position in the list above — wrists, elbows, knees, and shoulders should land near the target coordinates while keeping the same athlete and court.`;

  const invariantBlock = `REINFORCEMENT (anchor on the source frame):
- IDENTITY: same player (face, skin, hair, clothing, equipment, dominant hand = ${handedness.dominant_hand}).
- SCENE: same court (glass walls, blue floor, white net + lines), same camera framing and scale, same lighting.
- HEAD & EYE LINE: copy the head pose and gaze direction from the source pixel-for-pixel.
- MOMENT: same stroke instant and same ball-racket relationship as the source — preparation, impact, or follow-through stays the same phase.
- OUTPUT: photorealistic, no overlays, no text, no skeleton lines.`;

  return `${sceneBlock}${proBlock}\n\n${taskBlock}\n\n${invariantBlock}`;
}

const DEFAULT_FAL_CORRECTION_ENDPOINT = "fal-ai/flux-general/image-to-image";

/**
 * Flux image-to-image via fal (optional LoRA from FAL_CORRECTION_LORA_URL).
 * Returns an HTTPS image URL (fal CDN) or null on failure.
 */
export async function generateCorrectedImageFal(
  originalImageBase64: string,
  mimeType: string,
  frameNumber: number,
  landmarks: FrameLandmarks,
  deltas: LandmarkDelta[],
  diagnosis: string,
  recommendations: string[],
  shotAndHandedness?: ShotAndHandedness | null,
  proReferenceText?: string | null
): Promise<string | null> {
  const apiKey = resolveFalKeyForCorrections();
  if (!apiKey) {
    console.error("[CorrectionPrompt] FAL_KEY / FAL_API_KEY missing for fal corrections");
    return null;
  }
  fal.config({ credentials: apiKey });

  const prompt = buildFalCorrectionPrompt(
    frameNumber,
    landmarks,
    deltas,
    diagnosis,
    recommendations,
    shotAndHandedness ?? null,
    proReferenceText ?? null
  );

  let imageUrl: string;
  try {
    const buf = Buffer.from(originalImageBase64, "base64");
    const blob = new Blob([buf], {
      type: mimeType?.startsWith("image/") ? mimeType : "image/png",
    });
    imageUrl = await fal.storage.upload(blob, { lifecycle: { expiresIn: "1h" } });
  } catch (e) {
    console.error("[CorrectionPrompt] fal.storage upload failed", e);
    return null;
  }

  const loraUrl = String(process.env.FAL_CORRECTION_LORA_URL || "").trim();
  const loraScaleRaw = Number(process.env.FAL_CORRECTION_LORA_SCALE ?? "0.85");
  const loras =
    loraUrl.length > 0
      ? [
          {
            path: loraUrl,
            scale: Number.isFinite(loraScaleRaw) ? loraScaleRaw : 0.85,
          },
        ]
      : [];

  /** Lower = stay closer to source (img2img). Defaults tuned for subtle pose nudges, not full scene redraw. */
  const strengthRaw = Number(process.env.FAL_CORRECTION_STRENGTH ?? "0.38");
  const stepsRaw = Number(process.env.FAL_CORRECTION_STEPS ?? "22");
  const guidanceRaw = Number(process.env.FAL_CORRECTION_GUIDANCE_SCALE ?? "2.6");
  const strength = Number.isFinite(strengthRaw)
    ? Math.min(1, Math.max(0.05, strengthRaw))
    : 0.38;
  const num_inference_steps = Number.isFinite(stepsRaw)
    ? Math.max(10, Math.min(50, Math.round(stepsRaw)))
    : 22;
  const guidance_scale = Number.isFinite(guidanceRaw)
    ? Math.min(6, Math.max(1, guidanceRaw))
    : 2.6;

  const endpoint =
    String(process.env.FAL_CORRECTION_FLUX_ENDPOINT || "").trim() ||
    DEFAULT_FAL_CORRECTION_ENDPOINT;

  const inputPayload: Record<string, unknown> = {
    prompt,
    image_url: imageUrl,
    strength,
    num_inference_steps,
    guidance_scale,
    output_format: "png",
    enable_safety_checker: true,
    ...(loras.length ? { loras } : {}),
  };

  try {
    let raw: { images?: Array<{ url?: string }>; data?: { images?: Array<{ url?: string }> } };
    try {
      raw = (await fal.subscribe(endpoint, {
        input: inputPayload,
        logs: false,
      })) as typeof raw;
    } catch (e: unknown) {
      if (!shouldFallbackSubscribeToRun(e)) throw e;
      console.warn("[CorrectionPrompt] fal.subscribe failed (network); retrying fal.run sync", {
        endpoint,
        message: e instanceof Error ? e.message : String(e),
        hostname: getErrHostname(e),
        code: getNetworkErrorCode(e),
      });
      raw = (await fal.run(endpoint, {
        input: inputPayload,
      })) as typeof raw;
    }

    const url =
      raw?.images?.[0]?.url ?? raw?.data?.images?.[0]?.url;
    if (!url) {
      console.error("[CorrectionPrompt] fal returned no image url", {
        endpoint,
        keys: raw && typeof raw === "object" ? Object.keys(raw as object) : [],
      });
      return null;
    }
    return url;
  } catch (e: any) {
    console.error("[CorrectionPrompt] fal img2img failed", {
      endpoint,
      message: e?.message,
      cause: e?.cause,
    });
    return null;
  }
}
