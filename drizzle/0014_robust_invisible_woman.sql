CREATE TABLE "weekly_evaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"athlete_id" uuid NOT NULL,
	"week_start" text NOT NULL,
	"week_index" integer,
	"evaluation" text NOT NULL,
	"adjusted" boolean DEFAULT false NOT NULL,
	"safety_hold" boolean DEFAULT false NOT NULL,
	"change_summary" text,
	"rationale" text,
	"before_plan" jsonb,
	"after_plan" jsonb,
	"status" text DEFAULT 'evaluated' NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "weekly_evaluations" ADD CONSTRAINT "weekly_evaluations_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "weekly_evaluations_athlete_created_idx" ON "weekly_evaluations" USING btree ("athlete_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_evaluations_week_idem_idx" ON "weekly_evaluations" USING btree ("athlete_id","week_start");