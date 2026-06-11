import assert from "node:assert/strict";
import test from "node:test";
import {
  meshProxyFeatureVector,
  resolveRetrievalEmbedding,
  MESH_CONFIDENCE_MIN,
} from "./meshEmbedding";
import { landmarksToEmbeddingVector } from "./poseEmbedding";

function lm(x: number, y: number, z = 0, visibility = 0.9) {
  return { x, y, z, visibility };
}

test("meshProxyFeatureVector returns 128-dim normalized vector", () => {
  const landmarks = {
    LEFT_HIP: lm(0.45, 0.55),
    RIGHT_HIP: lm(0.55, 0.55),
    LEFT_SHOULDER: lm(0.45, 0.35),
    RIGHT_SHOULDER: lm(0.55, 0.35),
    LEFT_ELBOW: lm(0.4, 0.45),
    RIGHT_ELBOW: lm(0.6, 0.45),
    LEFT_WRIST: lm(0.38, 0.5),
    RIGHT_WRIST: lm(0.62, 0.5),
    LEFT_KNEE: lm(0.45, 0.72),
    RIGHT_KNEE: lm(0.55, 0.72),
  };
  const vec = meshProxyFeatureVector(landmarks);
  assert.equal(vec.length, 128);
  const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0));
  assert.ok(Math.abs(norm - 1) < 0.01);
});

test("resolveRetrievalEmbedding prefers blended when mesh confidence ok", () => {
  const mpLm = {
    LEFT_HIP: lm(0.45, 0.55),
    RIGHT_HIP: lm(0.55, 0.55),
    LEFT_SHOULDER: lm(0.45, 0.35),
    RIGHT_SHOULDER: lm(0.55, 0.35),
    LEFT_ELBOW: lm(0.4, 0.45),
    RIGHT_ELBOW: lm(0.6, 0.45),
    LEFT_WRIST: lm(0.38, 0.5),
    RIGHT_WRIST: lm(0.62, 0.5),
    LEFT_KNEE: lm(0.45, 0.72),
    RIGHT_KNEE: lm(0.55, 0.72),
    NOSE: lm(0.5, 0.2),
  };
  const mpVec = landmarksToEmbeddingVector(mpLm);
  const meshVec = meshProxyFeatureVector(mpLm);
  const metrics = {
    impact_frame_resolved: 10,
    pose_enrichment: {
      frames: [
        {
          frame: 10,
          mesh_confidence: MESH_CONFIDENCE_MIN + 0.1,
          feature_vector: meshVec,
        },
      ],
    },
  };
  const r = resolveRetrievalEmbedding(metrics, mpVec, 10);
  assert.ok(r);
  assert.equal(r!.embedding_source, "blended");
  assert.equal(r!.mesh_used, true);
  assert.equal(r!.query_spec_version, "sam_v1");
});

test("resolveRetrievalEmbedding falls back to mediapipe_v2 without enrichment", () => {
  const mpLm = {
    LEFT_HIP: lm(0.45, 0.55),
    RIGHT_HIP: lm(0.55, 0.55),
    LEFT_SHOULDER: lm(0.45, 0.35),
    RIGHT_SHOULDER: lm(0.55, 0.35),
    LEFT_ELBOW: lm(0.4, 0.45),
    RIGHT_ELBOW: lm(0.6, 0.45),
    LEFT_WRIST: lm(0.38, 0.5),
    RIGHT_WRIST: lm(0.62, 0.5),
    NOSE: lm(0.5, 0.2),
  };
  const mpVec = landmarksToEmbeddingVector(mpLm);
  const r = resolveRetrievalEmbedding({}, mpVec);
  assert.ok(r);
  assert.equal(r!.embedding_source, "mediapipe_v2");
  assert.equal(r!.mesh_used, false);
});
