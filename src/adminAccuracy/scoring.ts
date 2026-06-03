import { ACCURACY_PASS_PERCENT } from "./constants";

export function normalizeShotLabel(label: string | null | undefined): string {
  return (label ?? "").trim().toLowerCase();
}

export function labelsMatch(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  const x = normalizeShotLabel(a);
  const y = normalizeShotLabel(b);
  return x.length > 0 && x === y;
}

export function percentFromRatio(ok: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((ok / total) * 100);
}

export function passedFromScore(scorePercent: number): boolean {
  return scorePercent >= ACCURACY_PASS_PERCENT;
}

export type TestRunResult = {
  scorePercent: number;
  passed: boolean;
  summary: string;
  detail: Record<string, unknown>;
};

export function buildTestRun(
  ok: number,
  total: number,
  summaryWhenEmpty: string,
  detail: Record<string, unknown>
): TestRunResult {
  const scorePercent = percentFromRatio(ok, total);
  return {
    scorePercent,
    passed: passedFromScore(scorePercent),
    summary:
      total === 0
        ? summaryWhenEmpty
        : `${ok}/${total} passed (${scorePercent}%)`,
    detail: { ...detail, ok, total, scorePercent },
  };
}
