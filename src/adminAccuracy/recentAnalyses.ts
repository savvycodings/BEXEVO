import { pool } from "../db";

export type RecentAnalysisRow = {
  id: string;
  createdAt: Date;
  metrics: Record<string, unknown> | null;
};

export async function fetchRecentCompletedAnalyses(
  limit: number
): Promise<RecentAnalysisRow[]> {
  const { rows } = await pool.query<{
    id: string;
    createdAt: Date;
    metrics: Record<string, unknown> | null;
  }>(
    `
    SELECT id, "createdAt", metrics
    FROM technique_analysis
    WHERE status = 'completed' AND metrics IS NOT NULL
    ORDER BY "createdAt" DESC
    LIMIT $1
    `,
    [limit]
  );
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt,
    metrics: r.metrics,
  }));
}

export async function countCompletedInLastDays(days: number): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `
    SELECT COUNT(*)::int AS n
    FROM technique_analysis
    WHERE status = 'completed'
      AND "createdAt" >= NOW() - ($1::int || ' days')::interval
    `,
    [days]
  );
  return rows[0]?.n ?? 0;
}
