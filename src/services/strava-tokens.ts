import {
  type StravaConnection,
  decryptTokens,
  findByConnectionId,
  markRevoked,
  updateRefreshedTokens,
} from "./strava-connections.js";
import { refreshAccessToken } from "./strava-api.js";

// Refresh tokens proactively when they expire within this window. Strava
// access tokens last 6 hours; refreshing a bit early avoids races where
// we read the token at the start of a request and it expires mid-request.
const EARLY_REFRESH_WINDOW_S = 5 * 60;

export class StravaConnectionRevokedError extends Error {
  constructor(public readonly connectionId: string) {
    super(`Strava connection ${connectionId} is revoked`);
    this.name = "StravaConnectionRevokedError";
  }
}

// Per-connection in-flight refresh, keyed by connection id. Strava rotates
// the refresh_token on every refresh and invalidates the old one the moment
// a refresh succeeds. Without this, two concurrent operations on the same
// connection (e.g. Strava's `create` + `update` events for one upload, which
// the webhook ingests on both) each POST the same stored refresh token; the
// first rotates it and the second gets a 400, which used to mark the
// connection revoked and silently kill all future syncs. Coalescing here so
// only one refresh runs per connection at a time, and everyone else awaits it.
const inFlightRefresh = new Map<string, Promise<string>>();

// Given a connection row, return a usable access token. Refreshes the
// token via Strava's API if it's expired or about to expire. On a 401 from
// the refresh endpoint (refresh token rejected / user deauthorized) the
// connection is marked revoked and this throws — callers should catch and
// stop trying to use Strava for this athlete until they reconnect.
export async function getFreshAccessToken(
  conn: StravaConnection,
  opts: { nowSeconds?: number } = {},
): Promise<string> {
  if (conn.revokedAt) {
    throw new StravaConnectionRevokedError(conn.id);
  }

  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const { accessToken } = decryptTokens(conn);

  if (!needsRefresh(conn, now)) {
    return accessToken;
  }

  // Coalesce concurrent refreshes for the same connection. The get/set pair
  // runs synchronously before any await, so a second caller entering while
  // the first is in flight always observes the in-flight promise.
  const existing = inFlightRefresh.get(conn.id);
  if (existing) return existing;

  const p = doRefresh(conn, now).finally(() => {
    inFlightRefresh.delete(conn.id);
  });
  inFlightRefresh.set(conn.id, p);
  return p;
}

function needsRefresh(conn: StravaConnection, now: number): boolean {
  const expiresAtUnix = Math.floor(conn.tokenExpiresAt.getTime() / 1000);
  return expiresAtUnix - now <= EARLY_REFRESH_WINDOW_S;
}

async function doRefresh(
  conn: StravaConnection,
  now: number,
): Promise<string> {
  // Re-read the row before refreshing. Another instance (the in-process lock
  // above doesn't span processes) may have already rotated the token while we
  // waited, in which case our snapshot's refresh token is dead. Prefer the
  // stored one.
  const fresh = (await findByConnectionId(conn.id)) ?? conn;
  if (fresh.revokedAt) {
    throw new StravaConnectionRevokedError(conn.id);
  }
  if (!needsRefresh(fresh, now)) {
    // Someone else refreshed while we were queued — reuse their token.
    return decryptTokens(fresh).accessToken;
  }

  const { refreshToken } = decryptTokens(fresh);
  try {
    const refreshed = await refreshAccessToken(refreshToken);
    await updateRefreshedTokens(conn.id, {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: refreshed.expiresAt,
    });
    return refreshed.accessToken;
  } catch (err) {
    // Strava returns 400/401 when the refresh token is no longer valid
    // (user revoked, or it was rotated and we sent the stale one).
    const msg = (err as Error).message ?? "";
    if (msg.includes("400") || msg.includes("401")) {
      // Before revoking, re-read once more: under multi-instance concurrency
      // another instance may have rotated the token out from under us,
      // invalidating the one we just sent. If the stored token is now valid
      // and the row isn't revoked, that's a lost race, not a dead
      // connection — recover with the stored token instead of revoking.
      const after = await findByConnectionId(conn.id);
      if (after && !after.revokedAt && !needsRefresh(after, now)) {
        return decryptTokens(after).accessToken;
      }
      await markRevoked(conn.id);
      throw new StravaConnectionRevokedError(conn.id);
    }
    throw err;
  }
}
