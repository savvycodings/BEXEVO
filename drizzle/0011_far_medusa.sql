CREATE TABLE "fal_lora_dataset" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"name" text NOT NULL,
	"triggerWord" text,
	"isStyle" boolean DEFAULT false NOT NULL,
	"zipPath" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fal_lora_image" (
	"id" text PRIMARY KEY NOT NULL,
	"datasetId" text NOT NULL,
	"userId" text NOT NULL,
	"category" "train_category" NOT NULL,
	"strokePreset" "train_stroke_preset" NOT NULL,
	"skillLevel" "train_skill_level" NOT NULL,
	"viewProfile" "train_view_profile",
	"filePath" text NOT NULL,
	"publicPath" text NOT NULL,
	"caption" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fal_lora_training_run" (
	"id" text PRIMARY KEY NOT NULL,
	"datasetId" text NOT NULL,
	"userId" text NOT NULL,
	"status" text NOT NULL,
	"imagesDataUrl" text NOT NULL,
	"triggerWord" text,
	"isStyle" boolean DEFAULT false NOT NULL,
	"steps" integer,
	"diffusersLoraFileUrl" text,
	"configFileUrl" text,
	"errorMessage" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fal_lora_dataset" ADD CONSTRAINT "fal_lora_dataset_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fal_lora_image" ADD CONSTRAINT "fal_lora_image_datasetId_fal_lora_dataset_id_fk" FOREIGN KEY ("datasetId") REFERENCES "public"."fal_lora_dataset"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fal_lora_image" ADD CONSTRAINT "fal_lora_image_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fal_lora_training_run" ADD CONSTRAINT "fal_lora_training_run_datasetId_fal_lora_dataset_id_fk" FOREIGN KEY ("datasetId") REFERENCES "public"."fal_lora_dataset"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fal_lora_training_run" ADD CONSTRAINT "fal_lora_training_run_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;