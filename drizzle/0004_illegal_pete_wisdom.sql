ALTER TABLE "athletes" DROP CONSTRAINT "athletes_phone_unique";--> statement-breakpoint
ALTER TABLE "athletes" ADD COLUMN "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "athletes" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "athletes_phone_active_idx" ON "athletes" USING btree ("phone") WHERE "athletes"."archived_at" IS NULL;