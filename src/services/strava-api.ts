import { config } from "../config.js";

// Strava OAuth + API client. Covers only what S3 needs:
//   - Building the authorization redirect URL
//   - Exchanging an authorization code for tokens
//   - Refreshing an expired access token
// Activity fetching lives in a separate module (not yet built).

const TOKEN_URL = "https://www.strava.com/oauth/token";
const AUTH_URL = "https://www.strava.com/oauth/authorize";

// Scopes requested during OAuth. activity:read_all lets us read private
// activities; profile:read_all gives us athlete profile data.
const SCOPE = "activity:read_all,profile:read_all";

export type StravaTokenSet = {
  accessToken: string;
  refreshToken: string;
  // Unix seconds. Same format Strava returns in expires_at.
  expiresAt: number;
  scope: string;
  stravaAthleteId: number;
};

type StravaTokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  token_type: string;
  athlete?: { id: number };
};

type StravaRefreshResponse = {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  token_type: string;
};

export function buildAuthorizationUrl(redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: config.strava.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    approval_prompt: "auto",
    scope: SCOPE,
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

async function postJson<T>(body: Record<string, string>): Promise<T> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "(no body)");
    throw new Error(`Strava token endpoint ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export async function exchangeCode(
  code: string,
  redirectUri: string,
): Promise<StravaTokenSet> {
  const data = await postJson<StravaTokenResponse>({
    client_id: config.strava.clientId,
    client_secret: config.strava.clientSecret,
    code,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });

  const stravaAthleteId = data.athlete?.id;
  if (!stravaAthleteId) {
    throw new Error("Strava token response missing athlete.id");
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_at,
    scope: SCOPE,
    stravaAthleteId,
  };
}

export async function refreshAccessToken(
  refreshToken: string,
): Promise<Omit<StravaTokenSet, "stravaAthleteId" | "scope">> {
  const data = await postJson<StravaRefreshResponse>({
    client_id: config.strava.clientId,
    client_secret: config.strava.clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_at,
  };
}
