CREATE TABLE "pro_reference" (
	"id" text PRIMARY KEY NOT NULL,
	"strokePreset" text NOT NULL,
	"racketSide" text NOT NULL,
	"facingRatio" real NOT NULL,
	"fps" real NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"pose" jsonb NOT NULL,
	"sourceLabel" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "pro_reference_stroke_idx" ON "pro_reference" USING btree ("strokePreset");
