CREATE TABLE "club" (
	"id" text PRIMARY KEY NOT NULL,
	"ownerUserId" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"address" text NOT NULL,
	"city" text,
	"region" text,
	"country" text,
	"postalCode" text,
	"latitude" text,
	"longitude" text,
	"phone" text,
	"email" text,
	"website" text,
	"hoursText" text,
	"bannerImageUrl" text,
	"logoImageUrl" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"reviewedByUserId" text,
	"reviewedAt" timestamp,
	"rejectionReason" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "club_amenity" (
	"id" text PRIMARY KEY NOT NULL,
	"clubId" text NOT NULL,
	"amenityKey" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "club_court" (
	"id" text PRIMARY KEY NOT NULL,
	"clubId" text NOT NULL,
	"name" text NOT NULL,
	"indoorOutdoor" text NOT NULL,
	"hasLighting" boolean DEFAULT false NOT NULL,
	"displayOrder" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "club_gallery_image" (
	"id" text PRIMARY KEY NOT NULL,
	"clubId" text NOT NULL,
	"imageUrl" text NOT NULL,
	"displayOrder" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "club" ADD CONSTRAINT "club_ownerUserId_user_id_fk" FOREIGN KEY ("ownerUserId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club" ADD CONSTRAINT "club_reviewedByUserId_user_id_fk" FOREIGN KEY ("reviewedByUserId") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_amenity" ADD CONSTRAINT "club_amenity_clubId_club_id_fk" FOREIGN KEY ("clubId") REFERENCES "public"."club"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_court" ADD CONSTRAINT "club_court_clubId_club_id_fk" FOREIGN KEY ("clubId") REFERENCES "public"."club"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_gallery_image" ADD CONSTRAINT "club_gallery_image_clubId_club_id_fk" FOREIGN KEY ("clubId") REFERENCES "public"."club"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "club_slug_idx" ON "club" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "club_owner_idx" ON "club" USING btree ("ownerUserId");--> statement-breakpoint
CREATE INDEX "club_status_idx" ON "club" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "club_amenity_club_key_idx" ON "club_amenity" USING btree ("clubId","amenityKey");--> statement-breakpoint
CREATE INDEX "club_amenity_club_idx" ON "club_amenity" USING btree ("clubId");--> statement-breakpoint
CREATE INDEX "club_court_club_idx" ON "club_court" USING btree ("clubId");--> statement-breakpoint
CREATE INDEX "club_gallery_image_club_idx" ON "club_gallery_image" USING btree ("clubId");
