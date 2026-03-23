const GEMINI_API_BASE =
  "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_MODEL = "gemini-2.5-flash-image";

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

export async function classifyShotAndHandedness(
  recommendations: string[],
  diagnosis: string,
  landmarks: FrameLandmarks
): Promise<ShotAndHandedness> {
  const prompt = `You are a world-class padel biomechanics classifier.

Classify the shot using body movement + context (not name-only), and infer dominant handedness.

COACH DIAGNOSIS:
${diagnosis}

COACH RECOMMENDATIONS:
${recommendations.map((r, i) => `${i + 1}. ${r}`).join("\n")}

CURRENT LANDMARKS:
${JSON.stringify(landmarks, null, 2)}

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
- Preserve left-handed interpretation if evidence indicates left dominance.
- Do NOT use camera-left/camera-right as forehand/backhand by itself.
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
  landmarks: FrameLandmarks
): Promise<LandmarkDelta[]> {
  const prompt = `You are a sports biomechanics expert. Given these padel coach recommendations and the player's current body landmark positions (normalized 0-1, origin top-left of video frame), output a JSON array of specific landmark adjustments needed.

COACH DIAGNOSIS:
${diagnosis}

COACH RECOMMENDATIONS:
${recommendations.map((r, i) => `${i + 1}. ${r}`).join("\n")}

CURRENT LANDMARKS:
${JSON.stringify(landmarks, null, 2)}

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
  const shot = shotAndHandedness?.shot ?? DEFAULT_SHOT_AND_HANDEDNESS.shot;
  const handedness =
    shotAndHandedness?.handedness ?? DEFAULT_SHOT_AND_HANDEDNESS.handedness;

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

The result must look like a real photograph of the same person in the same environment, just with improved body mechanics. Do NOT change clothing, face, court, or surroundings. Do NOT add text, labels, or overlays.`;

  const invariantBlock = `
NON-NEGOTIABLE INVARIANTS:
1) Preserve player identity, clothing, court, camera angle, and lighting.
2) Preserve dominant hand exactly (${handedness.dominant_hand}); do NOT mirror left/right body mechanics.
3) Keep the racket visible and attached to the dominant-hand side.
4) Interpret forehand/backhand from player orientation (player-centric), not image left/right.
5) Only modify biomechanical posture needed for corrections; keep all other details unchanged.
6) Do not add text, labels, watermarks, skeleton overlays, or extra objects.`;

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
  const response = await fetch(
    `${GEMINI_API_BASE}/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          responseModalities: ["IMAGE"],
        },
      }),
    }
  );

  const data = (await response.json()) as any;
  const responseParts = data?.candidates?.[0]?.content?.parts || [];

  const imagePart = responseParts.find((part: any) => {
    const inlineData = part?.inlineData || part?.inline_data;
    return inlineData?.data;
  });

  const inlineData = imagePart?.inlineData || imagePart?.inline_data;
  if (!inlineData?.data) {
    console.error(
      "[CorrectionPrompt] Gemini returned no image for frame",
      frameNumber,
      JSON.stringify(data).slice(0, 500)
    );
    return null;
  }

  const outMime =
    inlineData.mimeType || inlineData.mime_type || "image/png";
  return `data:${outMime};base64,${inlineData.data}`;
}
