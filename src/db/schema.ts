import {
  pgTable,
  text,
  boolean,
  timestamp,
  jsonb,
  integer,
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

export type TechniqueCorrectionContext = {
  version: string;
  generated_at: string;
  frame_count: number;
  frame_indices: number[];
  shot_and_handedness?: {
    shot: TechniqueShotClassification;
    handedness: TechniqueHandednessClassification;
  } | null;
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
    category: string;
    stroke_preset: string;
    skill_level: string;
    /** Cosine distance (pgvector `<=>` with cosine ops); lower = closer */
    distance: number;
  }>;
  shot_hypothesis: {
    stroke_preset: string | null;
    category: string | null;
    skill_level: string | null;
    /** 0–1 from neighbor agreement + distance margin */
    confidence: number;
  };
  /** Set when pgvector/table missing or query failed */
  error?: string;
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
  ai_analysis?: unknown;
  correction_images?: TechniqueCorrectionImage[];
  correction_context?: TechniqueCorrectionContext;
  /** Optional A/B: Flux img2img via fal.ai */
  correction_images_fal?: TechniqueCorrectionImage[];
  correction_context_fal?: TechniqueCorrectionContext;
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

export const trainStrokePresetEnum = pgEnum("train_stroke_preset", [
  "forehand_drive",
  "backhand_drive",
  "forehand_lob",
  "backhand_lob",
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
      .unique()
      .references(() => trainSample.id, { onDelete: "cascade" }),
    specVersion: text("specVersion").notNull(),
    embedding: vector("embedding", { dimensions: 128 }).notNull(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (table) => [
    index("train_sample_embedding_hnsw_idx").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops")
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
