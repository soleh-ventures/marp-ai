import {
  type StravaConnection,
  decryptTokens,
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
  const expiresAtUnix = Math.floor(conn.tokenExpiresAt.getTime() / 1000);
  const { accessToken, refreshToken } = decryptTokens(conn);

  if (expiresAtUnix - now > EARLY_REFRESH_WINDOW_S) {
    return accessToken;
  }

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
    // (user revoked, or it was rotated and we missed an update). Mark
    // the row revoked so subsequent calls short-circuit.
    const msg = (err as Error).message ?? "";
    if (msg.includes("400") || msg.includes("401")) {
      await markRevoked(conn.id);
      throw new StravaConnectionRevokedError(conn.id);
    }
    throw err;
  }
}
