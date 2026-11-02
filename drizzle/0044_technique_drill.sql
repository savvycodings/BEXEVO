CREATE TABLE "technique_drill" (
	"slug" text PRIMARY KEY NOT NULL,
	"level" text NOT NULL,
	"minutes" integer NOT NULL,
	"focus" jsonb NOT NULL,
	"shots" jsonb NOT NULL,
	"videoUrl" text,
	"sort" integer DEFAULT 0 NOT NULL,
	"content" jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
