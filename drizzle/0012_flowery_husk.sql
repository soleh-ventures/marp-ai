CREATE TABLE "safety_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"athlete_id" uuid NOT NULL,
	"message_id" uuid,
	"tier" text NOT NULL,
	"category" text NOT NULL,
	"reason" text,
	"message_excerpt" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "safety_events" ADD CONSTRAINT "safety_events_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safety_events" ADD CONSTRAINT "safety_events_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "safety_events_athlete_idx" ON "safety_events" USING btree ("athlete_id","created_at");