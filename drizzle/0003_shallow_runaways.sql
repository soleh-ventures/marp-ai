DROP INDEX "activities_source_source_id_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "activities_source_source_id_idx" ON "activities" USING btree ("source","source_id");