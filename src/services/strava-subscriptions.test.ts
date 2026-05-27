import { beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  buildCallbackUrl,
  clearSubscriptionRecords,
  getActiveSubscriptionRecord,
  reconcileStravaSubscription,
  saveSubscriptionRecord,
  type StravaSubscription,
  type StravaSubscriptionClient,
} from "./strava-subscriptions.js";

// Stub HTTP client. Records calls + returns canned responses; lets us
// exercise reconcile() without touching Strava's real API.
function stubClient(initial: StravaSubscription[] = []): {
  client: StravaSubscriptionClient;
  state: StravaSubscription[];
  calls: { list: number; create: Array<[string, string]>; remove: number[] };
} {
  const state = [...initial];
  const calls = { list: 0, create: [] as Array<[string, string]>, remove: [] as number[] };
  let nextId = 9000;
  const client: StravaSubscriptionClient = {
    async list() {
      calls.list += 1;
      return [...state];
    },
    async create(callbackUrl, verifyToken) {
      calls.create.push([callbackUrl, verifyToken]);
      const id = nextId++;
      state.push({
        id,
        application_id: 1,
        callback_url: callbackUrl,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      return { id };
    },
    async remove(id) {
      calls.remove.push(id);
      const idx = state.findIndex((s) => s.id === id);
      if (idx >= 0) state.splice(idx, 1);
    },
  };
  return { client, state, calls };
}

beforeEach(async () => {
  await db.execute(sql`TRUNCATE TABLE strava_webhook_config RESTART IDENTITY`);
});

describe("buildCallbackUrl", () => {
  test("strips trailing slash and appends /webhooks/strava", () => {
    expect(buildCallbackUrl("https://example.com")).toBe(
      "https://example.com/webhooks/strava",
    );
    expect(buildCallbackUrl("https://example.com/")).toBe(
      "https://example.com/webhooks/strava",
    );
  });
});

describe("saveSubscriptionRecord (singleton enforcement)", () => {
  test("delete-then-insert keeps the table at exactly one row", async () => {
    await saveSubscriptionRecord(101, "https://a.example.com/webhooks/strava");
    await saveSubscriptionRecord(202, "https://b.example.com/webhooks/strava");
    const rec = await getActiveSubscriptionRecord();
    expect(rec?.subscriptionId).toBe(202);
    expect(rec?.callbackUrl).toBe("https://b.example.com/webhooks/strava");
  });
});

describe("reconcileStravaSubscription", () => {
  const verifyToken = "test-verify-token";

  test("creates when nothing exists upstream", async () => {
    const { client, calls } = stubClient([]);
    const result = await reconcileStravaSubscription(client, {
      callbackBase: "https://example.com",
      verifyToken,
    });
    expect(result.action).toBe("created");
    expect(result.callbackUrl).toBe("https://example.com/webhooks/strava");
    expect(result.removedIds).toEqual([]);
    expect(calls.create).toHaveLength(1);
    expect(calls.remove).toEqual([]);

    const rec = await getActiveSubscriptionRecord();
    expect(rec?.subscriptionId).toBe(result.subscriptionId);
  });

  test("no-op when the existing subscription already matches", async () => {
    const { client, calls } = stubClient([
      {
        id: 555,
        application_id: 1,
        callback_url: "https://example.com/webhooks/strava",
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
      },
    ]);
    const result = await reconcileStravaSubscription(client, {
      callbackBase: "https://example.com",
      verifyToken,
    });
    expect(result.action).toBe("noop");
    expect(result.subscriptionId).toBe(555);
    expect(calls.create).toEqual([]);
    expect(calls.remove).toEqual([]);

    const rec = await getActiveSubscriptionRecord();
    expect(rec?.subscriptionId).toBe(555);
  });

  test("replaces a stale subscription when callback URL drifted", async () => {
    const { client, calls } = stubClient([
      {
        id: 111,
        application_id: 1,
        callback_url: "https://old.example.com/webhooks/strava",
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
      },
    ]);
    const result = await reconcileStravaSubscription(client, {
      callbackBase: "https://new.example.com",
      verifyToken,
    });
    expect(result.action).toBe("replaced");
    expect(result.callbackUrl).toBe("https://new.example.com/webhooks/strava");
    expect(result.removedIds).toEqual([111]);
    expect(calls.create).toHaveLength(1);
    expect(calls.create[0]?.[0]).toBe("https://new.example.com/webhooks/strava");

    const rec = await getActiveSubscriptionRecord();
    expect(rec?.subscriptionId).toBe(result.subscriptionId);
    expect(rec?.callbackUrl).toBe("https://new.example.com/webhooks/strava");
  });

  test("removes extras even when one matches (defensive against Strava drift)", async () => {
    const { client, calls } = stubClient([
      {
        id: 1,
        application_id: 1,
        callback_url: "https://example.com/webhooks/strava",
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
      },
      {
        id: 2,
        application_id: 1,
        callback_url: "https://stale.example.com/webhooks/strava",
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
      },
    ]);
    const result = await reconcileStravaSubscription(client, {
      callbackBase: "https://example.com",
      verifyToken,
    });
    expect(result.action).toBe("replaced");
    // Both old IDs torn down, then a brand-new subscription created.
    expect(result.removedIds.sort()).toEqual([1, 2]);
    expect(calls.create).toHaveLength(1);
    expect(calls.remove.sort()).toEqual([1, 2]);
  });

  test("clearSubscriptionRecords empties the table", async () => {
    await saveSubscriptionRecord(999, "https://x.example.com/webhooks/strava");
    await clearSubscriptionRecords();
    const rec = await getActiveSubscriptionRecord();
    expect(rec).toBeNull();
  });
});
