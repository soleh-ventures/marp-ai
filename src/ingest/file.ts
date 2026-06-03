import { Buffer } from "node:buffer";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { activities } from "../db/schema.js";
import { parseGpx } from "./gpx.js";

// ET15 — runner-uploaded fitness file ingest (WhatsApp Media).
//
// Twilio captures the file URL in MediaUrl0. The URL is authenticated
// (Twilio Basic auth) — fetching needs the account SID + auth token.
// We download, sniff the format, parse, and persist into activities
// with the right source enum value.
//
// v1 scope:
//   - GPX: real parser (src/ingest/gpx.ts). Works for Garmin / Apple
//     Workouts / Strava / Wahoo / Polar exports.
//   - FIT: graceful reject. Binary format, needs a dedicated parser
//     library — out of scope for v1. We tell the runner to export GPX
//     from their watch app.
//   - TCX: graceful reject. Same reason as FIT — XML but with a
//     different schema; would need its own parser. Runners can usually
//     export GPX instead.
//
// Idempotency: source_id = the Twilio MediaUrl0 itself (which is
// unique per upload). Same media re-delivered → no-op via ON CONFLICT.

// Cap downloads at 5 MB. A long-run GPX is typically 200-500 KB; 5 MB
// is roomy for ultra distances while still bounding worst-case memory.
const MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

export type IngestResult =
  | { ok: true; inserted: boolean; discipline: string; distanceM: number; durationS: number; name?: string }
  | { ok: false; reason: IngestRejectReason; detail?: string };

export type IngestRejectReason =
  | "unsupported_format"
  | "download_failed"
  | "download_too_large"
  | "parse_failed"
  | "missing_credentials";

export async function ingestFileFromMediaUrl(
  athleteId: string,
  mediaUrl: string,
  contentType?: string,
): Promise<IngestResult> {
  const sid = config.twilio.accountSid;
  const token = config.twilio.authToken;
  if (!sid || !token) {
    return { ok: false, reason: "missing_credentials" };
  }

  const fetched = await fetchMedia(mediaUrl, sid, token);
  if (!fetched.ok) return fetched;

  const format = detectFormat(mediaUrl, contentType, fetched.text);
  if (format === "fit" || format === "tcx") {
    return {
      ok: false,
      reason: "unsupported_format",
      detail: format,
    };
  }
  if (format !== "gpx") {
    return { ok: false, reason: "unsupported_format", detail: "unknown" };
  }

  const parsed = parseGpx(fetched.text);
  if (!parsed.ok) {
    return { ok: false, reason: "parse_failed", detail: parsed.error.kind };
  }

  // Idempotency key: the MediaUrl0 itself. Same upload re-delivered
  // by Twilio's retry → silent no-op via the activities unique index
  // on (source, source_id).
  const sourceId = mediaUrl;

  // Compute pace + long-run flag the same way Strava ingest does so
  // memory context renders consistently across sources.
  const avgPaceSPerKm =
    parsed.value.distanceM > 0
      ? Math.round(parsed.value.durationS / (parsed.value.distanceM / 1000))
      : null;
  const longRun =
    parsed.value.discipline === "run" && parsed.value.distanceM >= 16_000;

  const inserted = await db
    .insert(activities)
    .values({
      athleteId,
      discipline: parsed.value.discipline,
      source: "gpx",
      sourceId,
      startedAt: parsed.value.startedAt,
      durationS: parsed.value.durationS,
      metrics: {
        distance_m: parsed.value.distanceM,
        avg_pace_s_per_km: avgPaceSPerKm,
        name: parsed.value.name ?? null,
      },
      longRun,
    })
    .onConflictDoNothing({ target: [activities.source, activities.sourceId] })
    .returning({ id: activities.id });

  return {
    ok: true,
    inserted: inserted.length > 0,
    discipline: parsed.value.discipline,
    distanceM: parsed.value.distanceM,
    durationS: parsed.value.durationS,
    ...(parsed.value.name ? { name: parsed.value.name } : {}),
  };
}

// ── Format detection ────────────────────────────────────────────────────

export function detectFormat(
  url: string,
  contentType: string | undefined,
  bodySample: string,
): "gpx" | "fit" | "tcx" | "unknown" {
  // URL extension is the cheapest, most reliable signal.
  const lcUrl = url.toLowerCase();
  if (lcUrl.endsWith(".gpx")) return "gpx";
  if (lcUrl.endsWith(".fit")) return "fit";
  if (lcUrl.endsWith(".tcx")) return "tcx";

  const lcType = (contentType ?? "").toLowerCase();
  if (lcType.includes("gpx")) return "gpx";
  if (lcType.includes("tcx")) return "tcx";
  if (lcType.includes("ant.fit") || lcType.includes("garmin.fit")) return "fit";

  // Content sniff. Both GPX and TCX are XML; FIT is binary starting
  // with a header that includes the ASCII string ".FIT" at offset 8.
  const head = bodySample.slice(0, 256);
  if (/<gpx[\s>]/i.test(head)) return "gpx";
  if (/<TrainingCenterDatabase[\s>]/i.test(head)) return "tcx";
  // FIT magic check is unreliable when we already coerced to a string,
  // but ".FIT" at the right offset is a strong-enough hint for the
  // common case.
  if (head.length >= 12 && head.slice(8, 12) === ".FIT") return "fit";

  return "unknown";
}

// ── Download with auth + caps ──────────────────────────────────────────

type FetchOk = { ok: true; text: string };
type FetchFail = { ok: false; reason: IngestRejectReason; detail?: string };

async function fetchMedia(
  url: string,
  sid: string,
  token: string,
): Promise<FetchOk | FetchFail> {
  const auth = Buffer.from(`${sid}:${token}`).toString("base64");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Basic ${auth}` },
      signal: controller.signal,
    });
    if (!res.ok) {
      return {
        ok: false,
        reason: "download_failed",
        detail: String(res.status),
      };
    }
    // Read with a hard byte cap. We can't fully trust Content-Length —
    // Twilio's media is on AWS S3-backed storage and tends to be
    // well-behaved, but a hostile redirect target could lie. Read
    // chunks and bail if we cross the cap.
    const reader = res.body?.getReader();
    if (!reader) {
      return { ok: false, reason: "download_failed", detail: "no body" };
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_DOWNLOAD_BYTES) {
        return { ok: false, reason: "download_too_large" };
      }
      chunks.push(value);
    }
    const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    const text = buffer.toString("utf-8");
    return { ok: true, text };
  } catch (err) {
    return {
      ok: false,
      reason: "download_failed",
      detail: (err as Error).message,
    };
  } finally {
    clearTimeout(timer);
  }
}
