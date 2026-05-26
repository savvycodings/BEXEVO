/** Human-facing train shot title (admin catalog label), not enum preset. */

const TRAIN_LEVEL_SUFFIXES = new Set(["Beginner", "Intermediate", "Advanced"]);

export function adminStrokeLabelKey(
  strokeLabel: string | null | undefined,
  strokeName: string
): string {
  const fromCol = (strokeLabel ?? "").trim();
  if (fromCol) return fromCol;
  const parts = strokeName.split(" · ");
  if (parts.length >= 2 && TRAIN_LEVEL_SUFFIXES.has(parts[parts.length - 1] ?? "")) {
    return parts.slice(0, -1).join(" · ").trim();
  }
  return strokeName.trim();
}
