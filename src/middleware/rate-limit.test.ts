import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { _resetRateLimitState, rateLimit } from "./rate-limit.js";

beforeEach(() => {
  _resetRateLimitState();
});

afterEach(() => {
  _resetRateLimitState();
});

function makeApp(limit = 5, windowMs = 60_000): Hono {
  const app = new Hono();
  app.use("/limited/*", rateLimit({ limit, windowMs }));
  app.get("/limited/echo", (c) => c.text("ok"));
  app.get("/unlimited/echo", (c) => c.text("ok"));
  return app;
}

function makeReq(path: string, ip = "203.0.113.1"): Request {
  return new Request(`https://marp.test${path}`, {
    headers: { "x-forwarded-for": ip },
  });
}

describe("rateLimit middleware", () => {
  test("allows up to `limit` requests within the window", async () => {
    const app = makeApp(5);
    for (let i = 0; i < 5; i++) {
      const res = await app.fetch(makeReq("/limited/echo"));
      expect(res.status).toBe(200);
    }
  });

  test("blocks the (limit + 1)th request with 429 + Retry-After", async () => {
    const app = makeApp(5);
    for (let i = 0; i < 5; i++) {
      await app.fetch(makeReq("/limited/echo"));
    }
    const blocked = await app.fetch(makeReq("/limited/echo"));
    expect(blocked.status).toBe(429);
    const retryAfter = blocked.headers.get("retry-after");
    expect(retryAfter).not.toBeNull();
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });

  test("different IPs get separate quotas", async () => {
    const app = makeApp(5);
    for (let i = 0; i < 5; i++) {
      await app.fetch(makeReq("/limited/echo", "203.0.113.1"));
    }
    // 6th from same IP — blocked.
    const blocked = await app.fetch(makeReq("/limited/echo", "203.0.113.1"));
    expect(blocked.status).toBe(429);
    // First from a different IP — allowed.
    const fresh = await app.fetch(makeReq("/limited/echo", "203.0.113.2"));
    expect(fresh.status).toBe(200);
  });

  test("leaves unlimited paths alone", async () => {
    const app = makeApp(2);
    // Exhaust the quota for /limited/*.
    await app.fetch(makeReq("/limited/echo"));
    await app.fetch(makeReq("/limited/echo"));
    const limited = await app.fetch(makeReq("/limited/echo"));
    expect(limited.status).toBe(429);
    // /unlimited/* still 200 from the same IP.
    for (let i = 0; i < 10; i++) {
      const res = await app.fetch(makeReq("/unlimited/echo"));
      expect(res.status).toBe(200);
    }
  });

  test("uses leftmost X-Forwarded-For entry (Railway sends 'client, proxy, ...')", async () => {
    const app = makeApp(2);
    // Two requests with the same leftmost IP but different proxy chain
    // should still count against the same bucket.
    const req1 = new Request("https://marp.test/limited/echo", {
      headers: { "x-forwarded-for": "203.0.113.5, 10.0.0.1" },
    });
    const req2 = new Request("https://marp.test/limited/echo", {
      headers: { "x-forwarded-for": "203.0.113.5, 10.0.0.2" },
    });
    expect((await app.fetch(req1)).status).toBe(200);
    expect((await app.fetch(req2)).status).toBe(200);
    const req3 = new Request("https://marp.test/limited/echo", {
      headers: { "x-forwarded-for": "203.0.113.5, 10.0.0.3" },
    });
    expect((await app.fetch(req3)).status).toBe(429);
  });

  test("falls through to X-Real-IP when X-Forwarded-For is absent", async () => {
    const app = makeApp(1);
    const req1 = new Request("https://marp.test/limited/echo", {
      headers: { "x-real-ip": "198.51.100.7" },
    });
    expect((await app.fetch(req1)).status).toBe(200);
    const req2 = new Request("https://marp.test/limited/echo", {
      headers: { "x-real-ip": "198.51.100.7" },
    });
    expect((await app.fetch(req2)).status).toBe(429);
  });

  test("bucket resets after the window expires", async () => {
    // Use a tiny window so we can wait it out without slowing the suite.
    const app = makeApp(2, 30);
    expect((await app.fetch(makeReq("/limited/echo"))).status).toBe(200);
    expect((await app.fetch(makeReq("/limited/echo"))).status).toBe(200);
    expect((await app.fetch(makeReq("/limited/echo"))).status).toBe(429);
    await new Promise((r) => setTimeout(r, 60));
    // Window elapsed — fresh quota.
    expect((await app.fetch(makeReq("/limited/echo"))).status).toBe(200);
  });
});
