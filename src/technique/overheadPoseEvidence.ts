export type PoseLandmarkFrame = {
  frame?: number;
  landmarks?: Record<string, { x: number; y: number }>;
};

export type OverheadPoseEvidence = {
  supportsOverhead: boolean;
  confidence: number;
  validFrames: number;
  overheadFrames: number;
};

function getY(landmarks: Record<string, { x: number; y: number }>, key: string): number | null {
  const value = landmarks?.[key]?.y;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function summarizeOverheadEvidence(
  poseData: PoseLandmarkFrame[]
): OverheadPoseEvidence {
  let validFrames = 0;
  let overheadFrames = 0;

  for (const frame of poseData) {
    const landmarks = frame?.landmarks;
    if (!landmarks || typeof landmarks !== "object") continue;

    const leftShoulderY = getY(landmarks, "LEFT_SHOULDER");
    const rightShoulderY = getY(landmarks, "RIGHT_SHOULDER");
    const leftWristY = getY(landmarks, "LEFT_WRIST");
    const rightWristY = getY(landmarks, "RIGHT_WRIST");
    const leftElbowY = getY(landmarks, "LEFT_ELBOW");
    const rightElbowY = getY(landmarks, "RIGHT_ELBOW");
    const noseY = getY(landmarks, "NOSE");

    const shoulderCandidates = [leftShoulderY, rightShoulderY].filter(
      (v): v is number => typeof v === "number"
    );
    const wristCandidates = [leftWristY, rightWristY].filter(
      (v): v is number => typeof v === "number"
    );

    if (shoulderCandidates.length === 0 || wristCandidates.length === 0) continue;

    validFrames += 1;

    const shoulderY = shoulderCandidates.reduce((a, b) => a + b, 0) / shoulderCandidates.length;
    const highestWristY = Math.min(...wristCandidates);

    const aboveShoulder = highestWristY < shoulderY - 0.06;
    const nearOrAboveHead = typeof noseY === "number" ? highestWristY < noseY + 0.08 : true;
    const extendedArm =
      (typeof leftWristY === "number" &&
        typeof leftElbowY === "number" &&
        leftWristY < leftElbowY - 0.02) ||
      (typeof rightWristY === "number" &&
        typeof rightElbowY === "number" &&
        rightWristY < rightElbowY - 0.02);

    if (aboveShoulder && nearOrAboveHead && extendedArm) {
      overheadFrames += 1;
    }
  }

  const confidence = validFrames > 0 ? overheadFrames / validFrames : 0;
  const supportsOverhead = overheadFrames >= 2 && confidence >= 0.35;
  return { supportsOverhead, confidence, validFrames, overheadFrames };
}

export function overheadEvidenceFromMetrics(
  metrics: Record<string, unknown> | null | undefined
): OverheadPoseEvidence {
  const poseData = metrics?.pose_data;
  if (!Array.isArray(poseData)) {
    return { supportsOverhead: false, confidence: 0, validFrames: 0, overheadFrames: 0 };
  }
  return summarizeOverheadEvidence(poseData as PoseLandmarkFrame[]);
}
