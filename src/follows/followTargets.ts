/** Follow targets the API accepts today. The table stores any text type, so more can be added. */
export const FOLLOW_TARGET_TYPES = ["coach", "country"] as const;
export type FollowTargetType = (typeof FOLLOW_TARGET_TYPES)[number];

export type FollowTarget = { targetType: FollowTargetType; targetId: string };
export type FollowTargetError = "bad_target_type" | "bad_target_id";

/**
 * Validates and normalizes a follow target from the URL. Coaches take any non-empty user id
 * (existence and role are checked against the database by the router); countries take a
 * two-letter ISO 3166-1 alpha-2 code, returned uppercase.
 */
export function normalizeTarget(
  type: unknown,
  id: unknown
): { ok: true; target: FollowTarget } | { ok: false; error: FollowTargetError } {
  const t = typeof type === "string" ? type.trim().toLowerCase() : "";
  const raw = typeof id === "string" ? id.trim() : "";
  if (t === "coach") {
    if (!raw) return { ok: false, error: "bad_target_id" };
    return { ok: true, target: { targetType: "coach", targetId: raw } };
  }
  if (t === "country") {
    if (!/^[a-z]{2}$/i.test(raw)) return { ok: false, error: "bad_target_id" };
    return { ok: true, target: { targetType: "country", targetId: raw.toUpperCase() } };
  }
  return { ok: false, error: "bad_target_type" };
}
