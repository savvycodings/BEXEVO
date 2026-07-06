export type CoachAnnotationRow = {
  imageUri: string;
  comment: string;
  timeMs: number;
  cloudinaryUrl: string | null;
  tone: "good" | "wrong" | null;
};

export type CoachAnnotationTableRow = {
  imageUri: string;
  cloudinaryUrl: string | null;
  comment: string | null;
  timeMs: number;
  tone?: string | null;
};

function isSafeImageUri(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const s = value.trim();
  if (!s) return false;
  if (/^https?:\/\//i.test(s)) return true;
  if (/^\/uploads\//i.test(s)) return true;
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(s)) return true;
  return false;
}

export function parseAnnotationTone(value: unknown): "good" | "wrong" | null {
  return value === "good" || value === "wrong" ? value : null;
}

export function normalizeCoachAnnotations(input: unknown): CoachAnnotationRow[] {
  if (!Array.isArray(input)) return [];
  return input
    .slice(0, 40)
    .map((row) => {
      const r = row as Record<string, unknown>;
      const imageUri = isSafeImageUri(r.imageUri) ? String(r.imageUri).trim() : "";
      const commentRaw = typeof r.comment === "string" ? r.comment.trim() : "";
      const comment = commentRaw.slice(0, 1200);
      const timeMsRaw = r.timeMs;
      const timeMs =
        typeof timeMsRaw === "number" && Number.isFinite(timeMsRaw)
          ? Math.max(0, Math.round(timeMsRaw))
          : 0;
      const cloudinaryUrl =
        typeof r.cloudinaryUrl === "string" && /^https?:\/\//i.test(r.cloudinaryUrl.trim())
          ? r.cloudinaryUrl.trim()
          : null;
      const tone = parseAnnotationTone(r.tone);
      if (!imageUri && !comment) return null;
      return { imageUri, comment, timeMs, cloudinaryUrl, tone };
    })
    .filter((r): r is CoachAnnotationRow => r !== null);
}

/** Prefer review JSON (includes tone); fall back to annotation table rows. */
export function coachMarksForClient(
  coachMarksJson: unknown,
  tableRows: CoachAnnotationTableRow[]
): CoachAnnotationRow[] {
  const fromJson = normalizeCoachAnnotations(coachMarksJson);
  if (fromJson.length > 0) return fromJson;
  return tableRows
    .map((a) => {
      const imageUri = typeof a.imageUri === "string" ? a.imageUri.trim() : "";
      const comment = typeof a.comment === "string" ? a.comment.trim() : "";
      const tone = parseAnnotationTone(a.tone);
      if (!imageUri && !comment) return null;
      return {
        imageUri,
        cloudinaryUrl: a.cloudinaryUrl ?? null,
        comment,
        timeMs: a.timeMs,
        tone,
      };
    })
    .filter((r): r is CoachAnnotationRow => r !== null);
}

export function commentTonesForReview(
  coachMarksJson: unknown,
  annotationRowCount: number
): { goodCount: number; badCount: number } {
  const marks = normalizeCoachAnnotations(coachMarksJson);
  let goodCount = 0;
  let badCount = 0;
  for (const m of marks) {
    if (m.tone === "good") goodCount += 1;
    else if (m.tone === "wrong") badCount += 1;
  }
  if (goodCount + badCount > 0) {
    return { goodCount, badCount };
  }
  if (annotationRowCount > 0) {
    return { goodCount: annotationRowCount, badCount: 0 };
  }
  return { goodCount: 0, badCount: 0 };
}
