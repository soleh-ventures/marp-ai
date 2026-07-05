// Google Calendar connection persistence — mirrors strava-connections.ts.
// Tokens are AES-256-GCM ciphertext via token-cipher.ts (the key env var is
// named STRAVA_TOKEN_ENCRYPTION_KEY for historical reasons; it's the generic
// at-rest key for provider tokens).

import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { googleConnections } from "../db/schema.js";
import { encryptToken, decryptToken } from "./token-cipher.js";

export type GoogleConnection = typeof googleConnections.$inferSelect;

export type GoogleTokenSet = {
  accessToken: string;
  refreshToken: string;
  // Unix seconds when the access token expires.
  expiresAt: number;
  scope: string;
};

export async function upsertGoogleConnection(
  athleteId: string,
  tokens: GoogleTokenSet,
): Promise<GoogleConnection> {
  const encAccess = encryptToken(tokens.accessToken);
  const encRefresh = encryptToken(tokens.refreshToken);
  const tokenExpiresAt = new Date(tokens.expiresAt * 1000);
  const now = new Date();

  const [row] = await db
    .insert(googleConnections)
    .values({
      athleteId,
      encryptedAccessToken: encAccess,
      encryptedRefreshToken: encRefresh,
      tokenExpiresAt,
      scope: tokens.scope,
      revokedAt: null,
    })
    .onConflictDoUpdate({
      target: googleConnections.athleteId,
      set: {
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
  if (!row) throw new Error("upsertGoogleConnection: no row returned");
  return row;
}

export async function findGoogleByAthleteId(
  athleteId: string,
): Promise<GoogleConnection | null> {
  const rows = await db
    .select()
    .from(googleConnections)
    .where(eq(googleConnections.athleteId, athleteId))
    .limit(1);
  return rows[0] ?? null;
}

export async function markGoogleRevoked(connectionId: string): Promise<void> {
  await db
    .update(googleConnections)
    .set({ revokedAt: new Date() })
    .where(eq(googleConnections.id, connectionId));
}

export async function markGoogleSynced(connectionId: string): Promise<void> {
  await db
    .update(googleConnections)
    .set({ lastSyncedAt: new Date() })
    .where(eq(googleConnections.id, connectionId));
}

export function decryptGoogleTokens(conn: GoogleConnection): {
  accessToken: string;
  refreshToken: string;
} {
  return {
    accessToken: decryptToken(conn.encryptedAccessToken),
    refreshToken: decryptToken(conn.encryptedRefreshToken),
  };
}

export async function updateGoogleRefreshedTokens(
  connectionId: string,
  tokens: { accessToken: string; refreshToken: string; expiresAt: number },
): Promise<void> {
  await db
    .update(googleConnections)
    .set({
      encryptedAccessToken: encryptToken(tokens.accessToken),
      encryptedRefreshToken: encryptToken(tokens.refreshToken),
      tokenExpiresAt: new Date(tokens.expiresAt * 1000),
      lastRefreshedAt: new Date(),
    })
    .where(eq(googleConnections.id, connectionId));
}
