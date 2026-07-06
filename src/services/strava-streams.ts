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
// Deeper Garmin-only fields (Strava rows never carry these). All optional so
// old rows + renderStreamAnnotation stay valid.
export type Lap = {
  index: number; // 1-based lap/interval index (Garmin's own splits)
  distance_m: number;
  time_s: number;
  avg_hr: number | null;
  avg_pace_s_per_km: number | null;
};
export type HrZone = { zone: number; seconds: number; pct: number };
export type StreamSummary = {
  km_splits: KmSplit[];
  split_pattern: SplitPattern; // first half vs second half pace
  hr_drift_pct: number | null; // 2nd-half avg HR vs 1st-half, % (cardiac drift proxy)
  avg_hr: number | null;
  max_hr: number | null;
  total_distance_m: number;
  total_time_s: number;
  // ── deep channels (Garmin) ──
  laps?: Lap[]; // per-lap execution (from Garmin's typed splits)
  hr_zones?: HrZone[]; // time-in-zone distribution
  cadence?: { avg: number; stability_cv: number | null }; // CV = fade/consistency
  elev_gain_m?: number;
  elev_loss_m?: number;
};

// Extras Garmin provides directly (Strava doesn't) — laps + HR-zone seconds.
export type StreamExtras = {
  laps?: Lap[];
  hr_zone_seconds?: Array<{ zone: number; seconds: number }>;
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
export function summarizeStreams(
  streams: StravaStreams,
  extras?: StreamExtras,
): StreamSummary | null {
  const time = numArray(streams.time);
  const distance = numArray(streams.distance);
  if (!time || !distance || time.length !== distance.length || time.length < 2) {
    return null;
  }
  const hr = numArray(streams.heartrate);
  const cadenceArr = numArray(streams.cadence);
  const altitude = numArray(streams.altitude);
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
    // reduce, not Math.max(...hr) — a long activity is ~thousands of samples
    // and the arg-spread can blow the call stack.
    max_hr = Math.round(hr.reduce((a, b) => (b > a ? b : a), hr[0]!));
    // Non-overlapping halves — the boundary sample belongs to the first half
    // only (review: it was double-counted, biasing drift on short runs).
    const firstHr = mean(hr.slice(0, midIdx + 1));
    const secondHr = mean(hr.slice(midIdx + 1));
    if (firstHr && secondHr && firstHr > 0) {
      hr_drift_pct = Math.round(((secondHr - firstHr) / firstHr) * 1000) / 10;
    }
  }

  // Cadence stability: coefficient of variation (SD/mean). Low = metronomic,
  // high = ragged form / walk breaks. Garmin gives per-sample cadence; Strava
  // usually doesn't (channel absent → undefined, not misleading zeros).
  let cadence: { avg: number; stability_cv: number | null } | undefined;
  if (cadenceArr && cadenceArr.length > 1) {
    const m = mean(cadenceArr) ?? 0;
    if (m > 0) {
      const variance =
        cadenceArr.reduce((a, b) => a + (b - m) * (b - m), 0) / cadenceArr.length;
      cadence = {
        avg: Math.round(m),
        stability_cv: Math.round((Math.sqrt(variance) / m) * 1000) / 1000,
      };
    }
  }

  // Elevation gain/loss from the altitude channel (sum of positive/negative
  // deltas). Cheap and matches how watches report it.
  let elev_gain_m: number | undefined;
  let elev_loss_m: number | undefined;
  if (altitude && altitude.length > 1) {
    let gain = 0;
    let loss = 0;
    for (let i = 1; i < altitude.length; i++) {
      const d = altitude[i]! - altitude[i - 1]!;
      if (d > 0) gain += d;
      else loss -= d;
    }
    elev_gain_m = Math.round(gain);
    elev_loss_m = Math.round(loss);
  }

  // HR zones: convert Garmin's seconds-in-zone into {seconds, pct}.
  let hr_zones: HrZone[] | undefined;
  if (extras?.hr_zone_seconds && extras.hr_zone_seconds.length > 0) {
    const totalZ = extras.hr_zone_seconds.reduce((a, z) => a + z.seconds, 0);
    if (totalZ > 0) {
      hr_zones = extras.hr_zone_seconds.map((z) => ({
        zone: z.zone,
        seconds: Math.round(z.seconds),
        pct: Math.round((z.seconds / totalZ) * 1000) / 10,
      }));
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
    ...(extras?.laps && extras.laps.length > 0 ? { laps: extras.laps } : {}),
    ...(hr_zones ? { hr_zones } : {}),
    ...(cadence ? { cadence } : {}),
    ...(elev_gain_m !== undefined ? { elev_gain_m } : {}),
    ...(elev_loss_m !== undefined ? { elev_loss_m } : {}),
  };
}

// ── Fetch (best-effort, rate-limit aware) ──────────────────────────────────

export type StreamFetchResult =
  | { ok: true; summary: StreamSummary | null }
  | { ok: false; reason: "rate_limited" | "no_streams" | "unauthorized" | "error" };

// GET /activities/{id}/streams. Returns a summary, or a typed reason
// (rate_limited / unauthorized / no_streams / error). The backfill reacts to
// the rate_limited reason (Strava: 100 req/15min, 1000/day per app) by
// stopping, on top of a fixed inter-call delay.
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
  // 401 = the access token expired/was revoked. Distinguished so a long
  // backfill can refresh-or-abort instead of silently churning dead calls.
  if (res.status === 401) return { ok: false, reason: "unauthorized" };
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
  for (const r of rows) {
    const s = r.summary as StreamSummary;
    // Shape-guard the jsonb read — a malformed/old-shape row must not flow
    // into renderStreamAnnotation (which runs inside the un-try-wrapped
    // context build).
    if (s && Array.isArray(s.km_splits)) out.set(r.activityId, s);
  }
  return out;
}

// One-line coach-facing annotation of a stream summary: split pattern, HR
// drift, and the fastest/slowest km. Compact enough to append to an activity
// line in context. Returns "" when there's nothing worth saying.
export function renderStreamAnnotation(s: StreamSummary): string {
  if (!s || !Array.isArray(s.km_splits)) return ""; // defend against bad jsonb
  const bits: string[] = [];
  if (s.split_pattern !== "even") bits.push(`${s.split_pattern} split`);
  if (s.hr_drift_pct !== null && Math.abs(s.hr_drift_pct) >= 3) {
    bits.push(`HR drift ${s.hr_drift_pct > 0 ? "+" : ""}${s.hr_drift_pct}%`);
  }
  const fmt = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}`;
  if (s.km_splits.length >= 2) {
    const paces = s.km_splits.map((k) => k.pace_s_per_km);
    bits.push(`km ${fmt(Math.min(...paces))}–${fmt(Math.max(...paces))}`);
  }
  // Deep channels (Garmin) — only rendered when present.
  if (s.cadence && s.cadence.stability_cv !== null) {
    const cv = s.cadence.stability_cv;
    const tag = cv <= 0.05 ? "metronomic" : cv >= 0.12 ? "ragged" : "steady";
    bits.push(`cadence ${s.cadence.avg}spm (${tag})`);
  }
  if (s.hr_zones && s.hr_zones.length > 0) {
    const top = [...s.hr_zones].sort((a, b) => b.seconds - a.seconds)[0]!;
    bits.push(`mostly Z${top.zone} (${top.pct}%)`);
  }
  if (s.elev_gain_m !== undefined && s.elev_gain_m >= 30) {
    bits.push(`+${s.elev_gain_m}m elev`);
  }
  if (s.laps && s.laps.length >= 2) bits.push(`${s.laps.length} laps`);
  return bits.join(", ");
}

// Full multi-line stream detail for a deep "analyze my run" read — the coach
// gets the whole picture (every lap, the zone split, drift, cadence) instead
// of the compact one-liner. Still summary-level; never the raw per-second data.
export function renderDeepStreamDetail(s: StreamSummary): string {
  if (!s || !Array.isArray(s.km_splits)) return "";
  const fmt = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}`;
  const lines: string[] = [];
  lines.push(
    `Distance ${(s.total_distance_m / 1000).toFixed(2)}km in ${fmt(s.total_time_s)}` +
      (s.avg_hr ? `, avg HR ${s.avg_hr}${s.max_hr ? `/max ${s.max_hr}` : ""}` : ""),
  );
  lines.push(`Split pattern: ${s.split_pattern}${s.hr_drift_pct !== null ? `, cardiac drift ${s.hr_drift_pct > 0 ? "+" : ""}${s.hr_drift_pct}%` : ""}`);
  if (s.km_splits.length > 0) {
    lines.push(
      "Per-km: " +
        s.km_splits
          .map((k) => `${k.km}:${fmt(k.pace_s_per_km)}${k.avg_hr ? `@${k.avg_hr}` : ""}`)
          .join("  "),
    );
  }
  if (s.laps && s.laps.length > 0) {
    lines.push(
      "Laps: " +
        s.laps
          .map(
            (l) =>
              `L${l.index} ${(l.distance_m / 1000).toFixed(2)}km ${fmt(l.time_s)}` +
              (l.avg_pace_s_per_km ? ` ${fmt(l.avg_pace_s_per_km)}/km` : "") +
              (l.avg_hr ? `@${l.avg_hr}` : ""),
          )
          .join("  "),
    );
  }
  if (s.hr_zones && s.hr_zones.length > 0) {
    lines.push("HR zones: " + s.hr_zones.map((z) => `Z${z.zone} ${z.pct}%`).join("  "));
  }
  if (s.cadence) {
    lines.push(
      `Cadence: ${s.cadence.avg}spm` +
        (s.cadence.stability_cv !== null ? ` (CV ${s.cadence.stability_cv})` : ""),
    );
  }
  if (s.elev_gain_m !== undefined) lines.push(`Elevation: +${s.elev_gain_m}m / -${s.elev_loss_m ?? 0}m`);
  return lines.join("\n");
}

// Persist a streams summary for an activity. Upsert so a re-summarize (e.g.
// the richer Garmin shape landing after an old Strava row, or a shape
// extension) refreshes rather than silently keeping the stale summary.
export async function storeActivityStreams(
  activityId: string,
  summary: StreamSummary,
): Promise<void> {
  await db
    .insert(activityStreams)
    .values({ activityId, summary })
    .onConflictDoUpdate({
      target: activityStreams.activityId,
      set: { summary },
    });
}

// Best-effort: fetch + summarize + store an activity's streams. Wrapped so a
// failure (rate limit, sparse data, network) NEVER affects the ingest path or
// the runner's reply. Returns what happened, for logging.
export async function captureActivityStreams(input: {
  accessToken: string;
  stravaActivityId: number;
  activityRowId: string;
}): Promise<"stored" | "no_streams" | "rate_limited" | "unauthorized" | "error"> {
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
