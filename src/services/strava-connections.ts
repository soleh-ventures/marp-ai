import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { stravaConnections } from "../db/schema.js";
import { encryptToken, decryptToken } from "./token-cipher.js";
import type { StravaTokenSet } from "./strava-api.js";

export type StravaConnection = typeof stravaConnections.$inferSelect;

export async function upsertStravaConnection(
  athleteId: string,
  tokens: StravaTokenSet,
): Promise<StravaConnection> {
  // Encrypt once and reuse. Each encryptToken call uses a fresh IV so the
  // insert-vs-update branches would produce different ciphertexts of the
  // same plaintext if we encrypted twice. Functionally fine, but wasteful.
  const encAccess = encryptToken(tokens.accessToken);
  const encRefresh = encryptToken(tokens.refreshToken);
  const tokenExpiresAt = new Date(tokens.expiresAt * 1000);
  const now = new Date();

  const [row] = await db
    .insert(stravaConnections)
    .values({
      athleteId,
      stravaAthleteId: tokens.stravaAthleteId,
      encryptedAccessToken: encAccess,
      encryptedRefreshToken: encRefresh,
      tokenExpiresAt,
      scope: tokens.scope,
      revokedAt: null,
    })
    .onConflictDoUpdate({
      target: stravaConnections.athleteId,
      // Reconnect after revocation or scope change: treat as a fresh
      // connect, not a refresh — bump connectedAt, clear lastRefreshedAt.
      set: {
        stravaAthleteId: tokens.stravaAthleteId,
        encryptedAccessToken: encAccess,
        encryptedRefreshToken: encRefresh,
        tokenExpiresAt,
        scope: tokens.scope,
        connectedAt: now,
        lastRefreshedAt: null,
        revokedAt: null,
      },
    })
    .returning();
  if (!row) throw new Error("upsertStravaConnection: no row returned");
  return row;
}

export async function findByStravaAthleteId(
  stravaAthleteId: number,
): Promise<StravaConnection | null> {
  const rows = await db
    .select()
    .from(stravaConnections)
    .where(eq(stravaConnections.stravaAthleteId, stravaAthleteId))
    .limit(1);
  return rows[0] ?? null;
}

export async function findByAthleteId(
  athleteId: string,
): Promise<StravaConnection | null> {
  const rows = await db
    .select()
    .from(stravaConnections)
    .where(eq(stravaConnections.athleteId, athleteId))
    .limit(1);
  return rows[0] ?? null;
}

export async function markRevoked(connectionId: string): Promise<void> {
  await db
    .update(stravaConnections)
    .set({ revokedAt: new Date() })
    .where(eq(stravaConnections.id, connectionId));
}

// Decrypt and return plaintext tokens. Callers must not log or persist
// the returned values.
export function decryptTokens(conn: StravaConnection): {
  accessToken: string;
  refreshToken: string;
} {
  return {
    accessToken: decryptToken(conn.encryptedAccessToken),
    refreshToken: decryptToken(conn.encryptedRefreshToken),
  };
}

export async function updateRefreshedTokens(
  connectionId: string,
  tokens: { accessToken: string; refreshToken: string; expiresAt: number },
): Promise<void> {
  await db
    .update(stravaConnections)
    .set({
      encryptedAccessToken: encryptToken(tokens.accessToken),
      encryptedRefreshToken: encryptToken(tokens.refreshToken),
      tokenExpiresAt: new Date(tokens.expiresAt * 1000),
      lastRefreshedAt: new Date(),
      revokedAt: null,
    })
    .where(eq(stravaConnections.id, connectionId));
}
