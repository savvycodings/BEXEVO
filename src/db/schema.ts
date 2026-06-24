import {
  pgTable,
  text,
  boolean,
  timestamp,
  jsonb,
  integer,
  real,
  pgEnum,
  vector,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export type TechniqueCorrectionImage = {
  frame: number;
  originalImage: string;
  correctedImage: string;
};

export type TechniqueShotClassification = {
  shot_family: string;
  shot_name: string;
  variant: string;
  tactical_phase: string;
  court_zone: string;
  ball_context: string;
  player_side: string;
  contact_height: string;
  contact_timing: string;
  spin_profile: string;
  objective: string;
  diagnostic_features: string[];
  confidence: number;
};

export type TechniqueHandednessClassification = {
  dominant_hand: "right-handed" | "left-handed" | "unknown";
  confidence: number;
  evidence: string[];
};

export type TechniqueCorrectionFrameInsight = {
  frame: number;
  label: string;
  phase?: "preparation" | "impact" | "follow_through" | "other";
  summary: string;
  focus_joints: string[];
  stats: {
    pro_match: number;
    adjustment_need: number;
    stability: number;
    power_line: number;
  };
  top_adjustments?: Array<{ joint: string; axis: string; direction: string }>;
};

export type TechniqueCorrectionContext = {
  version: string;
  generated_at: string;
  frame_count: number;
  frame_indices: number[];
  image_provider?: string;
  shot_and_handedness?: {
    shot: TechniqueShotClassification;
    handedness: TechniqueHandednessClassification;
  } | null;
  /** Per corrected frame: FIFA-style stats + short explanation for UI tabs. */
  frames?: TechniqueCorrectionFrameInsight[];
  /** Saved for Activities / notifications — coach text used when generating images. */
  coaching_summary?: {
    diagnosis?: string | null;
    shot_context?: string | null;
    actionable_corrections?: string[];
    recommendations?: string[];
  };
};

/** pgvector k-NN against train_sample_embedding + train_video labels */
export type TechniqueRetrievalResult = {
  spec_version: string;
  embedding_dim: number;
  query_embedding_ok: boolean;
  neighbors: Array<{
    train_sample_id: string;
    train_video_id: string;
    stroke_name: string;
    /** Admin catalog label for UI (e.g. "Forehand Half Volley"). */
    stroke_label: string;
    category: string;
    stroke_preset: string;
    skill_level: string;
    /** Cosine distance (pgvector `<=>` with cosine ops); lower = closer */
    distance: number;
  }>;
  shot_hypothesis: {
    stroke_preset: string | null;
    /** Human shot title from pro library neighbors. */
    stroke_label: string | null;
    category: string | null;
    skill_level: string | null;
    /** 0–1 from neighbor agreement + distance margin */
    confidence: number;
  };
  /** Distance gap between #1 and #2 neighbor (cosine distance); debug / low-conf gating */
  neighbor_distance_gap?: number | null;
  /** Set when pgvector/table missing or query failed */
  error?: string;
  /** mediapipe_v2 | sam_v1 | blended | ensemble — which channel(s) drove k-NN */
  embedding_source?: "mediapipe_v2" | "sam_v1" | "blended" | "ensemble";
  mesh_used?: boolean;
  mesh_confidence?: number | null;
  /** Pose-only channel hypothesis (sequence ensemble). */
  pose_hypothesis?: TechniqueRetrievalResult["shot_hypothesis"] | null;
  /** Mesh-only channel hypothesis (sequence ensemble). */
  mesh_hypothesis?: TechniqueRetrievalResult["shot_hypothesis"] | null;
  /** Whether pose and mesh channels agreed on stroke_label. */
  channel_agreement?: boolean | null;
  /** Number of query frames probed per channel. */
  frames_used?: { pose: number; mesh: number };
};

export type TechniqueDetectionLabel = "sports_ball" | "racket";

export type TechniqueDetectionSummary = {
  enabled: boolean;
  model: string;
  sampled_frames: number;
  detected_frames: number;
  sports_ball_count: number;
  racket_count: number;
  avg_confidence: number;
  contact_window_frames?: number[];
  /** Clip-local + impact-near subset for LLM prompts (raw list kept for debug). */
  contact_window_frames_prompt?: number[];
  confidence_threshold?: number;
  confidence_threshold_racket?: number;
  confidence_threshold_ball?: number;
  iou_threshold?: number;
  imgsz?: number;
};

export type TechniqueAiAnalysisV61 = {
  is_padel?: boolean;
  sport_detected?: string;
  sport_confidence?: number;
  invalid_reason?: string;
  score?: number;
  score_scale?: "percent";
  score_model_raw?: number;
  score_calibrated_before_pro_tier?: number;
  rating?: "excellent" | "good" | "needs_improvement" | "poor" | string;
  scoring_version?: string;
  primary_train_category?: string;
  technique_score?: number;
  outcome_score?: number;
  tactics_score?: number;
  confidence_score?: number;
  breakdown?: {
    technique?: number;
    outcome?: number;
    tactics?: number;
  };
  confidence?: {
    score?: number;
    pose_confidence?: number;
    tracking_stability?: number;
    visibility_quality?: number;
    band?: "high" | "reliable" | "moderate" | "inconclusive" | string;
    uncertainty_plus_minus?: number;
  };
  calibration_trace?: Record<string, unknown>;
  en?: Record<string, unknown>;
  es?: Record<string, unknown>;
  [key: string]: unknown;
};

export type TechniqueAnalysisMetrics = {
  total_frames?: number;
  analyzed_frames?: number;
  /** Client-reported duration; used with user clips to anchor impact frame. */
  video_duration_ms?: number;
  /** Clips from technique UI (impact = clip endMs). */
  user_clips?: Array<{ startMs: number; endMs: number }>;
  /** Preparation / impact / follow-through samples derived from pose_data + impact time. */
  impact_pose_sequence?: Array<{
    phase: "preparation" | "impact" | "follow_through";
    frame: number;
    landmarks: Record<string, { x: number; y: number }>;
  }>;
  pose_data?: Array<{
    frame: number;
    landmarks: Record<string, { x: number; y: number }>;
  }>;
  /** Pro-library similarity (train_sample_embedding); optional */
  retrieval?: TechniqueRetrievalResult;
  /** YOLO object detection summary (full frame rows are stored in technique_detection_frame). */
  detection_summary?: TechniqueDetectionSummary;
  ai_analysis?: TechniqueAiAnalysisV61 | null;
  correction_images?: TechniqueCorrectionImage[];
  correction_context?: TechniqueCorrectionContext;
  /** Optional A/B: Flux img2img via fal.ai */
  correction_images_fal?: TechniqueCorrectionImage[];
  correction_context_fal?: TechniqueCorrectionContext;
  /** Local / self-hosted ComfyUI workflow (server posts frame + prompt, reads output image). */
  correction_images_comfy?: TechniqueCorrectionImage[];
  correction_context_comfy?: TechniqueCorrectionContext;
  [key: string]: unknown;
};

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("emailVerified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expiresAt").notNull(),
  ipAddress: text("ipAddress"),
  userAgent: text("userAgent"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accountId: text("accountId").notNull(),
  providerId: text("providerId").notNull(),
  accessToken: text("accessToken"),
  refreshToken: text("refreshToken"),
  accessTokenExpiresAt: timestamp("accessTokenExpiresAt"),
  refreshTokenExpiresAt: timestamp("refreshTokenExpiresAt"),
  scope: text("scope"),
  idToken: text("idToken"),
  password: text("password"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expiresAt").notNull(),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
});

export const userProfile = pgTable("user_profile", {
  userId: text("userId")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  username: text("username"),
  /** Optional phone for account settings (not shown on public directory). */
  phone: text("phone"),
  /** City or region line; shown to linked coaches only (coach-students API), not on public directory. */
  areaLocation: text("areaLocation"),
  /** ISO `YYYY-MM-DD` from profile settings (optional). */
  birthDate: text("birthDate"),
  coachStudentRole: text("coachStudentRole").default("none"),
  gender: text("gender"),
  dominantHand: text("dominantHand"),
  courtSide: text("courtSide"),
  hasRanking: boolean("hasRanking"),
  level: text("level"),
  rankingOrg: text("rankingOrg"),
  rankingValue: text("rankingValue"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
});

/** Coach's roster of students shown in My Coach + coach tools. */
export const coachStudent = pgTable(
  "coach_student",
  {
    id: text("id").primaryKey(),
    coachUserId: text("coachUserId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    studentUserId: text("studentUserId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("coach_student_unique_pair_idx").on(
      table.coachUserId,
      table.studentUserId
    ),
    index("coach_student_coach_idx").on(table.coachUserId),
    index("coach_student_student_idx").on(table.studentUserId),
  ]
);

/**
 * Private 1:1 chat thread for a single coach–student roster row (not broadcast).
 * Create a row when the pair is linked or on first message. Weekly score rings in the UI
 * can stay derived from `technique_analysis` (see `/profile/coach-students`) until you add snapshots.
 */
export const coachStudentChat = pgTable(
  "coach_student_chat",
  {
    id: text("id").primaryKey(),
    coachStudentId: text("coachStudentId")
      .notNull()
      .unique()
      .references(() => coachStudent.id, { onDelete: "cascade" }),
    lastMessageAt: timestamp("lastMessageAt"),
    coachLastReadAt: timestamp("coachLastReadAt"),
    studentLastReadAt: timestamp("studentLastReadAt"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (table) => [index("coach_student_chat_last_message_idx").on(table.lastMessageAt)]
);

export const coachStudentChatMessage = pgTable(
  "coach_student_chat_message",
  {
    id: text("id").primaryKey(),
    chatId: text("chatId")
      .notNull()
      .references(() => coachStudentChat.id, { onDelete: "cascade" }),
    senderUserId: text("senderUserId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** `text` | future: `system`, etc. */
    kind: text("kind").notNull().default("text"),
    body: text("body").notNull(),
    /** Optional refs: clip id, review id, structured payload for “new video” tiles, etc. */
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (table) => [
    index("coach_student_chat_message_chat_created_idx").on(
      table.chatId,
      table.createdAt
    ),
    index("coach_student_chat_message_sender_idx").on(table.senderUserId),
  ]
);

export const techniqueVideo = pgTable("technique_video", {
  id: text("id").primaryKey(),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  cloudinaryPublicId: text("cloudinaryPublicId").notNull(),
  cloudinaryUrl: text("cloudinaryUrl").notNull(),
  secureUrl: text("secureUrl"),
  bytes: text("bytes"),
  format: text("format"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
});

export const trainViewProfileEnum = pgEnum("train_view_profile", [
  "front",
  "side",
  "behind",
]);

/** Admin training taxonomy (stored on train_video; Modal still receives a single movement_label string). */
export const trainCategoryEnum = pgEnum("train_category", [
  "ground_strokes",
  "net_play",
  "defence_glass",
  "save_return",
  "overhead",
  "tactical_specials",
]);

/** Keep in sync with `app/src/lib/train-taxonomy.ts` TrainStrokePreset */
export const trainStrokePresetEnum = pgEnum("train_stroke_preset", [
  "forehand_drive",
  "backhand_drive",
  "forehand_lob",
  "backhand_lob",
  "backhand_volley",
  "forehand_volley",
  "backhand_return",
  "backhand_return_with_lob",
  "forehand_return_with_lob",
  "backhand_drive_with_wall",
  "forehand_chiquita",
  "half_volley",
  "back_wall_backhand",
  "back_wall_forehand",
  "contrapared_boast",
  "side_wall_backhand",
  "side_wall_forehand",
  "bandeja",
]);

export const trainSkillLevelEnum = pgEnum("train_skill_level", [
  "beginner",
  "intermediate",
  "advanced",
]);

/** Admin training uploads: labeled stroke + video file on disk (same layout as technique_video). */
export const trainVideo = pgTable("train_video", {
  id: text("id").primaryKey(),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  strokeName: text("strokeName").notNull(),
  /** Exact admin UI shot label (e.g. "Back Wall Forehand low"); distinct from preset enum. */
  strokeLabel: text("strokeLabel"),
  category: trainCategoryEnum("category").notNull(),
  strokePreset: trainStrokePresetEnum("strokePreset").notNull(),
  skillLevel: trainSkillLevelEnum("skillLevel").notNull(),
  cloudinaryPublicId: text("cloudinaryPublicId").notNull(),
  cloudinaryUrl: text("cloudinaryUrl").notNull(),
  secureUrl: text("secureUrl"),
  bytes: text("bytes"),
  format: text("format"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
});

export type TrainPoseFrame = {
  frame_idx: number;
  landmarks: Record<
    string,
    { x: number; y: number; z?: number; visibility?: number }
  >;
};

export type TrainSampleExtractionMeta = {
  processed_at?: string;
  sampler?: { stride?: number };
  model?: {
    provider?: string;
    name?: string;
    model_complexity?: number;
  };
  yolo_summary?: TechniqueDetectionSummary;
  normalized_label?: {
    canonical_stroke?: string;
    stroke_family?: string;
    aliases?: string[];
    confidence?: number;
    [key: string]: unknown;
  } | null;
  train_video_id?: string | null;
  [key: string]: unknown;
};

export const trainSample = pgTable("train_sample", {
  id: text("id").primaryKey(),
  trainVideoId: text("trainVideoId")
    .notNull()
    .unique()
    .references(() => trainVideo.id, { onDelete: "cascade" }),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  strokeNameSnapshot: text("strokeNameSnapshot").notNull(),
  status: text("status").notNull(),
  frameCount: integer("frameCount"),
  totalFrames: integer("totalFrames"),
  poseSequence: jsonb("poseSequence").$type<TrainPoseFrame[]>(),
  extractionMeta: jsonb("extractionMeta").$type<TrainSampleExtractionMeta>(),
  errorMessage: text("errorMessage"),
  modalJobId: text("modalJobId"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
});

/** pgvector row per completed train_sample; used for pro-library k-NN. */
export const trainSampleEmbedding = pgTable(
  "train_sample_embedding",
  {
    id: text("id").primaryKey(),
    trainSampleId: text("trainSampleId")
      .notNull()
      .references(() => trainSample.id, { onDelete: "cascade" }),
    specVersion: text("specVersion").notNull(),
    /** Per-frame sequence index within (sample, spec). 0 = single-frame legacy rows. */
    frameIndex: integer("frameIndex").notNull().default(0),
    /** Mesh confidence for sam_v1 rows (null for pose rows). */
    meshConfidence: real("meshConfidence"),
    embedding: vector("embedding", { dimensions: 128 }).notNull(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (table) => [
    index("train_sample_embedding_hnsw_idx").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops")
    ),
    uniqueIndex("train_sample_embedding_sample_spec_frame_unique").on(
      table.trainSampleId,
      table.specVersion,
      table.frameIndex
    ),
  ]
);

export const trainVideoViewProfile = pgTable("train_video_view_profile", {
  id: text("id").primaryKey(),
  trainVideoId: text("trainVideoId")
    .notNull()
    .unique()
    .references(() => trainVideo.id, { onDelete: "cascade" }),
  viewProfile: trainViewProfileEnum("viewProfile").notNull(),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
});

export const techniqueAnalysis = pgTable("technique_analysis", {
  id: text("id").primaryKey(),
  techniqueVideoId: text("techniqueVideoId")
    .notNull()
    .references(() => techniqueVideo.id, { onDelete: "cascade" }),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  status: text("status").notNull(),
  metrics: jsonb("metrics").$type<TechniqueAnalysisMetrics>(),
  feedbackText: text("feedbackText"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
});

/** Per-frame YOLO detections for a technique analysis (ball/racket tracking). */
export const techniqueDetectionFrame = pgTable(
  "technique_detection_frame",
  {
    id: text("id").primaryKey(),
    analysisId: text("analysisId")
      .notNull()
      .references(() => techniqueAnalysis.id, { onDelete: "cascade" }),
    frame: integer("frame").notNull(),
    timeMs: integer("timeMs").notNull().default(0),
    label: text("label").$type<TechniqueDetectionLabel>().notNull(),
    confidence: integer("confidence").notNull().default(0),
    boxX: integer("boxX").notNull().default(0),
    boxY: integer("boxY").notNull().default(0),
    boxW: integer("boxW").notNull().default(0),
    boxH: integer("boxH").notNull().default(0),
    trackId: text("trackId"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (table) => [
    index("technique_detection_frame_analysis_frame_idx").on(
      table.analysisId,
      table.frame
    ),
    index("technique_detection_frame_analysis_label_idx").on(
      table.analysisId,
      table.label
    ),
    index("technique_detection_frame_analysis_time_idx").on(
      table.analysisId,
      table.timeMs
    ),
  ]
);

/** Coach review queue for student technique uploads. */
export const coachVideoReview = pgTable(
  "coach_video_review",
  {
    id: text("id").primaryKey(),
    coachUserId: text("coachUserId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    studentUserId: text("studentUserId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    techniqueVideoId: text("techniqueVideoId")
      .notNull()
      .references(() => techniqueVideo.id, { onDelete: "cascade" }),
    techniqueAnalysisId: text("techniqueAnalysisId").references(
      () => techniqueAnalysis.id,
      { onDelete: "set null" }
    ),
    status: text("status").notNull().default("pending"),
    coachFeedbackText: text("coachFeedbackText"),
    coachMarksJson: jsonb("coachMarksJson"),
    submittedAt: timestamp("submittedAt"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("coach_video_review_unique_pair_idx").on(
      table.coachUserId,
      table.techniqueVideoId
    ),
    index("coach_video_review_coach_status_idx").on(
      table.coachUserId,
      table.status
    ),
    index("coach_video_review_student_status_idx").on(
      table.studentUserId,
      table.status
    ),
    index("coach_video_review_video_idx").on(table.techniqueVideoId),
    index("coach_video_review_analysis_idx").on(table.techniqueAnalysisId),
  ]
);

/** Videos a coach sends to a student (coach -> student outbound). */
export const coachSentVideo = pgTable(
  "coach_sent_video",
  {
    id: text("id").primaryKey(),
    coachUserId: text("coachUserId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    studentUserId: text("studentUserId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    techniqueVideoId: text("techniqueVideoId")
      .notNull()
      .references(() => techniqueVideo.id, { onDelete: "cascade" }),
    category: text("category"),
    strokePreset: text("strokePreset"),
    shotLabel: text("shotLabel"),
    skillLevel: text("skillLevel"),
    viewId: text("viewId"),
    note: text("note"),
    viewedAt: timestamp("viewedAt"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (table) => [
    index("coach_sent_video_student_created_idx").on(
      table.studentUserId,
      table.createdAt
    ),
    index("coach_sent_video_coach_created_idx").on(
      table.coachUserId,
      table.createdAt
    ),
    index("coach_sent_video_video_idx").on(table.techniqueVideoId),
  ]
);

/** One row per coach-drawn/commented frame annotation. */
export const coachReviewAnnotation = pgTable(
  "coach_review_annotation",
  {
    id: text("id").primaryKey(),
    reviewId: text("reviewId")
      .notNull()
      .references(() => coachVideoReview.id, { onDelete: "cascade" }),
    imageUri: text("imageUri").notNull(),
    cloudinaryUrl: text("cloudinaryUrl"),
    comment: text("comment"),
    timeMs: integer("timeMs").notNull().default(0),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (table) => [
    index("coach_review_annotation_review_idx").on(table.reviewId),
    index("coach_review_annotation_review_time_idx").on(
      table.reviewId,
      table.timeMs
    ),
  ]
);

/** User feedback when regenerating correction images (for product review). */
export const techniqueCorrectionRegenerationFeedback = pgTable(
  "technique_correction_regeneration_feedback",
  {
    id: text("id").primaryKey(),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    techniqueAnalysisId: text("techniqueAnalysisId")
      .notNull()
      .references(() => techniqueAnalysis.id, { onDelete: "cascade" }),
    message: text("message").notNull(),
    coachingSnapshot: jsonb("coachingSnapshot").$type<{
      diagnosis?: string | null;
      shot_context?: string | null;
      recommendations?: string[];
      actionable_corrections?: string[];
      technical_errors?: string[];
      strengths?: string[];
      frame_indices?: number[];
    }>(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (table) => [
    index("technique_corr_regen_fb_analysis_idx").on(
      table.techniqueAnalysisId,
      table.createdAt
    ),
    index("technique_corr_regen_fb_user_idx").on(table.userId, table.createdAt),
  ]
);

/** In-app notifications (coach review ready, etc). */
export const userNotification = pgTable(
  "user_notification",
  {
    id: text("id").primaryKey(),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    refType: text("refType"),
    refId: text("refId"),
    readAt: timestamp("readAt"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (table) => [
    index("user_notification_user_created_idx").on(
      table.userId,
      table.createdAt
    ),
    index("user_notification_ref_idx").on(table.refType, table.refId),
  ]
);

/**
 * fal.ai LoRA dataset uploads (admin/team collaboration).
 *
 * Stores raw image assets and a generated ZIP (served from /uploads) that can be used as
 * `images_data_url` for `fal-ai/flux-lora-fast-training`.
 */
export const falLoraDataset = pgTable("fal_lora_dataset", {
  id: text("id").primaryKey(),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  /** Human label for the dataset (e.g. "Forehand drive - side view") */
  name: text("name").notNull(),
  /** Optional: used by fal training depending on whether captions exist */
  triggerWord: text("triggerWord"),
  /** When true, fal treats this as style training */
  isStyle: boolean("isStyle").notNull().default(false),
  /** Public path under /uploads for the generated zip archive */
  zipPath: text("zipPath"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
});

export const falLoraImage = pgTable("fal_lora_image", {
  id: text("id").primaryKey(),
  datasetId: text("datasetId")
    .notNull()
    .references(() => falLoraDataset.id, { onDelete: "cascade" }),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  /** Same taxonomy as train_video so team uses consistent labels */
  category: trainCategoryEnum("category").notNull(),
  strokePreset: trainStrokePresetEnum("strokePreset").notNull(),
  skillLevel: trainSkillLevelEnum("skillLevel").notNull(),
  /** Optional view profile for images */
  viewProfile: trainViewProfileEnum("viewProfile"),
  /** Stored file path on disk (absolute) */
  filePath: text("filePath").notNull(),
  /** Public URL path (relative) served by /uploads */
  publicPath: text("publicPath").notNull(),
  /** Optional per-image caption (zip includes .txt) */
  caption: text("caption"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
});

/** Admin shot-retrieval accuracy checks (clickable tests in Admin UI). */
export const adminAccuracyTestRun = pgTable(
  "admin_accuracy_test_run",
  {
    id: text("id").primaryKey(),
    testId: text("testId").notNull(),
    scorePercent: integer("scorePercent").notNull(),
    passed: boolean("passed").notNull(),
    summary: text("summary").notNull(),
    detail: jsonb("detail").$type<Record<string, unknown> | null>(),
    triggeredByUserId: text("triggeredByUserId").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (table) => [
    index("admin_accuracy_test_run_test_created_idx").on(
      table.testId,
      table.createdAt
    ),
  ]
);

/** Per-user XP, login streak, and level tracking for achievements / daily quests. */
export const userGamification = pgTable("user_gamification", {
  userId: text("userId")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  totalXp: integer("totalXp").notNull().default(0),
  loginStreak: integer("loginStreak").notNull().default(0),
  /** Local calendar date `YYYY-MM-DD` of the most recent login streak day. */
  lastLoginDate: text("lastLoginDate"),
  /** Last recorded level (for "reach new division" daily quest). */
  lastLevel: integer("lastLevel").notNull().default(1),
  /** Level at the start of `dayStartDate` (local calendar day). */
  dayStartDate: text("dayStartDate"),
  dayStartLevel: integer("dayStartLevel").notNull().default(1),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
});

/** Unlocked achievement badges (keys match app `achievementsCatalog`). */
export const userAchievement = pgTable(
  "user_achievement",
  {
    id: text("id").primaryKey(),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    achievementKey: text("achievementKey").notNull(),
    /** When the user first met the achievement requirements. */
    unlockedAt: timestamp("unlockedAt").notNull().defaultNow(),
    /** When the user tapped Claim on the achievement detail screen. */
    claimedAt: timestamp("claimedAt"),
  },
  (table) => [
    uniqueIndex("user_achievement_user_key_idx").on(
      table.userId,
      table.achievementKey
    ),
    index("user_achievement_user_idx").on(table.userId),
  ]
);

/** Daily quest progress for the user's assigned quests on a calendar day. */
export const userDailyQuest = pgTable(
  "user_daily_quest",
  {
    id: text("id").primaryKey(),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    dateKey: text("dateKey").notNull(),
    questKey: text("questKey").notNull(),
    progress: integer("progress").notNull().default(0),
    goal: integer("goal").notNull().default(1),
    claimedAt: timestamp("claimedAt"),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("user_daily_quest_user_date_key_idx").on(
      table.userId,
      table.dateKey,
      table.questKey
    ),
    index("user_daily_quest_user_date_idx").on(table.userId, table.dateKey),
  ]
);

/** XP ledger — deduplicates awards (`source` + `sourceRef` unique per user). */
export const xpEvent = pgTable(
  "xp_event",
  {
    id: text("id").primaryKey(),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    amount: integer("amount").notNull(),
    source: text("source").notNull(),
    sourceRef: text("sourceRef").notNull(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("xp_event_user_source_ref_idx").on(
      table.userId,
      table.source,
      table.sourceRef
    ),
    index("xp_event_user_idx").on(table.userId),
  ]
);

export const falLoraTrainingRun = pgTable("fal_lora_training_run", {
  id: text("id").primaryKey(),
  datasetId: text("datasetId")
    .notNull()
    .references(() => falLoraDataset.id, { onDelete: "cascade" }),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  status: text("status").notNull(),
  /** The exact images_data_url used for this run */
  imagesDataUrl: text("imagesDataUrl").notNull(),
  triggerWord: text("triggerWord"),
  isStyle: boolean("isStyle").notNull().default(false),
  steps: integer("steps"),
  /** Result */
  diffusersLoraFileUrl: text("diffusersLoraFileUrl"),
  configFileUrl: text("configFileUrl"),
  errorMessage: text("errorMessage"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
});
