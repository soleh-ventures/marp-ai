ALTER TABLE "athletes" ADD COLUMN "telegram_chat_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "channel" text DEFAULT 'whatsapp' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "athletes_telegram_chat_idx" ON "athletes" USING btree ("telegram_chat_id") WHERE "athletes"."telegram_chat_id" IS NOT NULL;