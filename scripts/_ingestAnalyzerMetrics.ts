/**
 * Turns a raw Modal analyzer response into the metrics shape the technique route stores, with
 * the same steps `POST /technique/analyze` runs: YOLO normalization and summary, racket/ball
 * boxes merged into `pose_data`, and the contact frame resolved over the user's clip. No DB.
 *
 * Usage:
 *   npx tsx scripts/_ingestAnalyzerMetrics.ts <analyzer-response.json> <video.mp4> <out.json> \
 *     [--clip startMs-endMs] [--shot forehand_volley] [--hand right] [--hands hands.json]
 *
 * --hands merges 21-point hands from FAXevo/comfyui-deploy/extract_hands.py into each pose row
 * as LEFT_HAND_0..20 / RIGHT_HAND_0..20, each matched to the nearer MediaPipe wrist.
 */
import "dotenv/config";
import fs from "fs";
import {
  applyUserClipImpactToMetrics,
  resolveVideoDurationMsForImpact,
} from "../src/technique/impactPoseContext";
import { sanitizeUserClips } from "../src/technique/techniqueClipLimits";
import {
  YOLO_BALL_CONFIDENCE,
  YOLO_DETECTION_CONFIDENCE,
  YOLO_RACKET_CONFIDENCE,
  enrichPoseDataWithRacket,
  normalizeYoloDetections,
  summarizeDetections,
} from "../src/technique/techniqueRouter";
import { execFileSync } from "child_process";
import ffmpegStatic from "ffmpeg-static";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Container duration in ms, from ffmpeg's stream banner (ffmpeg-static ships no ffprobe). */
function durationMs(video: string): number {
  let banner = "";
  try {
    execFileSync(ffmpegStatic || "ffmpeg", ["-hide_banner", "-i", video], { stdio: "pipe" });
  } catch (e: any) {
    banner = String(e.stderr ?? "");
  }
  const m = banner.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) throw new Error(`no duration in ffmpeg output for ${video}`);
  return Math.round((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000);
}

async function main() {
  const [inPath, video, outPath] = process.argv.slice(2);
  if (!inPath || !video || !outPath) throw new Error("usage: <response.json> <video.mp4> <out.json>");
  const raw = JSON.parse(fs.readFileSync(inPath, "utf8"));
  let metrics: any = raw.metrics ?? raw;

  const fileMs = durationMs(video);
  const vdur = resolveVideoDurationMsForImpact(fileMs, metrics.total_frames ?? 0, metrics.pose_data);
  if (!vdur) throw new Error("could not resolve video duration");
  const clipArg = arg("--clip")?.match(/^(\d+)-(\d+)$/);
  const clips = sanitizeUserClips(
    [{ startMs: clipArg ? Number(clipArg[1]) : 0, endMs: clipArg ? Number(clipArg[2]) : vdur }],
    vdur
  );

  const detections = normalizeYoloDetections(
    metrics.yolo_detections,
    metrics.total_frames,
    vdur,
    YOLO_DETECTION_CONFIDENCE,
    YOLO_RACKET_CONFIDENCE,
    YOLO_BALL_CONFIDENCE
  );
  const summary = summarizeDetections(
    detections,
    metrics.yolo_summary?.sampled_frames,
    true,
    YOLO_DETECTION_CONFIDENCE,
    YOLO_RACKET_CONFIDENCE,
    YOLO_BALL_CONFIDENCE
  );
  metrics = {
    ...metrics,
    video_duration_ms: vdur,
    video_duration_ms_source: "client",
    user_clips: clips,
    pose_data: enrichPoseDataWithRacket(metrics.pose_data, detections) ?? metrics.pose_data,
    detection_summary: summary,
  };
  const impact = applyUserClipImpactToMetrics(metrics, clips ?? [], vdur);
  if (impact) {
    metrics = {
      ...metrics,
      impact_pose_sequence: impact.impact_pose_sequence ?? undefined,
      impact_frame_resolved: impact.impact_frame_resolved,
      impact_frame_source: impact.impact_frame_source,
    };
  }
  const shot = arg("--shot");
  if (shot) {
    metrics.user_shot = { strokePreset: shot, shotLabel: shot.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()), viewId: "front", category: "net_play", skillLevel: "" };
  }
  const handsPath = arg("--hands");
  if (handsPath) {
    const handsData = JSON.parse(fs.readFileSync(handsPath, "utf8"));
    const byFrame = new Map<number, any[]>(handsData.frames.map((f: any) => [f.frame, f.hands]));
    let merged = 0;
    for (const row of metrics.pose_data ?? []) {
      const lm = row.landmarks;
      const hands = byFrame.get(row.frame);
      if (!lm || !hands) continue;
      // Match by distance from the hand's wrist point to each MediaPipe wrist; DWPose's own
      // left/right label is not trusted. One hand per wrist, the nearer one wins.
      const best: Record<string, { d: number; pts: number[][] }> = {};
      for (const h of hands) {
        const pts: number[][] = h.points;
        const score = pts.reduce((s2, q) => s2 + q[2], 0) / pts.length;
        if (score < 0.3) continue;
        for (const side of ["LEFT", "RIGHT"]) {
          const w = lm[`${side}_WRIST`];
          if (!w) continue;
          const d = Math.hypot(pts[0]![0]! - w.x, pts[0]![1]! - w.y);
          if (d > 0.08) continue;
          if (!best[side] || d < best[side]!.d) best[side] = { d, pts };
        }
      }
      if (best.LEFT && best.RIGHT && best.LEFT.pts === best.RIGHT.pts) {
        delete best[best.LEFT.d <= best.RIGHT.d ? "RIGHT" : "LEFT"];
      }
      for (const [side, { pts }] of Object.entries(best)) {
        pts.forEach((q, i) => {
          lm[`${side}_HAND_${i}`] = { x: q[0], y: q[1], visibility: q[2] };
        });
        merged++;
      }
    }
    console.log(`merged ${merged} hands from ${handsPath}`);
  }
  const hand = arg("--hand");
  if (hand) metrics.stroke_side = { ...(metrics.stroke_side ?? {}), dominant_hand: hand };
  delete metrics.yolo_detections;
  delete metrics.yolo_summary;
  delete metrics.pose_enrichment;

  fs.writeFileSync(outPath, JSON.stringify(metrics));
  const balls = metrics.pose_data.filter((r: any) => r.ball_bbox).length;
  const rackets = metrics.pose_data.filter((r: any) => r.racket_bbox).length;
  console.log(
    `${outPath}: frames=${metrics.total_frames} duration=${vdur}ms fps=${((metrics.total_frames * 1000) / vdur).toFixed(1)} ` +
      `impact=${metrics.impact_frame_resolved} (${metrics.impact_frame_source}) contacts=${JSON.stringify(summary.contact_window_frames)} ` +
      `ballRows=${balls} racketRows=${rackets}`
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
