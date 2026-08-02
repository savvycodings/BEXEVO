import { db, techniqueAnalysis, techniqueVideo } from "../db";
import { eq } from "drizzle-orm";
import { poseDataForOverlayFetch } from "../technique/poseOverlay";
import { getTrainSamplePoseSequence } from "../technique/trainRetrieval";

export type BenchMatchPreviewClip = {
  label: string;
  videoUrl: string;
  pose_data: Record<string, unknown>[];
  total_frames: number;
  video_duration_ms: number | null;
};

export type BenchMatchPreview = {
  analysisId: string;
  user: BenchMatchPreviewClip;
  match: (BenchMatchPreviewClip & {
    train_sample_id: string;
    train_video_id: string;
    stroke_label: string;
    distance: number | null;
  }) | null;
};

function absolutePublicUrl(pathOrUrl: string): string {
  if (pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://")) return pathOrUrl;
  const publicVideoBase = (process.env.PUBLIC_VIDEO_BASE_URL || "").trim();
  const publicBase = (process.env.PUBLIC_BASE_URL || "").trim();
  const authBase = (process.env.BETTER_AUTH_URL || "").trim();
  const baseUrl = publicVideoBase || publicBase || authBase;
  if (!baseUrl) return pathOrUrl;
  const path = pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`;
  return `${baseUrl.replace(/\/$/, "")}${path}`;
}

function userVideoUrl(secureUrl: string | null, cloudinaryPublicId: string | null): string {
  if (secureUrl?.startsWith("http")) return secureUrl;
  const path = secureUrl || `/technique/video/${cloudinaryPublicId}`;
  return absolutePublicUrl(path);
}

function resolveTopNeighbor(metrics: Record<string, unknown>): {
  trainSampleId: string;
  trainVideoId: string | null;
  strokeLabel: string;
  distance: number | null;
} | null {
  const retrieval = metrics.retrieval as Record<string, unknown> | undefined;
  const neighbors = Array.isArray(retrieval?.neighbors) ? retrieval!.neighbors : [];
  const top = neighbors[0] as Record<string, unknown> | undefined;
  if (top && typeof top.train_sample_id === "string" && top.train_sample_id.trim()) {
    return {
      trainSampleId: top.train_sample_id.trim(),
      trainVideoId:
        typeof top.train_video_id === "string" && top.train_video_id.trim()
          ? top.train_video_id.trim()
          : null,
      strokeLabel:
        typeof top.stroke_label === "string" && top.stroke_label.trim()
          ? top.stroke_label.trim()
          : typeof top.stroke_name === "string" && top.stroke_name.trim()
            ? top.stroke_name.trim()
            : "Pro match",
      distance:
        typeof top.distance === "number" && Number.isFinite(top.distance) ? top.distance : null,
    };
  }

  // Fallback: eval snapshot top_k (may lack train_video_id).
  const evalSnap = retrieval?.eval as Record<string, unknown> | undefined;
  const topK = Array.isArray(evalSnap?.top_k_neighbors) ? evalSnap!.top_k_neighbors : [];
  const ev = topK[0] as Record<string, unknown> | undefined;
  if (ev && typeof ev.train_sample_id === "string" && ev.train_sample_id.trim()) {
    return {
      trainSampleId: ev.train_sample_id.trim(),
      trainVideoId:
        typeof ev.train_video_id === "string" && ev.train_video_id.trim()
          ? ev.train_video_id.trim()
          : null,
      strokeLabel:
        typeof ev.stroke_label === "string" && ev.stroke_label.trim()
          ? ev.stroke_label.trim()
          : "Pro match",
      distance:
        typeof ev.distance === "number" && Number.isFinite(ev.distance) ? ev.distance : null,
    };
  }
  return null;
}

/**
 * Admin-only preview: user analysis video + dense pose, and matched pro-library clip + pose.
 * Lets trainers see what the retrieval / overlay pipeline sees.
 */
export async function getBenchMatchPreview(analysisId: string): Promise<BenchMatchPreview | null> {
  const id = analysisId?.trim();
  if (!id) return null;

  const rows = await db
    .select({
      id: techniqueAnalysis.id,
      metrics: techniqueAnalysis.metrics,
      secureUrl: techniqueVideo.secureUrl,
      cloudinaryPublicId: techniqueVideo.cloudinaryPublicId,
    })
    .from(techniqueAnalysis)
    .innerJoin(techniqueVideo, eq(techniqueAnalysis.techniqueVideoId, techniqueVideo.id))
    .where(eq(techniqueAnalysis.id, id))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const metrics = (row.metrics ?? {}) as Record<string, unknown>;
  const durationMs =
    typeof metrics.video_duration_ms === "number" && metrics.video_duration_ms > 0
      ? metrics.video_duration_ms
      : null;
  const userPose = poseDataForOverlayFetch(metrics.pose_data, undefined, {
    videoDurationMs: durationMs,
  });
  const totalFrames =
    typeof metrics.total_frames === "number" && metrics.total_frames > 0
      ? metrics.total_frames
      : userPose.length > 0
        ? Math.max(
            ...userPose.map((r) => (typeof r.frame === "number" ? r.frame : 0)),
            userPose.length - 1
          ) + 1
        : 1;

  const preview: BenchMatchPreview = {
    analysisId: row.id,
    user: {
      label: "User clip",
      videoUrl: userVideoUrl(row.secureUrl, row.cloudinaryPublicId),
      pose_data: userPose,
      total_frames: totalFrames,
      video_duration_ms: durationMs,
    },
    match: null,
  };

  const neighbor = resolveTopNeighbor(metrics);
  if (!neighbor) return preview;

  let trainVideoId = neighbor.trainVideoId;
  let totalProFrames: number | null = null;
  if (!trainVideoId) {
    const sample = await db.query.trainSample.findFirst({
      where: (ts, { eq: _eq }) => _eq(ts.id, neighbor.trainSampleId),
      columns: { trainVideoId: true, totalFrames: true, frameCount: true },
    });
    trainVideoId = sample?.trainVideoId ?? null;
    totalProFrames =
      typeof sample?.totalFrames === "number" && sample.totalFrames > 0
        ? sample.totalFrames
        : typeof sample?.frameCount === "number" && sample.frameCount > 0
          ? sample.frameCount
          : null;
  } else {
    const sample = await db.query.trainSample.findFirst({
      where: (ts, { eq: _eq }) => _eq(ts.id, neighbor.trainSampleId),
      columns: { totalFrames: true, frameCount: true },
    });
    totalProFrames =
      typeof sample?.totalFrames === "number" && sample.totalFrames > 0
        ? sample.totalFrames
        : typeof sample?.frameCount === "number" && sample.frameCount > 0
          ? sample.frameCount
          : null;
  }

  if (!trainVideoId) return preview;

  const proSeq = await getTrainSamplePoseSequence(neighbor.trainSampleId);
  const proPose = poseDataForOverlayFetch(proSeq ?? [], undefined, { videoDurationMs: null });
  const proTotal =
    totalProFrames ??
    (proPose.length > 0
      ? Math.max(
          ...proPose.map((r) => (typeof r.frame === "number" ? r.frame : 0)),
          proPose.length - 1
        ) + 1
      : 1);

  preview.match = {
    label: "Pro library match",
    train_sample_id: neighbor.trainSampleId,
    train_video_id: trainVideoId,
    stroke_label: neighbor.strokeLabel,
    distance: neighbor.distance,
    videoUrl: absolutePublicUrl(`/train/video/${trainVideoId}`),
    pose_data: proPose,
    total_frames: proTotal,
    video_duration_ms: null,
  };

  return preview;
}
