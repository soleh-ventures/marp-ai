import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { athletes, googleConnections } from "../db/schema.js";
import { assertNotProductionDb } from "../db/test-guard.js";
import {
  GoogleRevokedError,
  localEnd,
  specToGoogleEvent,
  syncPlanToGoogle,
  disconnectGoogle,
} from "./google-calendar.js";
import { upsertGoogleConnection, findGoogleByAthleteId } from "./google-connections.js";

assertNotProductionDb();

// ── Pure helpers ──────────────────────────────────────────────────────

describe("localEnd", () => {
  it("adds duration within the same day", () => {
    expect(localEnd("2026-07-06", "07:00", 60)).toEqual({
      date: "2026-07-06",
      time: "08:00",
    });
  });
  it("rolls over midnight", () => {
    expect(localEnd("2026-07-06", "23:30", 60)).toEqual({
      date: "2026-07-07",
      time: "00:30",
    });
  });
});

describe("specToGoogleEvent", () => {
  it("carries the marp extended properties and zoned times", () => {
    const ev = specToGoogleEvent(
      {
        uid: "2026-07-06-tempo@marp-plan",
        date: "2026-07-06",
        timeLocal: "18:00",
        durationMin: 45,
        title: "Run — Tempo 8km (W1)",
        description: "Why: tempo discipline.",
      },
      "Europe/Berlin",
    ) as {
      start: { dateTime: string; timeZone: string };
      end: { dateTime: string };
      extendedProperties: { private: Record<string, string> };
    };
    expect(ev.start).toEqual({
      dateTime: "2026-07-06T18:00:00",
      timeZone: "Europe/Berlin",
    });
    expect(ev.end.dateTime).toBe("2026-07-06T18:45:00");
    expect(ev.extendedProperties.private).toEqual({
      marp: "1",
      marp_session_uid: "2026-07-06-tempo@marp-plan",
    });
  });
});

// ── Sync engine (DB + mocked Google API) ──────────────────────────────

const PLAN = {
  version: 1,
  start_date: "2026-07-06", // a Monday
  weeks: [
    {
      index: 1,
      sessions: [
        { day_of_week: "monday", type: "easy", distance_km: 8, duration_min: 50, description: "Easy 8k" },
        { day_of_week: "wednesday", type: "tempo", distance_km: 10, duration_min: 60, description: "Tempo 10k" },
        { day_of_week: "sunday", type: "rest" },
      ],
    },
  ],
};

const UID_EASY = "2026-07-06-easy@marp-plan";
const UID_TEMPO = "2026-07-08-tempo@marp-plan";

type FetchCall = { url: string; method: string; body?: unknown };

let calls: FetchCall[] = [];
const realFetch = globalThis.fetch;

function mockGoogle(opts: {
  existing: Array<{ id: string; uid: string }>;
  patchStatus?: number;
  refresh?: "ok" | "invalid_grant";
}): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    // Google JSON bodies parse; the token endpoint's form-encoded body stays
    // a raw string.
    const body = init?.body ? safeParse(String(init.body)) : undefined;
    calls.push({ url, method, body });

    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      if (opts.refresh === "invalid_grant") {
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      }
      return new Response(
        JSON.stringify({ access_token: "fresh-token", expires_in: 3600 }),
        { status: 200 },
      );
    }
    if (url.includes("/events?") && method === "GET") {
      return new Response(
        JSON.stringify({
          items: opts.existing.map((e) => ({
            id: e.id,
            extendedProperties: { private: { marp: "1", marp_session_uid: e.uid } },
          })),
        }),
        { status: 200 },
      );
    }
    if (method === "PATCH") {
      return new Response(JSON.stringify({}), { status: opts.patchStatus ?? 200 });
    }
    if (method === "POST" && url.includes("/events")) {
      return new Response(JSON.stringify({ id: "new-ev" }), { status: 200 });
    }
    if (method === "DELETE") return new Response(null, { status: 204 });
    if (url.includes("oauth2.googleapis.com/revoke")) {
      return new Response("{}", { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
}

// The form-encoded token body is a string, not JSON — tolerate both.
function safeParse(bodyStr: string): unknown {
  try {
    return JSON.parse(bodyStr);
  } catch {
    return bodyStr;
  }
}

let athleteId: string;

beforeEach(async () => {
  calls = [];
  await db.delete(googleConnections);
  await db.delete(athletes);
  const [a] = await db
    .insert(athletes)
    .values({
      phone: "whatsapp:+4915200000001",
      timezone: "Europe/Berlin",
      athleticHistory: { plan: PLAN, preferred_time: "evening" },
      consentGrantedAt: new Date(),
    })
    .returning({ id: athletes.id });
  athleteId = a!.id;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

afterAll(async () => {
  await db.delete(googleConnections);
  await db.delete(athletes);
});

async function connect(expiresInS = 3600): Promise<void> {
  await upsertGoogleConnection(athleteId, {
    accessToken: "access-1",
    refreshToken: "refresh-1",
    expiresAt: Math.floor(Date.now() / 1000) + expiresInS,
    scope: "https://www.googleapis.com/auth/calendar.events",
  });
}

describe("syncPlanToGoogle", () => {
  it("inserts new, patches existing, deletes stale — keyed by uid", async () => {
    await connect();
    mockGoogle({
      existing: [
        { id: "ev-easy", uid: UID_EASY },
        { id: "ev-stale", uid: "2026-01-01-old@marp-plan" },
      ],
    });
    const res = await syncPlanToGoogle(athleteId);
    expect(res).toEqual({ inserted: 1, updated: 1, deleted: 1 });

    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.url).toContain("/events/ev-easy");
    const post = calls.find((c) => c.method === "POST" && c.url.includes("/events"));
    expect((post?.body as { extendedProperties: { private: { marp_session_uid: string } } })
      .extendedProperties.private.marp_session_uid).toBe(UID_TEMPO);
    const del = calls.find((c) => c.method === "DELETE");
    expect(del?.url).toContain("/events/ev-stale");
    // Rest day never becomes an event.
    const uids = calls
      .filter((c) => c.method === "POST" || c.method === "PATCH")
      .map((c) => (c.body as { extendedProperties?: { private?: { marp_session_uid?: string } } })
        ?.extendedProperties?.private?.marp_session_uid);
    expect(uids).not.toContain("2026-07-12-rest@marp-plan");
  });

  it("re-inserts when a patched event was hand-deleted (404)", async () => {
    await connect();
    mockGoogle({ existing: [{ id: "ev-easy", uid: UID_EASY }], patchStatus: 404 });
    const res = await syncPlanToGoogle(athleteId);
    // easy re-inserted after 404, tempo inserted fresh
    expect(res?.inserted).toBe(2);
    expect(res?.updated).toBe(0);
  });

  it("refreshes an expired token before syncing", async () => {
    await connect(-60); // already expired
    mockGoogle({ existing: [], refresh: "ok" });
    const res = await syncPlanToGoogle(athleteId);
    expect(res?.inserted).toBe(2);
    expect(calls[0]!.url).toContain("oauth2.googleapis.com/token");
    expect(String(safeParse(String(calls[0]!.body ?? "")))).toContain("refresh_token");
  });

  it("marks the connection revoked on invalid_grant", async () => {
    await connect(-60);
    mockGoogle({ existing: [], refresh: "invalid_grant" });
    await expect(syncPlanToGoogle(athleteId)).rejects.toBeInstanceOf(GoogleRevokedError);
    const conn = await findGoogleByAthleteId(athleteId);
    expect(conn?.revokedAt).not.toBeNull();
  });

  it("no-ops without a connection or without a plan", async () => {
    mockGoogle({ existing: [] });
    expect(await syncPlanToGoogle(athleteId)).toBeNull();

    await connect();
    await db
      .update(athletes)
      .set({ athleticHistory: {} })
      .where(eq(athletes.id, athleteId));
    expect(await syncPlanToGoogle(athleteId)).toBeNull();
  });
});

describe("disconnectGoogle", () => {
  it("deletes MARP events when asked, revokes, marks revoked", async () => {
    await connect();
    mockGoogle({ existing: [{ id: "ev-1", uid: UID_EASY }, { id: "ev-2", uid: UID_TEMPO }] });
    const res = await disconnectGoogle(athleteId, { deleteEvents: true });
    expect(res.deleted).toBe(2);
    const conn = await findGoogleByAthleteId(athleteId);
    expect(conn?.revokedAt).not.toBeNull();
    expect(calls.some((c) => c.url.includes("/revoke"))).toBe(true);
  });

  it("keeps events when asked", async () => {
    await connect();
    mockGoogle({ existing: [{ id: "ev-1", uid: UID_EASY }] });
    const res = await disconnectGoogle(athleteId, { deleteEvents: false });
    expect(res.deleted).toBe(0);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });
});
