CREATE TABLE "strava_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"athlete_id" uuid NOT NULL,
	"strava_athlete_id" bigint NOT NULL,
	"encrypted_access_token" text NOT NULL,
	"encrypted_refresh_token" text NOT NULL,
	"token_expires_at" timestamp with time zone NOT NULL,
	"scope" text NOT NULL,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_refreshed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "strava_connections_athlete_id_unique" UNIQUE("athlete_id")
);
--> statement-breakpoint
CREATE TABLE "strava_webhook_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_id" integer NOT NULL,
	"callback_url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "strava_webhook_config_subscription_id_unique" UNIQUE("subscription_id")
);
--> statement-breakpoint
ALTER TABLE "strava_connections" ADD CONSTRAINT "strava_connections_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "strava_connections_strava_athlete_idx" ON "strava_connections" USING btree ("strava_athlete_id");--> statement-breakpoint
CREATE INDEX "strava_connections_refresh_due_idx" ON "strava_connections" USING btree ("token_expires_at");