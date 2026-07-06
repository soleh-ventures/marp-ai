import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { assertNotProductionDb } from "../db/test-guard.js";
import { athletes, stravaConnections } from "../db/schema.js";
import { encryptToken } from "./token-cipher.js";
import { findByAthleteId, type StravaConnection } from "./strava-connections.js";
import {
  StravaConnectionRevokedError,
  getFreshAccessToken,
} from "./strava-tokens.js";

// Regression coverage for the Strava refresh-token rotation race.
//
// Strava rotates the refresh_token on every refresh and invalidates the old
// one the instant a refresh succeeds. Two concurrent operations on the same
// connection (e.g. Strava's `create` + `update` webhook events for one
// upload, both of which the webhook ingests) used to each POST the same
// stored refresh token; the first rotated it and the second got a 400, which
// marked the connection revoked and silently killed all future syncs.

const STRAVA_ATHLETE_ID = 445566;

let realFetch: typeof globalThis.fetch;

beforeEach(async () => {
  assertNotProductionDb();
  await db.execute(sql`
    TRUNCATE TABLE
      activities, race_blocks, strava_connections, athletes
    RESTART IDENTITY CASCADE
  `);
  realFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

async function seedNearExpiryConnection(): Promise<StravaConnection> {
  const [a] = await db
    .insert(athletes)
    .values({ phone: "+15557770001", name: "Racer" })
    .returning();
  if (!a) throw new Error("athlete insert failed");
  await db.insert(stravaConnections).values({
    athleteId: a.id,
    stravaAthleteId: STRAVA_ATHLETE_ID,
    encryptedAccessToken: encryptToken("access-old"),
    encryptedRefreshToken: encryptToken("refresh-old"),
    // Expires in 60s → inside the 5-min early-refresh window → forces a refresh.
    tokenExpiresAt: new Date(Date.now() + 60 * 1000),
    scope: "activity:read_all",
  });
  const conn = await findByAthleteId(a.id);
  if (!conn) throw new Error("connection seed failed");
  return conn;
}

// Fetch stub that mimics Strava's token endpoint WITH refresh-token rotation:
// a given refresh token works exactly once; a second POST with the same
// (now rotated-away) token returns 400, as the real API does.
function installRotatingStravaStub(): { calls: () => number } {
  const used = new Set<string>();
  let calls = 0;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (!String(url).includes("/oauth/token")) {
      throw new Error(`unexpected fetch in test: ${url}`);
    }
    calls += 1;
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      refresh_token?: string;
    };
    const token = body.refresh_token ?? "";
    if (used.has(token)) {
      return new Response("Bad Request", { status: 400 });
    }
    used.add(token);
    return new Response(
      JSON.stringify({
        access_token: "access-new",
        refresh_token: "refresh-new",
        expires_at: Math.floor(Date.now() / 1000) + 6 * 60 * 60,
        token_type: "Bearer",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof globalThis.fetch;
  return { calls: () => calls };
}

describe("getFreshAccessToken — concurrent refresh race", () => {
  test("two concurrent refreshes coalesce into one Strava call and never revoke", async () => {
    const conn = await seedNearExpiryConnection();
    const stub = installRotatingStravaStub();

    // Both callers hold the same near-expiry snapshot — exactly the shape of
    // the webhook create+update race.
    const [t1, t2] = await Promise.all([
      getFreshAccessToken(conn),
      getFreshAccessToken(conn),
    ]);

    // Coalesced: exactly one refresh POST, both callers get the rotated token.
    expect(stub.calls()).toBe(1);
    expect(t1).toBe("access-new");
    expect(t2).toBe("access-new");

    // The connection must remain live. Pre-fix, the losing caller's 400
    // revoked it here, stranding the athlete until re-OAuth.
    const after = await findByAthleteId(conn.athleteId);
    expect(after?.revokedAt).toBeNull();
  });

  test("single refresh persists the rotated tokens", async () => {
    const conn = await seedNearExpiryConnection();
    installRotatingStravaStub();

    const token = await getFreshAccessToken(conn);
    expect(token).toBe("access-new");

    const after = await findByAthleteId(conn.athleteId);
    expect(after?.revokedAt).toBeNull();
    expect(after?.lastRefreshedAt).not.toBeNull();
    // A subsequent read sees an unexpired token → no further network call.
    expect(after && after.tokenExpiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  test("a genuinely dead refresh token still revokes the connection", async () => {
    const conn = await seedNearExpiryConnection();
    // Strava rejects the token outright (user deauthorized / token expired).
    globalThis.fetch = (async () =>
      new Response("Unauthorized", { status: 401 })) as unknown as typeof globalThis.fetch;

    await expect(getFreshAccessToken(conn)).rejects.toBeInstanceOf(
      StravaConnectionRevokedError,
    );

    const after = await findByAthleteId(conn.athleteId);
    expect(after?.revokedAt).not.toBeNull();
  });
});
