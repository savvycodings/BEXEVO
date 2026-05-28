-- Lightweight Neon-friendly view (avoids selecting huge `metrics` JSON).
-- Exposes: chosen shot label/preset, feedbackText, correction image URLs, and latest user regen feedback.
CREATE OR REPLACE VIEW "public"."technique_analysis_overview" AS
SELECT
  ta."id" AS "id",
  ta."techniqueVideoId" AS "techniqueVideoId",
  ta."userId" AS "userId",
  ta."status" AS "status",
  ta."createdAt" AS "createdAt",
  ta."feedbackText" AS "feedbackText",
  -- Shot hypothesis
  (COALESCE(ta."metrics", '{}'::jsonb) #>> '{retrieval,shot_hypothesis,stroke_label}') AS "strokeLabel",
  (COALESCE(ta."metrics", '{}'::jsonb) #>> '{retrieval,shot_hypothesis,stroke_preset}') AS "strokePreset",
  (COALESCE(ta."metrics", '{}'::jsonb) #>> '{retrieval,shot_hypothesis,category}') AS "category",
  (COALESCE(ta."metrics", '{}'::jsonb) #>> '{retrieval,shot_hypothesis,skill_level}') AS "skillLevel",
  (COALESCE(ta."metrics", '{}'::jsonb) #>> '{retrieval,shot_hypothesis,confidence}') AS "retrievalConfidence",
  -- Correction images + context (small; URLs only)
  (COALESCE(ta."metrics", '{}'::jsonb) -> 'correction_context') AS "correctionContext",
  (COALESCE(ta."metrics", '{}'::jsonb) -> 'correction_images') AS "correctionImages",
  (COALESCE(ta."metrics", '{}'::jsonb) -> 'correction_images_fal') AS "correctionImagesFal",
  (COALESCE(ta."metrics", '{}'::jsonb) -> 'correction_images_comfy') AS "correctionImagesComfy",
  -- Latest user feedback when regenerating correction images (if any)
  fb."message" AS "latestRegenFeedbackMessage",
  fb."createdAt" AS "latestRegenFeedbackAt",
  fb."coachingSnapshot" AS "latestRegenCoachingSnapshot"
FROM "public"."technique_analysis" ta
LEFT JOIN LATERAL (
  SELECT
    tcrf."message",
    tcrf."createdAt",
    tcrf."coachingSnapshot"
  FROM "public"."technique_correction_regeneration_feedback" tcrf
  WHERE tcrf."techniqueAnalysisId" = ta."id"
  ORDER BY tcrf."createdAt" DESC
  LIMIT 1
) fb ON TRUE;

