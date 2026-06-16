import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { assertNotProductionDb } from "../db/test-guard.js";
import { athletes } from "../db/schema.js";
import { _resetProviderCache, mockProvider } from "../services/llm/index.js";
import { classifyAttachment, extractDocuments } from "./document.js";

describe("classifyAttachment (pure)", () => {
  test("text / docx / xlsx / pdf / image / fitness / unknown", () => {
    expect(classifyAttachment("https://x/p.txt", "text/plain").kind).toBe("text");
    expect(
      classifyAttachment(
        "https://x/m",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ).kind,
    ).toBe("docx");
    expect(
      classifyAttachment(
        "https://x/m",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ).kind,
    ).toBe("xlsx");
    expect(classifyAttachment("https://x/m", "application/pdf").kind).toBe("pdf");
    expect(classifyAttachment("https://x/run.gpx", undefined).kind).toBe("fitness");
    expect(classifyAttachment("https://x/m", "audio/ogg").kind).toBe("unknown");
    const img = classifyAttachment("https://x/m", "image/jpeg");
    expect(img.kind).toBe("image");
    if (img.kind === "image") expect(img.mediaType).toBe("image/jpeg");
  });
});

type Cfg = { accountSid: string; authToken: string };

describe("extractDocuments", () => {
  const realFetch = globalThis.fetch;
  const realSid = config.twilio.accountSid;
  const realToken = config.twilio.authToken;

  beforeAll(() => {
    (config.llm as { provider: "mock" | "anthropic" }).provider = "mock";
    _resetProviderCache();
  });
  beforeEach(async () => {
    assertNotProductionDb();
    await db.execute(sql`TRUNCATE TABLE llm_calls, athletes RESTART IDENTITY CASCADE`);
    mockProvider.reset();
    (config.twilio as Cfg).accountSid = "AC_test";
    (config.twilio as Cfg).authToken = "tok_test";
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    (config.twilio as Cfg).accountSid = realSid;
    (config.twilio as Cfg).authToken = realToken;
  });

  test("reads a single .txt (no LLM)", async () => {
    globalThis.fetch = (async () =>
      new Response("WEEK 1\nMon 5k easy", { status: 200 })) as unknown as typeof fetch;
    const r = await extractDocuments(
      [{ url: "https://x/plan.txt", contentType: "text/plain" }],
      { athleteId: "a", messageId: null },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toContain("WEEK 1");
      expect(r.fileCount).toBe(1);
    }
  });

  test("combines multiple files with labels", async () => {
    globalThis.fetch = (async (url: string) =>
      new Response(url.includes("a.txt") ? "FILE A" : "FILE B", {
        status: 200,
      })) as unknown as typeof fetch;
    const r = await extractDocuments(
      [
        { url: "https://x/a.txt", contentType: "text/plain" },
        { url: "https://x/b.txt", contentType: "text/plain" },
      ],
      { athleteId: "a", messageId: null },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.fileCount).toBe(2);
      expect(r.text).toContain("file 1 of 2");
      expect(r.text).toContain("FILE A");
      expect(r.text).toContain("FILE B");
    }
  });

  test("transcribes an image via the vision model", async () => {
    const [a] = await db
      .insert(athletes)
      .values({ phone: "whatsapp:+10000000000", athleticHistory: {} })
      .returning({ id: athletes.id });
    mockProvider.setResponses([
      { match: "Transcribe the attached file", text: "WEEK 1\nTue intervals 5x800m" },
    ]);
    globalThis.fetch = (async () =>
      new Response("rawimagebytes", { status: 200 })) as unknown as typeof fetch;
    const r = await extractDocuments(
      [{ url: "https://x/media", contentType: "image/png" }],
      { athleteId: a!.id, messageId: null },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toContain("5x800m");
    // The vision call must have gone to the configured vision model.
    expect(mockProvider.calls.some((c) => c.model === config.llm.visionModel)).toBe(true);
    expect(mockProvider.calls.some((c) => (c.media?.length ?? 0) > 0)).toBe(true);
  });

  test("only a fitness file → no_supported_files (not treated as a plan)", async () => {
    const r = await extractDocuments(
      [{ url: "https://x/run.gpx", contentType: "application/gpx+xml" }],
      { athleteId: "a", messageId: null },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no_supported_files");
  });

  test("missing Twilio creds → missing_credentials", async () => {
    (config.twilio as Cfg).accountSid = "";
    (config.twilio as Cfg).authToken = "";
    const r = await extractDocuments(
      [{ url: "https://x/plan.txt", contentType: "text/plain" }],
      { athleteId: "a", messageId: null },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("missing_credentials");
  });

  test("a corrupt docx is skipped gracefully → all_failed (no throw)", async () => {
    globalThis.fetch = (async () =>
      new Response("not really a docx", { status: 200 })) as unknown as typeof fetch;
    const r = await extractDocuments(
      [
        {
          url: "https://x/plan.docx",
          contentType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        },
      ],
      { athleteId: "a", messageId: null },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("all_failed");
  });
});
