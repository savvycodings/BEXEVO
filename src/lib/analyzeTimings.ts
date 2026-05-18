/**
 * Lightweight phase timer for long-running /technique/analyze steps.
 * Logs one line per phase so you can see what ate the wall clock.
 */

export type AnalyzePhase =
  | "fal_staging"
  | "modal"
  | "yolo_persist"
  | "retrieval"
  | "llm_prompt"
  | "llm_call"
  | "db_update"
  | "total";

export function createAnalyzeTimer(analysisId: string) {
  const t0 = Date.now();
  const phases: Array<{ phase: AnalyzePhase; ms: number; extra?: Record<string, unknown> }> =
    [];

  function mark(phase: AnalyzePhase, extra?: Record<string, unknown>) {
    const ms = Date.now() - t0;
    phases.push({ phase, ms, extra });
    const extraStr =
      extra && Object.keys(extra).length > 0
        ? ` ${JSON.stringify(extra)}`
        : "";
    console.log(`[Technique][timing] ${analysisId} ${phase} +${ms}ms${extraStr}`);
  }

  function summary() {
    const totalMs = Date.now() - t0;
    console.log(`[Technique][timing] ${analysisId} SUMMARY total=${totalMs}ms`, {
      phases: phases.map((p) => ({ ...p, ms: p.ms })),
    });
    return totalMs;
  }

  return { mark, summary, elapsed: () => Date.now() - t0 };
}

/** Drop heavy pose arrays when persisting a failed row (avoids multi-MB UPDATE timeouts). */
export function slimMetricsForFailedPersist(metrics: Record<string, unknown>): Record<string, unknown> {
  const poseCount = Array.isArray(metrics.pose_data) ? metrics.pose_data.length : 0;
  return {
    total_frames: metrics.total_frames,
    analyzed_frames: metrics.analyzed_frames,
    video_duration_ms: metrics.video_duration_ms,
    detection_summary: metrics.detection_summary,
    retrieval: metrics.retrieval
      ? {
          shot_hypothesis: (metrics.retrieval as any)?.shot_hypothesis,
          neighbors: Array.isArray((metrics.retrieval as any)?.neighbors)
            ? (metrics.retrieval as any).neighbors.slice(0, 3)
            : undefined,
        }
      : undefined,
    impact_pose_sequence: metrics.impact_pose_sequence,
    pose_data_omitted_on_failed: true,
    pose_frame_count: poseCount,
  };
}
