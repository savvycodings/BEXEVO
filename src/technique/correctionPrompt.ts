import type { LabeledPoseFrame } from "./impactPoseContext";

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

/** When true, image correction assumes right-handed striker (override classifier). Replace with profile-backed hand later. */
export const CORRECTION_IMAGES_ASSUME_RIGHT_HANDED = true;

/** Shot classification from GPT + dominant hand used for Gemini (may be forced right-handed). */
export function mergeCorrectionShotAndHandedness(
  classified: ShotAndHandedness | null
): ShotAndHandedness {
  const shot = classified?.shot ?? DEFAULT_SHOT_AND_HANDEDNESS.shot;
  const handedness = CORRECTION_IMAGES_ASSUME_RIGHT_HANDED
    ? {
        dominant_hand: "right-handed" as const,
        confidence: 1,
        evidence: ["assumed_right_handed_for_correction_image"],
      }
    : classified?.handedness ?? DEFAULT_SHOT_AND_HANDEDNESS.handedness;
  return { shot, handedness };
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

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You classify padel movement and handedness from biomechanics. Respond only with strict JSON.",
        },
        { role: "user", content: prompt },
      ],
    }),
  }).then((r) => r.json() as any);

  const content = res?.choices?.[0]?.message?.content;
  if (!content) {
    console.error("[CorrectionPrompt] Shot classification returned no content", res);
    return DEFAULT_SHOT_AND_HANDEDNESS;
  }

  try {
    const parsed = JSON.parse(content) as Partial<ShotAndHandedness>;
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

Respond ONLY with a valid JSON array matching this schema:
[
  {
    "landmark": "LEFT_ANKLE",
    "axis": "x",
    "direction": "decrease",
    "magnitude": "moderate",
    "reason": "wider stance for stability"
  }
]

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

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are a biomechanics assistant. Always respond with a JSON object containing a 'deltas' array.",
        },
        { role: "user", content: prompt },
      ],
    }),
  }).then((r) => r.json() as any);

  const content = res?.choices?.[0]?.message?.content;
  if (!content) {
    console.error("[CorrectionPrompt] GPT returned no content", res);
    return [];
  }

  try {
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : parsed.deltas ?? [];
  } catch {
    console.error("[CorrectionPrompt] Failed to parse GPT deltas", content);
    return [];
  }
}

function deltasToInstructions(deltas: LandmarkDelta[]): string {
  if (deltas.length === 0) return "Apply the coach's recommendations to correct the player's body positioning.";

  return deltas
    .map((d) => {
      const dirWord = d.direction === "increase" ? "move right/lower" : "move left/higher";
      const axisWord = d.axis === "x" ? "horizontally" : "vertically";
      return `- ${d.landmark}: ${dirWord} ${axisWord} (${d.magnitude}) — ${d.reason}`;
    })
    .join("\n");
}

export async function generateCorrectedImage(
  originalImageBase64: string,
  mimeType: string,
  frameNumber: number,
  landmarks: FrameLandmarks,
  deltas: LandmarkDelta[],
  diagnosis: string,
  recommendations: string[],
  shotAndHandedness?: ShotAndHandedness | null
): Promise<string | null> {
  const instructions = deltasToInstructions(deltas);
  const { shot, handedness } = mergeCorrectionShotAndHandedness(
    shotAndHandedness ?? null
  );

  const textPrompt = `You are a sports visualization engine that creates photorealistic corrected-pose images for athletes.

I am providing you with a single frame (frame ${frameNumber}) from a Padel tennis video.

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

TASK:
Regenerate this EXACT image — same person, same clothing, same court, same camera angle, same lighting, same background — but adjust ONLY the player's body position to reflect the corrections above.

Keep the player anchored in the same spot on the court and in the frame: small joint and posture fixes only — do NOT move or "teleport" the athlete to another side of the court, another zone, or a different place in the image (that breaks alignment with the original for comparison views).

Preserve the SAME moment of play as the source: if the player is reaching overhead, tracking upward, or preparing a specific stroke, keep that action — do NOT re-stage them into a different phase (e.g. neutral "ready" stance, waiting for serve, or relaxed waiting). Keep racket height intent and body lean consistent with the stroke.

HEAD AND EYE LINE (source of truth): Copy the head, neck, face, and apparent eye direction from the source frame exactly — do NOT rotate or tilt the head, redirect the gaze, lift the chin, or "fix" where they are looking. They are already tracking the ball; treat head/eye line as fixed and apply corrections to shoulders, torso, arms, hips, and legs only.

IMPACT / CONTACT: If the source shows the ball at or near the racket, mid-swing, motion blur, or the hitting moment, you MUST keep that same impact instant — this product teaches how to strike the ball better, not a generic stance. Refine joint angles and posture only; do NOT replace a dynamic hit with a passive "waiting for the ball" pose. Preserve ball–racket relationship when both appear, and preserve the sense of motion (blur) if present.

OVERHEAD / SWING ARC (critical): If the source shows preparation for an overhead (smash, bandeja, high volley prep) — e.g. body leaning back, racket loaded behind the head or shoulders, non-hitting arm up for balance/tracking, eyes on an incoming ball above — you MUST keep that full athletic arc and loading. Do NOT collapse this into an upright "the ball has not arrived yet" or neutral ready stance with the racket low or parked in front. The player must still be arcing to strike, not passively waiting for play to start.

COURT FLOOR: Do NOT add, extend, remove, or redraw white lines, service boxes, T-lines, or any painted markings on the blue court. The visible floor graphics must match the source; never hallucinate extra line art on the surface.

SCALE AND FRAMING: Match the source image's zoom and composition exactly — the player must NOT appear larger, smaller, closer, or farther from the camera. Same apparent size in the frame (height/width footprint) as the reference; no crop change, no digital zoom, no "hero shot" enlargement. This is required for side-by-side before/after alignment.

The result must look like a real photograph of the same individual in the same environment, just with improved body mechanics. Hair is frozen to the source: same length, cut, and volume — never lengthen, restyle, or add flowing hair. Match the reference frame for face, hair, apparent age, body build, and gender presentation — do not gender-swap, de-age, "beautify," or change hair length or hairstyle (e.g. short hair must remain short). Do NOT change clothing, face identity, court, or surroundings. Do NOT add or remove the padel racket or the ball — if there is no ball in the source frame, the output must not show a ball. Do NOT add text, labels, or overlays.`;

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
12) PADEL RACKET AND BALL — Do not add or remove equipment. If the source frame has no visible ball, do NOT add a ball. If a ball is visible, keep it (do not erase it). If the padel racket is not in the frame, do NOT add one; if it is visible, do NOT remove it or replace it with a different racket. Only adjust pose; equipment inventory must match the source image.
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
