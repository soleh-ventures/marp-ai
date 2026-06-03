import { describe, expect, test } from "bun:test";
import { parseGpx } from "./gpx.js";

// A tiny but realistic GPX 1.1 sample. Three trackpoints along a 1°
// latitude line so the Haversine math gives a known distance
// (~111 km per degree of latitude at the equator) — but our trkpts
// span 0.001° (~111 m), which keeps the test arithmetic checkable
// while staying realistic for a short run interval.
const SIMPLE_RUN_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test">
  <metadata>
    <name>Morning Run</name>
    <time>2026-04-01T06:00:00Z</time>
  </metadata>
  <trk>
    <name>Loop</name>
    <type>Running</type>
    <trkseg>
      <trkpt lat="0.000000" lon="0.000000"><time>2026-04-01T06:00:00Z</time></trkpt>
      <trkpt lat="0.001000" lon="0.000000"><time>2026-04-01T06:00:30Z</time></trkpt>
      <trkpt lat="0.002000" lon="0.000000"><time>2026-04-01T06:01:00Z</time></trkpt>
    </trkseg>
  </trk>
</gpx>`;

const RIDE_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test"><trk><type>Cycling</type><trkseg>
  <trkpt lat="0.0" lon="0.0"><time>2026-04-01T06:00:00Z</time></trkpt>
  <trkpt lat="0.01" lon="0.0"><time>2026-04-01T06:30:00Z</time></trkpt>
</trkseg></trk></gpx>`;

describe("parseGpx", () => {
  test("happy path: extracts start, duration, distance, discipline", () => {
    const r = parseGpx(SIMPLE_RUN_GPX);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");

    expect(r.value.discipline).toBe("run");
    expect(r.value.startedAt.toISOString()).toBe("2026-04-01T06:00:00.000Z");
    expect(r.value.durationS).toBe(60);
    // Each 0.001° latitude step is ~111.32 m at the equator. Two steps
    // ≈ 222 m. Allow ±5 m tolerance for the Earth-radius approximation.
    expect(r.value.distanceM).toBeGreaterThan(217);
    expect(r.value.distanceM).toBeLessThan(228);
  });

  test("maps <type>Cycling</type> to discipline=ride", () => {
    const r = parseGpx(RIDE_GPX);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.value.discipline).toBe("ride");
  });

  test("defaults discipline to 'run' when no <type> is present", () => {
    const noType = SIMPLE_RUN_GPX.replace("<type>Running</type>", "");
    const r = parseGpx(noType);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.value.discipline).toBe("run");
  });

  test("returns not_gpx error when the document has no <gpx> root", () => {
    const r = parseGpx("<?xml version=\"1.0\"?><other></other>");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected error");
    expect(r.error.kind).toBe("not_gpx");
  });

  test("returns no_trkpts error when there are zero trackpoints", () => {
    const empty = `<gpx version="1.1"><trk><type>Running</type><trkseg></trkseg></trk></gpx>`;
    const r = parseGpx(empty);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected error");
    expect(r.error.kind).toBe("no_trkpts");
  });

  test("returns bad_timestamps error when start >= end", () => {
    const reversed = `<gpx><trk><type>Running</type><trkseg>
      <trkpt lat="0" lon="0"><time>2026-04-01T07:00:00Z</time></trkpt>
      <trkpt lat="0" lon="0"><time>2026-04-01T06:00:00Z</time></trkpt>
    </trkseg></trk></gpx>`;
    const r = parseGpx(reversed);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected error");
    expect(r.error.kind).toBe("bad_timestamps");
  });

  test("captures the track <name> when present", () => {
    const r = parseGpx(SIMPLE_RUN_GPX);
    if (!r.ok) throw new Error("expected ok");
    // First <name> match — the metadata one ("Morning Run") since it
    // appears earlier in the document.
    expect(r.value.name).toBe("Morning Run");
  });

  test("tolerates lat/lon with surrounding whitespace in attribute quotes", () => {
    const padded = SIMPLE_RUN_GPX.replace(
      'lat="0.000000"',
      'lat="0.000000" ',
    );
    const r = parseGpx(padded);
    expect(r.ok).toBe(true);
  });
});
