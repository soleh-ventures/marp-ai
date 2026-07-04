"""
Print a serialized Garmin token string for headless/cron auth.

Run this LOCALLY once (it uses your cached token, or logs in + MFA if needed),
then set the printed value as GARMIN_TOKEN_STRING on the Railway cron service.
The cron then authenticates with no interactive MFA. garth refreshes the
short-lived access token from the long-lived one, so this lasts ~a year.

    cd garmin-sidecar && source .venv/bin/activate && python mint_token.py
"""

import garmin_client as gc

g = gc.connect()

# garth Client exposes dumps() -> base64 token string. Fall back to reading the
# token dir if this build lacks it.
token_str = None
if hasattr(g.client, "dumps"):
    token_str = g.client.dumps()
if not token_str:
    raise SystemExit("could not serialize token (garth client has no dumps())")

print("\n=== GARMIN_TOKEN_STRING (set as an env var on the cron; keep secret) ===\n")
print(token_str)
print("\n=== length:", len(token_str), "chars ===")
