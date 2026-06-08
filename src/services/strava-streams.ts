// KER-80 (Grounded Coach, Phase 3) — Strava activity streams → summary.
//
// The summary metrics MARP stores per activity (avg pace/HR) can't tell a
// negative split from a positive one, or catch HR drift — the things a coach
// actually reads. Strava's streams endpoint returns per-sample time-series;
// this module fetches it and SUMMARIZES at ingest into a compact shape
// (per-km splits, HR drift, split pattern). We never feed the raw per-second
// arrays to the LLM (a 90-min run is ~5k samples × N channels); only the
// summary reaches the coaching context + the post-run read.

import { eq, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { activityStreams } from "../db/schema.js";

// ── Raw streams shape (Strava `?keys=...&key_by_type=true`) ────────────────
type StreamChannel = { data?: unknown };
export type StravaStreams = Record<string, StreamChannel | undefined>;

const STREAM_KEYS = "time,distance,heartrate,velocity_smooth,altitude,cadence";

// ── Summary shape (what we persist + surface) ──────────────────────────────
export type KmSplit = {
  km: number; // 1-based km index
  pace_s_per_km: number; // seconds for this km
  avg_hr: number | null;
};
export type SplitPattern = "negative" | "even" | "positive";
export type StreamSummary = {
  km_splits: KmSplit[];
  split_pattern: SplitPattern; // first half vs second half pace
  hr_drift_pct: number | null; // 2nd-half avg HR vs 1st-half, % (cardiac drift proxy)
  avg_hr: number | null;
  max_hr: number | null;
  total_distance_m: number;
  total_time_s: number;
};

function numArray(ch: StreamChannel | undefined): number[] | null {
  if (!ch || !Array.isArray(ch.data)) return null;
  const arr = ch.data.filter((v): v is number => typeof v === "number");
  return arr.length > 0 ? arr : null;
}

function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

// Pure. Returns null when the streams can't yield splits (no time/distance —
// e.g. a manual entry, a treadmill run with no distance stream, or a sparse
// privacy-zoned activity).
export function summarizeStreams(streams: StravaStreams): StreamSummary | null {
  const time = numArray(streams.time);
  const distance = numArray(streams.distance);
  if (!time || !distance || time.length !== distance.length || time.length < 2) {
    return null;
  }
  const hr = numArray(streams.heartrate);
  const n = time.length;

  // Per-km splits: each time the cumulative distance crosses a km boundary,
  // close the current km and record its elapsed time + avg HR.
  const km_splits: KmSplit[] = [];
  let kmStartIdx = 0;
  let nextBoundary = 1000;
  for (let i = 0; i < n; i++) {
    if (distance[i]! >= nextBoundary) {
      const paceS = time[i]! - time[kmStartIdx]!;
      const hrSeg = hr ? hr.slice(kmStartIdx, i + 1) : [];
      const avgHr = hr ? mean(hrSeg) : null;
      km_splits.push({
        km: km_splits.length + 1,
        pace_s_per_km: Math.round(paceS),
        avg_hr: avgHr === null ? null : Math.round(avgHr),
      });
      kmStartIdx = i;
      nextBoundary += 1000;
    }
  }

  const total_distance_m = Math.round(distance[n - 1]! - distance[0]!);
  const total_time_s = Math.round(time[n - 1]! - time[0]!);

  // Split pattern: compare avg pace of the first vs second half of the run,
  // measured by elapsed time (robust when km splits are few).
  const midTime = time[0]! + total_time_s / 2;
  let midIdx = n - 1;
  for (let i = 0; i < n; i++) {
    if (time[i]! >= midTime) {
      midIdx = i;
      break;
    }
  }
  const firstDist = distance[midIdx]! - distance[0]!;
  const firstTime = time[midIdx]! - time[0]!;
  const secondDist = distance[n - 1]! - distance[midIdx]!;
  const secondTime = time[n - 1]! - time[midIdx]!;
  let split_pattern: SplitPattern = "even";
  if (firstDist > 0 && secondDist > 0) {
    const firstPace = firstTime / firstDist; // s per m
    const secondPace = secondTime / secondDist;
    const delta = (secondPace - firstPace) / firstPace; // >0 = slowed down
    if (delta < -0.02) split_pattern = "negative"; // sped up in 2nd half
    else if (delta > 0.02) split_pattern = "positive"; // slowed down
  }

  // HR drift: 2nd-half avg HR vs 1st-half, as a cardiac-drift proxy.
  let hr_drift_pct: number | null = null;
  let avg_hr: number | null = null;
  let max_hr: number | null = null;
  if (hr) {
    avg_hr = Math.round(mean(hr) ?? 0);
    max_hr = Math.round(Math.max(...hr));
    const firstHr = mean(hr.slice(0, midIdx + 1));
    const secondHr = mean(hr.slice(midIdx));
    if (firstHr && secondHr && firstHr > 0) {
      hr_drift_pct = Math.round(((secondHr - firstHr) / firstHr) * 1000) / 10;
    }
  }

  return {
    km_splits,
    split_pattern,
    hr_drift_pct,
    avg_hr,
    max_hr,
    total_distance_m,
    total_time_s,
  };
}

// ── Fetch (best-effort, rate-limit aware) ──────────────────────────────────

export type StreamFetchResult =
  | { ok: true; summary: StreamSummary | null }
  | { ok: false; reason: "rate_limited" | "no_streams" | "error" };

// GET /activities/{id}/streams. Returns a summary, or a typed reason. Reads
// the X-RateLimit-Usage / -Limit headers so a backfill can back off before
// Strava starts 429-ing (100 req/15min, 1000/day per app).
export async function fetchActivityStreams(
  accessToken: string,
  activityId: number,
): Promise<StreamFetchResult> {
  let res: Response;
  try {
    res = await fetch(
      `https://www.strava.com/api/v3/activities/${activityId}/streams?keys=${STREAM_KEYS}&key_by_type=true`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
  } catch {
    return { ok: false, reason: "error" };
  }
  if (res.status === 429) return { ok: false, reason: "rate_limited" };
  if (!res.ok) return { ok: false, reason: "error" };
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { ok: false, reason: "error" };
  }
  if (!json || typeof json !== "object") return { ok: false, reason: "no_streams" };
  const summary = summarizeStreams(json as StravaStreams);
  return { ok: true, summary };
}

// Load stored stream summaries for a set of activity ids → Map keyed by
// activityId. Empty map when none. Used to surface splits/drift in the
// coaching context and the weekly evaluation.
export async function loadStreamSummaries(
  activityIds: string[],
): Promise<Map<string, StreamSummary>> {
  const out = new Map<string, StreamSummary>();
  if (activityIds.length === 0) return out;
  const rows = await db
    .select({ activityId: activityStreams.activityId, summary: activityStreams.summary })
    .from(activityStreams)
    .where(inArray(activityStreams.activityId, activityIds));
  for (const r of rows) out.set(r.activityId, r.summary as StreamSummary);
  return out;
}

// One-line coach-facing annotation of a stream summary: split pattern, HR
// drift, and the fastest/slowest km. Compact enough to append to an activity
// line in context. Returns "" when there's nothing worth saying.
export function renderStreamAnnotation(s: StreamSummary): string {
  const bits: string[] = [];
  if (s.split_pattern !== "even") bits.push(`${s.split_pattern} split`);
  if (s.hr_drift_pct !== null && Math.abs(s.hr_drift_pct) >= 3) {
    bits.push(`HR drift ${s.hr_drift_pct > 0 ? "+" : ""}${s.hr_drift_pct}%`);
  }
  if (s.km_splits.length >= 2) {
    const paces = s.km_splits.map((k) => k.pace_s_per_km);
    const fast = Math.min(...paces);
    const slow = Math.max(...paces);
    const fmt = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}`;
    bits.push(`km ${fmt(fast)}–${fmt(slow)}`);
  }
  return bits.join(", ");
}

// Persist a streams summary for an activity (idempotent per activity).
export async function storeActivityStreams(
  activityId: string,
  summary: StreamSummary,
): Promise<void> {
  await db
    .insert(activityStreams)
    .values({ activityId, summary })
    .onConflictDoNothing({ target: activityStreams.activityId });
}

// Best-effort: fetch + summarize + store an activity's streams. Wrapped so a
// failure (rate limit, sparse data, network) NEVER affects the ingest path or
// the runner's reply. Returns what happened, for logging.
export async function captureActivityStreams(input: {
  accessToken: string;
  stravaActivityId: number;
  activityRowId: string;
}): Promise<"stored" | "no_streams" | "rate_limited" | "error"> {
  try {
    const res = await fetchActivityStreams(input.accessToken, input.stravaActivityId);
    if (!res.ok) return res.reason;
    if (!res.summary) return "no_streams";
    await storeActivityStreams(input.activityRowId, res.summary);
    return "stored";
  } catch {
    return "error";
  }
}

// True when the rate-limit headers say we're close to the 15-min cap and a
// backfill should pause. Strava sends "X-RateLimit-Usage: short,daily" and
// "X-RateLimit-Limit: short,daily".
export function nearRateLimit(headers: Headers, marginPct = 0.9): boolean {
  const usage = headers.get("x-ratelimit-usage");
  const limit = headers.get("x-ratelimit-limit");
  if (!usage || !limit) return false;
  const [uShort, uDaily] = usage.split(",").map((s) => parseInt(s, 10));
  const [lShort, lDaily] = limit.split(",").map((s) => parseInt(s, 10));
  const shortHot = lShort && uShort !== undefined ? uShort / lShort >= marginPct : false;
  const dailyHot = lDaily && uDaily !== undefined ? uDaily / lDaily >= marginPct : false;
  return shortHot || dailyHot;
}
