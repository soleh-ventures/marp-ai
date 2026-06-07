CREATE TYPE "public"."plan_adjustment_status" AS ENUM('proposed', 'applied', 'declined', 'expired', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."plan_adjustment_trigger" AS ENUM('weekly_sweep', 'event');--> statement-breakpoint
CREATE TABLE "activity_analyses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"athlete_id" uuid NOT NULL,
	"activity_id" uuid NOT NULL,
	"objective" jsonb,
	"feeling" jsonb,
	"coach_read" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plan_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"athlete_id" uuid NOT NULL,
	"trigger" "plan_adjustment_trigger" NOT NULL,
	"status" "plan_adjustment_status" DEFAULT 'proposed' NOT NULL,
	"week_start" text NOT NULL,
	"proposal" jsonb NOT NULL,
	"pending_decision_id" uuid,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "activity_analyses" ADD CONSTRAINT "activity_analyses_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_analyses" ADD CONSTRAINT "activity_analyses_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_adjustments" ADD CONSTRAINT "plan_adjustments_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_adjustments" ADD CONSTRAINT "plan_adjustments_pending_decision_id_pending_decisions_id_fk" FOREIGN KEY ("pending_decision_id") REFERENCES "public"."pending_decisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "activity_analyses_activity_idx" ON "activity_analyses" USING btree ("activity_id");--> statement-breakpoint
CREATE INDEX "activity_analyses_athlete_created_idx" ON "activity_analyses" USING btree ("athlete_id","created_at");--> statement-breakpoint
CREATE INDEX "plan_adjustments_athlete_created_idx" ON "plan_adjustments" USING btree ("athlete_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "plan_adjustments_weekly_idem_idx" ON "plan_adjustments" USING btree ("athlete_id","week_start") WHERE "plan_adjustments"."trigger" = 'weekly_sweep';