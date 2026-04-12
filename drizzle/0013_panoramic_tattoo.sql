CREATE INDEX "train_sample_embedding_hnsw_idx" ON "train_sample_embedding" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
ALTER TABLE "train_sample" ADD CONSTRAINT "train_sample_trainVideoId_unique" UNIQUE("trainVideoId");--> statement-breakpoint
ALTER TABLE "train_video_view_profile" ADD CONSTRAINT "train_video_view_profile_trainVideoId_unique" UNIQUE("trainVideoId");