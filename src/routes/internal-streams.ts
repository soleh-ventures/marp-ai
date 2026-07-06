// Internal stream-summarize endpoint (deep workout analysis, option B).
//
// The Garmin sidecar can't run the TS summarizer, and we refuse to duplicate
// the splits/drift math in Python (it must stay in lockstep with
// renderStreamAnnotation). So the sidecar POSTs normalized per-sample channels
// here; this route runs the ONE pure summarizeStreams + stores the compact
// result in activity_streams. The raw channels are summarized then discarded —
// never persisted, never sent to the LLM.
//
// Auth: same X-Cron-Secret / CRON_SECRET as the cron route (internal traffic).

import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { activities } from "../db/schema.js";
import {
  storeActivityStreams,
  summarizeStreams,
  type Lap,
  type StravaStreams,
} from "../services/strava-streams.js";

export const internalStreams = new Hono();

type SummarizeBody = {
  source: string; // "garmin"
  source_id: string; // provider activity id
  // Channels in the strava-streams shape: { data: number[] } per key.
  streams: StravaStreams;
  laps?: Lap[];
  hr_zone_seconds?: Array<{ zone: number; seconds: number }>;
};

internalStreams.post("/summarize", async (c) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) return c.text("not configured", 503);
  if (c.req.header("X-Cron-Secret") !== secret) return c.text("forbidden", 403);

  const body = (await c.req.json().catch(() => null)) as SummarizeBody | null;
  if (!body || !body.source || !body.source_id || !body.streams) {
    return c.json({ ok: false, error: "bad_request" }, 400);
  }

  // Resolve the activity row this summary belongs to.
  const [row] = await db
    .select({ id: activities.id })
    .from(activities)
    .where(
      and(
        eq(activities.source, body.source as "garmin"),
        eq(activities.sourceId, body.source_id),
      ),
    )
    .limit(1);
  if (!row) return c.json({ ok: false, error: "activity_not_found" }, 404);

  const summary = summarizeStreams(body.streams, {
    laps: body.laps,
    hr_zone_seconds: body.hr_zone_seconds,
  });
  if (!summary) return c.json({ ok: true, stored: false, reason: "no_summary" });

  await storeActivityStreams(row.id, summary);
  return c.json({ ok: true, stored: true });
});
