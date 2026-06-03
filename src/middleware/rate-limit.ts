import type { Context, Next } from "hono";

// ET10 — fixed-window in-memory rate limiter.
//
// Pulled in to protect /auth/strava/*: the magic-link entry point is
// publicly reachable and accepts a token whose payload encodes the
// athlete UUID. Without a limiter, a bad actor can probe at machine
// speed for valid tokens. 5 req/min/IP is plenty for a real runner
// opening their link, and aggressive enough to make enumeration
// uninteresting.
//
// Implementation notes:
//   - One Map keyed by client IP. Each entry holds a count + expiry.
//   - On request: bump the count; if it crosses the limit, reply 429
//     with Retry-After. Otherwise pass through.
//   - "Fixed window" rather than sliding window — simpler, no extra
//     timestamps. Bursts at the window boundary are acceptable for v1.
//   - In-memory single-instance. Railway runs one replica today; if
//     we scale out, swap the Map for Redis (Upstash) and keep the API.
//   - No background sweeper. Stale entries get evicted lazily when
//     a new request lands for the same key past resetAt. At our scale
//     the map stays trivially small; if memory becomes a concern,
//     periodic cleanup is straightforward.
//
// Client IP detection: behind Railway, the runner's IP arrives in
// X-Forwarded-For (first entry). c.req.raw is the underlying
// Request, which has no socket access from Hono — header inspection
// is what we have.

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

export type RateLimitConfig = {
  windowMs: number;
  limit: number;
  // Override the default IP-based key for testing. Production callers
  // should let it default.
  keyFn?: (c: Context) => string;
};

export function rateLimit({
  windowMs,
  limit,
  keyFn = defaultKey,
}: RateLimitConfig) {
  return async (c: Context, next: Next) => {
    const key = keyFn(c);
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > limit) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      c.header("Retry-After", String(retryAfter));
      return c.text("Too many requests", 429);
    }
    await next();
  };
}

function defaultKey(c: Context): string {
  // X-Forwarded-For = "client, proxy1, proxy2, …" — the leftmost entry
  // is the original client. Railway sets this; for direct hits it's
  // absent and we fall through to X-Real-IP, then a stable sentinel.
  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const xri = c.req.header("x-real-ip");
  if (xri) return xri;
  return "unknown";
}

// Test-only — drop the in-memory buckets between tests so they don't
// bleed quota across cases.
export function _resetRateLimitState(): void {
  buckets.clear();
}
