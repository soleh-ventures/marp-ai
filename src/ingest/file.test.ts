import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { config } from "../config.js";
import {
  detectFormat,
  isTextDocument,
  isFitnessFile,
  fetchMediaBytes,
} from "./file.js";

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

// A long BYO plan sent as a text file (to dodge Twilio's 1600-char paste cap).
describe("isTextDocument", () => {
  test.each([
    ["https://api.twilio.com/Media/ME123.txt", undefined],
    ["https://x/file.TXT", undefined],
    ["https://x/plan.md", undefined],
    ["https://x/plan.csv", undefined],
    ["https://x/media/ME999", "text/plain"],
    ["https://x/media/ME999", "text/plain; charset=utf-8"],
  ])("treats %p (%p) as a text document", (url, ct) => {
    expect(isTextDocument(url, ct)).toBe(true);
  });

  test.each([
    ["https://x/run.gpx", "application/gpx+xml"],
    ["https://x/plan.pdf", "application/pdf"],
    ["https://x/photo.jpg", "image/jpeg"],
    ["https://x/media/ME1", undefined],
    ["https://x/media/ME1", "application/octet-stream"],
  ])("does NOT treat %p (%p) as a text document", (url, ct) => {
    expect(isTextDocument(url, ct)).toBe(false);
  });
});

describe("isFitnessFile", () => {
  test.each([
    ["https://x/run.gpx", undefined],
    ["https://x/a.fit", undefined],
    ["https://x/a.tcx", undefined],
    ["https://x/media", "application/gpx+xml"],
  ])("treats %p (%p) as a fitness file", (url, ct) => {
    expect(isFitnessFile(url, ct)).toBe(true);
  });

  test.each([
    ["https://x/plan.txt", "text/plain"],
    ["https://x/plan.pdf", "application/pdf"],
    ["https://x/photo.jpg", "image/jpeg"],
    ["https://x/plan.docx", undefined],
  ])("does NOT treat %p (%p) as a fitness file", (url, ct) => {
    expect(isFitnessFile(url, ct)).toBe(false);
  });
});

describe("fetchMediaBytes", () => {
  const realFetch = globalThis.fetch;
  const realSid = config.twilio.accountSid;
  const realToken = config.twilio.authToken;
  type Cfg = { accountSid: string; authToken: string };

  beforeEach(() => {
    (config.twilio as Cfg).accountSid = "AC_test";
    (config.twilio as Cfg).authToken = "tok_test";
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    (config.twilio as Cfg).accountSid = realSid;
    (config.twilio as Cfg).authToken = realToken;
  });

  test("downloads bytes (auth header set)", async () => {
    let auth = "";
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      auth = String((init.headers as Record<string, string>).Authorization);
      return new Response("hello bytes", { status: 200 });
    }) as unknown as typeof fetch;
    const r = await fetchMediaBytes("https://x/media");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.bytes.toString("utf-8")).toBe("hello bytes");
    expect(auth.startsWith("Basic ")).toBe(true);
  });

  test("download failure → download_failed (no throw)", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 404 })) as unknown as typeof fetch;
    const r = await fetchMediaBytes("https://x/media");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("download_failed");
  });

  test("missing Twilio creds → missing_credentials, no fetch", async () => {
    (config.twilio as Cfg).accountSid = "";
    (config.twilio as Cfg).authToken = "";
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("x", { status: 200 });
    }) as unknown as typeof fetch;
    const r = await fetchMediaBytes("https://x/media");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("missing_credentials");
    expect(called).toBe(false);
  });
});
