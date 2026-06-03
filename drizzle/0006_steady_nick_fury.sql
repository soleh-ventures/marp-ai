ALTER TABLE "llm_calls" ADD COLUMN "cache_hit" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD COLUMN "cache_read_tokens" integer DEFAULT 0 NOT NULL;