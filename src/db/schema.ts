import {
  pgTable,
  text,
  boolean,
  timestamp,
  jsonb,
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

export type TechniqueAnalysisMetrics = {
  total_frames?: number;
  analyzed_frames?: number;
  pose_data?: Array<{
    frame: number;
    landmarks: Record<string, { x: number; y: number }>;
  }>;
  ai_analysis?: unknown;
  correction_images?: TechniqueCorrectionImage[];
  correction_context?: TechniqueCorrectionContext;
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
