// Minimal GPX 1.1 parser. We don't need a full XML library — GPX is
// well-structured and the fields we want (trkpt lat/lon/time, optional
// <type>) are extractable with focused regexes against the raw text.
// Trade-off: this won't handle every malformed GPX in the wild, but it
// handles every well-formed GPX exported by Garmin / Strava / Apple
// Workouts / Wahoo / Polar, which is what runners actually send.
//
// What we extract:
//   - First & last trkpt timestamps → start_time + duration
//   - Sum of Haversine distances between consecutive trkpts → distance_m
//   - Optional <type> at the track level → discipline mapping
//   - Optional <name> at the metadata or track level → activity name
//
// What we deliberately don't extract (yet):
//   - Heart rate (lives in <extensions> with ns-prefixed elements like
//     gpxtpx:hr — adding a real XML parser to do this right isn't worth
//     it for v1)
//   - Elevation gain (requires summing positive deltas over a smoothed
//     elevation profile; out of scope)
//   - Cadence / power (same as HR — extensions)
// These can be backfilled later by storing rawPayload and re-parsing.

export type GpxParsed = {
  startedAt: Date;
  durationS: number;
  distanceM: number;
  discipline: string;
  name?: string;
};

export type GpxParseError =
  | { kind: "not_gpx"; reason: string }
  | { kind: "no_trkpts"; reason: string }
  | { kind: "bad_timestamps"; reason: string };

export type GpxParseResult =
  | { ok: true; value: GpxParsed }
  | { ok: false; error: GpxParseError };

const TRKPT_RE =
  /<trkpt\s[^>]*?lat\s*=\s*"([^"]+)"[^>]*?lon\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/trkpt>/gi;
const TIME_INSIDE_TRKPT_RE = /<time>\s*([^<]+?)\s*<\/time>/i;
const TYPE_RE = /<type>\s*([^<]+?)\s*<\/type>/i;
const NAME_RE = /<name>\s*([^<]+?)\s*<\/name>/i;

// GPX <type> → MARP's discipline vocabulary. Mirrors the Strava sport
// mapping (see strava-activities.ts) so the same activity recorded
// across either platform looks the same in MARP's memory.
const TYPE_TO_DISCIPLINE: Record<string, string> = {
  running: "run",
  run: "run",
  trail: "run",
  "trail run": "run",
  walking: "walk",
  walk: "walk",
  hiking: "hike",
  hike: "hike",
  cycling: "ride",
  ride: "ride",
  biking: "ride",
  mtb: "ride",
  swimming: "swim",
  swim: "swim",
};

export function parseGpx(raw: string): GpxParseResult {
  if (!/<gpx[\s>]/i.test(raw)) {
    return { ok: false, error: { kind: "not_gpx", reason: "no <gpx> root" } };
  }

  const points: Array<{ lat: number; lon: number; time: Date | null }> = [];
  let m: RegExpExecArray | null;
  TRKPT_RE.lastIndex = 0;
  while ((m = TRKPT_RE.exec(raw)) !== null) {
    const lat = Number.parseFloat(m[1] ?? "");
    const lon = Number.parseFloat(m[2] ?? "");
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const inner = m[3] ?? "";
    const timeMatch = inner.match(TIME_INSIDE_TRKPT_RE);
    let time: Date | null = null;
    if (timeMatch?.[1]) {
      const parsed = new Date(timeMatch[1]);
      if (!Number.isNaN(parsed.getTime())) time = parsed;
    }
    points.push({ lat, lon, time });
  }
  if (points.length === 0) {
    return { ok: false, error: { kind: "no_trkpts", reason: "no trackpoints" } };
  }

  const firstTime = points.find((p) => p.time !== null)?.time;
  const lastTime = [...points].reverse().find((p) => p.time !== null)?.time;
  if (!firstTime || !lastTime || lastTime <= firstTime) {
    return {
      ok: false,
      error: { kind: "bad_timestamps", reason: "no valid time range" },
    };
  }
  const durationS = Math.round((lastTime.getTime() - firstTime.getTime()) / 1000);

  let distanceM = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!;
    const b = points[i]!;
    distanceM += haversineMeters(a.lat, a.lon, b.lat, b.lon);
  }

  const typeMatch = raw.match(TYPE_RE);
  const discipline = typeMatch?.[1]
    ? TYPE_TO_DISCIPLINE[typeMatch[1].trim().toLowerCase()] ?? "run"
    : "run";

  const nameMatch = raw.match(NAME_RE);
  const name = nameMatch?.[1]?.trim();

  return {
    ok: true,
    value: {
      startedAt: firstTime,
      durationS,
      distanceM: Math.round(distanceM),
      discipline,
      ...(name ? { name } : {}),
    },
  };
}

// Great-circle distance between two lat/lon points in meters. Standard
// Haversine — accurate enough for run-track summation at the ~0.5%
// level, which is way under the GPS noise floor anyway.
function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6_371_000; // mean Earth radius in meters
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}
