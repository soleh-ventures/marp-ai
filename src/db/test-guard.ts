// Refuse to run destructive test setup (TRUNCATE) against the production
// database. We hit this in real life: an integration test pointed at
// Railway's public proxy URL nuked the user's athlete, messages, and
// Strava connection mid-debug. Import + call this from every test file
// before doing TRUNCATE / DELETE in beforeEach.
//
// Heuristic: the production Postgres on Railway is reachable from
// outside via a *.proxy.rlwy.net host. Local dev DBs are `localhost` or
// `127.0.0.1`. If the host matches the Railway proxy pattern, bail.
//
// Override path (intentionally awkward): set ALLOW_DESTRUCTIVE_DB=1 in
// the environment if you genuinely need to run integration tests
// against prod (you don't). Awkward by design — this is the kind of
// flag you should have to type each time.
export function assertNotProductionDb(): void {
  const url = process.env.DATABASE_URL ?? "";
  if (!url) return; // tests without a DB don't trip this guard

  const looksLikeRailwayProxy = /\.proxy\.rlwy\.net/i.test(url);
  if (looksLikeRailwayProxy && process.env.ALLOW_DESTRUCTIVE_DB !== "1") {
    throw new Error(
      "Refusing to run destructive test setup against what looks like a " +
        "Railway proxy URL (matched *.proxy.rlwy.net). Point DATABASE_URL " +
        "at a local Postgres for tests, or set ALLOW_DESTRUCTIVE_DB=1 to " +
        "override.",
    );
  }
}
