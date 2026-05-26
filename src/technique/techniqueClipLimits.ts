import type { ClipMsRange } from "./impactPoseContext";

export const MAX_USER_CLIP_MS = 3000;
export const MIN_USER_CLIP_MS = 500;

export function sanitizeUserClips(
  raw: Array<{ startMs?: unknown; endMs?: unknown }> | undefined,
  videoDurationMs: number
): ClipMsRange[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const total = Math.max(0, Math.round(videoDurationMs));
  if (total <= 0) return undefined;

  const out: ClipMsRange[] = [];
  for (const c of raw) {
    const startRaw = Number(c.startMs);
    const endRaw = Number(c.endMs);
    if (!Number.isFinite(startRaw) || !Number.isFinite(endRaw)) continue;

    let end = Math.round(Math.max(0, Math.min(total, endRaw)));
    let start = Math.round(Math.max(0, Math.min(end, startRaw)));
    if (end - start < MIN_USER_CLIP_MS) {
      start = Math.max(0, end - MIN_USER_CLIP_MS);
      if (end - start < MIN_USER_CLIP_MS) end = Math.min(total, start + MIN_USER_CLIP_MS);
    }
    if (end - start > MAX_USER_CLIP_MS) {
      start = end - MAX_USER_CLIP_MS;
    }
    if (end > start) out.push({ startMs: start, endMs: end });
  }
  return out.length > 0 ? out : undefined;
}
