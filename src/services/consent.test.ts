import { beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { assertNotProductionDb } from "../db/test-guard.js";
import { athletes } from "../db/schema.js";
import {
  classifyConsentReply,
  CONSENT_AMBIGUOUS_REPLY,
  CONSENT_DECLINED_REPLY,
  PRIVACY_NOTICE,
  Q_CONSENT,
  recordConsentGranted,
} from "./consent.js";

beforeEach(async () => {
  assertNotProductionDb();
  await db.execute(sql`
    TRUNCATE TABLE
      llm_calls, processed_messages, messages, active_flags,
      activities, race_blocks, strava_connections,
      pending_decisions, athletes
    RESTART IDENTITY CASCADE
  `);
});

// ── Copy guarantees ─────────────────────────────────────────────────────

describe("privacy copy", () => {
  test("notice surfaces the right-to-delete in the same message", () => {
    // The whole point of the notice is informed consent + a visible
    // escape hatch. If we ever drop the deletion mention, GDPR-wise
    // we're back to a one-way "trust us" — fail the test loudly.
    expect(PRIVACY_NOTICE.toLowerCase()).toContain("delete");
    expect(PRIVACY_NOTICE.toLowerCase()).toContain("anytime");
  });

  test("notice asks for an explicit YES (no implicit consent)", () => {
    expect(PRIVACY_NOTICE).toContain("YES");
    expect(PRIVACY_NOTICE).toContain("STOP");
  });

  test("notice names the data we collect (no generic legalese)", () => {
    // "messages, runs, profile" — be specific so a runner knows what
    // they're consenting to.
    expect(PRIVACY_NOTICE.toLowerCase()).toContain("messages");
    expect(PRIVACY_NOTICE.toLowerCase()).toContain("runs");
    expect(PRIVACY_NOTICE.toLowerCase()).toContain("profile");
  });

  test("notice names what we DON'T do (selling)", () => {
    expect(PRIVACY_NOTICE.toLowerCase()).toContain("never");
    expect(PRIVACY_NOTICE.toLowerCase()).toContain("sold");
  });

  test("consent buttons type the canonical words the classifier accepts", () => {
    // Taps ARE typed answers: "yes" and "stop" must classify cleanly, or a
    // button tap would fall into the ambiguous re-prompt loop.
    expect(classifyConsentReply("yes")).toBe("accept");
    expect(classifyConsentReply("stop")).toBe("decline");
    expect(Q_CONSENT.choices.map((c) => c.value)).toEqual(["yes", "stop"]);
  });

  test("declined reply confirms data won't be stored", () => {
    expect(CONSENT_DECLINED_REPLY.toLowerCase()).toContain("won't be stored");
  });

  test("ambiguous reply contains the notice itself (so the runner sees it again)", () => {
    expect(CONSENT_AMBIGUOUS_REPLY).toContain(PRIVACY_NOTICE);
  });
});

// ── Intent classifier ──────────────────────────────────────────────────

describe("classifyConsentReply — accept patterns", () => {
  test.each([
    "yes",
    "YES",
    "Yes please",
    "yeah",
    "yep",
    "sure",
    "ok",
    "ok let's go",
    "i agree",
    "agreed",
    "sounds good",
  ])("treats %s as accept", (input) => {
    expect(classifyConsentReply(input)).toBe("accept");
  });
});

describe("classifyConsentReply — decline patterns", () => {
  test.each([
    "stop",
    "STOP",
    "no",
    "Nope",
    "opt out",
    "not interested",
    "cancel",
  ])("treats %s as decline", (input) => {
    expect(classifyConsentReply(input)).toBe("decline");
  });
});

describe("classifyConsentReply — ambiguous fallback", () => {
  test.each([
    "hi",
    "what is this",
    "tell me more",
    "maybe",
    "depends",
    "🤔",
  ])("treats %s as ambiguous (we re-prompt rather than guess)", (input) => {
    expect(classifyConsentReply(input)).toBe("ambiguous");
  });

  // v1 limitation: a qualified opener like "yes but only for X" still
  // matches the leading "yes" pattern → accept. Treating these as
  // ambiguous would require natural-language parsing of qualifiers,
  // and "yes" without qualifiers is overwhelmingly the common case.
  // Documented here so a future tightening pass has a target.
  test("known limitation: qualified yes ('yes but only for X') treated as accept", () => {
    expect(classifyConsentReply("yes but only for activities")).toBe("accept");
  });

  test("does NOT match 'yes' inside a longer answer that isn't an opener", () => {
    // The patterns anchor at start-of-string — "I might say yes later"
    // shouldn't auto-consent.
    expect(classifyConsentReply("I might say yes later")).toBe("ambiguous");
  });
});

// ── Persistence ────────────────────────────────────────────────────────

describe("recordConsentGranted", () => {
  test("sets consent_granted_at on the athlete row", async () => {
    const [a] = await db
      .insert(athletes)
      .values({ phone: "+15551110700" })
      .returning();
    if (!a) throw new Error("insert failed");
    expect(a.consentGrantedAt).toBeNull();

    await recordConsentGranted(a.id);

    const [after] = await db
      .select()
      .from(athletes)
      .where(eq(athletes.id, a.id));
    expect(after?.consentGrantedAt).not.toBeNull();
    expect(after?.consentGrantedAt!.getTime()).toBeGreaterThan(Date.now() - 5000);
  });
});
