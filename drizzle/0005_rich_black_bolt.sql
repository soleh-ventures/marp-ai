ALTER TYPE "public"."llm_component" ADD VALUE 'binder' BEFORE 'other';--> statement-breakpoint
CREATE TABLE "pending_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"athlete_id" uuid NOT NULL,
	"message_id" uuid,
	"frame" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_key" text
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "resolves_pending_decision_id" uuid;--> statement-breakpoint
ALTER TABLE "pending_decisions" ADD CONSTRAINT "pending_decisions_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_decisions" ADD CONSTRAINT "pending_decisions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pending_decisions_unresolved_idx" ON "pending_decisions" USING btree ("athlete_id") WHERE "pending_decisions"."resolved_at" IS NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_resolves_pending_decision_id_pending_decisions_id_fk" FOREIGN KEY ("resolves_pending_decision_id") REFERENCES "public"."pending_decisions"("id") ON DELETE set null ON UPDATE no action;