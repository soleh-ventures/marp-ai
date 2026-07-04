CREATE TABLE "garmin_wellness" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"athlete_id" uuid NOT NULL,
	"date" text NOT NULL,
	"resting_hr" integer,
	"vo2max" double precision,
	"hrv_overnight" double precision,
	"body_battery_high" integer,
	"body_battery_low" integer,
	"body_battery_charged" integer,
	"body_battery_drained" integer,
	"body_battery_morning" integer,
	"stress_avg" integer,
	"stress_max" integer,
	"sleep_total_s" integer,
	"sleep_deep_s" integer,
	"sleep_light_s" integer,
	"sleep_rem_s" integer,
	"sleep_awake_s" integer,
	"resp_sleep_avg" double precision,
	"resp_waking_avg" double precision,
	"resp_low" double precision,
	"resp_high" double precision,
	"readiness_score" integer,
	"readiness_band" text,
	"readiness_components" jsonb,
	"raw" jsonb,
	"source" text DEFAULT 'garmin' NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "garmin_wellness" ADD CONSTRAINT "garmin_wellness_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "garmin_wellness_athlete_date_idx" ON "garmin_wellness" USING btree ("athlete_id","date");