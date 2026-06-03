import { describe, expect, test } from "bun:test";
import { detectFormat } from "./file.js";

// detectFormat is the only pure function in src/ingest/file.ts —
// everything else does network I/O and DB writes that are covered
// end-to-end through twilio.test.ts. We test the format detector
// here because it's the part most likely to misclassify a real
// runner upload and silently fall through to LLM routing.

describe("detectFormat", () => {
  test("URL extension wins: .gpx → gpx", () => {
    expect(detectFormat("https://x.example/abc.gpx", undefined, "")).toBe("gpx");
  });

  test("URL extension: .fit → fit", () => {
    expect(detectFormat("https://x.example/abc.fit", undefined, "")).toBe("fit");
  });

  test("URL extension: .tcx → tcx", () => {
    expect(detectFormat("https://x.example/abc.tcx", undefined, "")).toBe("tcx");
  });

  test("URL extension is case-insensitive", () => {
    expect(detectFormat("https://x.example/RUN.GPX", undefined, "")).toBe("gpx");
  });

  test("falls back to content-type when URL has no extension", () => {
    expect(
      detectFormat("https://x.example/media", "application/gpx+xml", ""),
    ).toBe("gpx");
    expect(
      detectFormat("https://x.example/media", "application/vnd.garmin.tcx+xml", ""),
    ).toBe("tcx");
    expect(
      detectFormat("https://x.example/media", "application/vnd.ant.fit", ""),
    ).toBe("fit");
  });

  test("falls back to content sniffing for XML formats", () => {
    const gpxBody = `<?xml version="1.0"?><gpx version="1.1">…</gpx>`;
    const tcxBody = `<?xml version="1.0"?><TrainingCenterDatabase>…</TrainingCenterDatabase>`;
    expect(detectFormat("https://x.example/media", undefined, gpxBody)).toBe("gpx");
    expect(detectFormat("https://x.example/media", undefined, tcxBody)).toBe("tcx");
  });

  test("returns unknown for unrecognised media (images, audio)", () => {
    expect(detectFormat("https://x.example/photo.jpg", "image/jpeg", "")).toBe(
      "unknown",
    );
    expect(detectFormat("https://x.example/voice.ogg", "audio/ogg", "")).toBe(
      "unknown",
    );
    expect(detectFormat("https://x.example/media", undefined, "random text")).toBe(
      "unknown",
    );
  });

  test("URL extension precedence: .gpx URL with wrong content-type still wins", () => {
    expect(
      detectFormat("https://x.example/abc.gpx", "application/octet-stream", ""),
    ).toBe("gpx");
  });
});
