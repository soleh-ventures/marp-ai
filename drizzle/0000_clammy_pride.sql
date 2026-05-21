CREATE TYPE "public"."active_flag_kind" AS ENUM('injury', 'life_event', 'illness', 'travel');--> statement-breakpoint
CREATE TYPE "public"."activity_source" AS ENUM('strava', 'fit', 'gpx');--> statement-breakpoint
CREATE TYPE "public"."llm_component" AS ENUM('classifier', 'domain', 'synthesizer', 'memory', 'content', 'other');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('in', 'out');--> statement-breakpoint
CREATE TYPE "public"."race_block_state" AS ENUM('pending', 'active', 'completed');--> statement-breakpoint
CREATE TABLE "active_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"athlete_id" uuid NOT NULL,
	"kind" "active_flag_kind" NOT NULL,
	"body" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"athlete_id" uuid NOT NULL,
	"race_block_id" uuid,
	"discipline" text NOT NULL,
	"source" "activity_source" NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"duration_s" integer NOT NULL,
	"metrics" jsonb,
	"raw_payload" jsonb,
	"long_run" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "athletes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" text NOT NULL,
	"name" text,
	"locale" text DEFAULT 'en' NOT NULL,
	"athletic_history" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "athletes_phone_unique" UNIQUE("phone")
);
--> statement-breakpoint
CREATE TABLE "llm_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"athlete_id" uuid,
	"message_id" uuid,
	"component" "llm_component" NOT NULL,
	"model" text NOT NULL,
	"tokens_in" integer NOT NULL,
	"tokens_out" integer NOT NULL,
	"cost_estimate_usd" double precision NOT NULL,
	"latency_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"athlete_id" uuid NOT NULL,
	"direction" "message_direction" NOT NULL,
	"body" text NOT NULL,
	"media_url" text,
	"twilio_message_sid" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_twilio_message_sid_unique" UNIQUE("twilio_message_sid")
);
--> statement-breakpoint
CREATE TABLE "processed_messages" (
	"twilio_message_sid" text PRIMARY KEY NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "race_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"athlete_id" uuid NOT NULL,
	"race_name" text NOT NULL,
	"race_date" timestamp with time zone NOT NULL,
	"race_distance" text NOT NULL,
	"goal_finish_time" text,
	"state" "race_block_state" DEFAULT 'pending' NOT NULL,
	"plan" jsonb,
	"summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "active_flags" ADD CONSTRAINT "active_flags_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_race_block_id_race_blocks_id_fk" FOREIGN KEY ("race_block_id") REFERENCES "public"."race_blocks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "race_blocks" ADD CONSTRAINT "race_blocks_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "active_flags_athlete_idx" ON "active_flags" USING btree ("athlete_id");--> statement-breakpoint
CREATE INDEX "activities_athlete_started_idx" ON "activities" USING btree ("athlete_id","started_at");--> statement-breakpoint
CREATE INDEX "activities_race_block_idx" ON "activities" USING btree ("race_block_id");--> statement-breakpoint
CREATE INDEX "llm_calls_created_idx" ON "llm_calls" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "llm_calls_athlete_idx" ON "llm_calls" USING btree ("athlete_id");--> statement-breakpoint
CREATE INDEX "llm_calls_component_idx" ON "llm_calls" USING btree ("component");--> statement-breakpoint
CREATE INDEX "messages_athlete_received_idx" ON "messages" USING btree ("athlete_id","received_at");--> statement-breakpoint
CREATE INDEX "race_blocks_athlete_idx" ON "race_blocks" USING btree ("athlete_id");