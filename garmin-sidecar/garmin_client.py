"""
Garmin Connect client for the sidecar: login (token cache + one-time MFA),
the display-name fix, a shared retry/backoff wrapper for Garmin's 429s, and
per-day normalization into the garmin_wellness column shape.

Personal use only — own account, own data.
"""

import os
import random
import time
from pathlib import Path

from dotenv import load_dotenv
from garminconnect import Garmin

load_dotenv()

TOKEN_STORE = os.getenv("GARMIN_TOKEN_STORE", "./tokens")


def _retry(fn, *, what: str, attempts: int = 5, base: float = 1.5):
    """Call fn() with exponential backoff + jitter. Garmin rate-limits (429)
    aggressively, especially on login and multi-day backfill. Returns fn() or
    re-raises the last error after `attempts`."""
    last = None
    for i in range(attempts):
        try:
            return fn()
        except Exception as e:  # noqa: BLE001 — Garmin raises many shapes; backoff on all
            last = e
            msg = str(e).lower()
            transient = "429" in msg or "rate" in msg or "timeout" in msg or "reset" in msg
            if not transient or i == attempts - 1:
                raise
            sleep = base ** i + random.uniform(0, 1.0)
            print(f"[retry] {what}: {type(e).__name__} (attempt {i+1}/{attempts}); sleeping {sleep:.1f}s")
            time.sleep(sleep)
    raise last  # unreachable


def connect() -> Garmin:
    """Resume from cached token, else fresh login (+ MFA once). Then populate
    display_name from the social profile — Garmin uses a GUID display name that
    the library often fails to load at login (429), which blocks the resting-HR
    and user-summary endpoints. Setting it explicitly unblocks them."""
    token_dir = Path(TOKEN_STORE)
    g = None
    if token_dir.exists() and any(token_dir.iterdir()):
        try:
            g = Garmin()
            g.login(str(token_dir))
        except Exception as e:  # token bad -> fresh login
            print(f"[auth] cached token unusable ({e}); fresh login")
            g = None
    if g is None:
        email = os.getenv("GARMIN_EMAIL")
        password = os.getenv("GARMIN_PASSWORD")
        if not email or not password:
            raise SystemExit("[auth] no cached token and GARMIN_EMAIL/GARMIN_PASSWORD unset")
        token_dir.mkdir(parents=True, exist_ok=True)
        g = Garmin(email=email, password=password, return_on_mfa=True)
        r1, r2 = _retry(lambda: g.login(str(token_dir)), what="login")
        if r1 == "needs_mfa":
            code = input("[auth] enter Garmin MFA code: ").strip()
            g.resume_login(r2, code)
            g.client.dump(str(token_dir))

    # Display-name fix: fetch the social profile (with backoff) and set the GUID
    # so display-name-dependent endpoints (resting HR, user summary) work.
    if not getattr(g, "display_name", None):
        sp = _retry(lambda: g.connectapi("/userprofile-service/socialProfile"),
                    what="socialProfile")
        if isinstance(sp, dict) and sp.get("displayName"):
            g.display_name = sp["displayName"]
    return g


def _num(v):
    return v if isinstance(v, (int, float)) else None


def fetch_day(g: Garmin, date: str) -> dict:
    """Fetch one Garmin calendar day, normalized into garmin_wellness columns
    (minus readiness_*). Each endpoint is independent and wrapped in retry;
    a missing endpoint leaves its columns null rather than failing the day."""
    row: dict = {"date": date, "source": "garmin"}

    def safe(label, fn):
        try:
            return _retry(fn, what=f"{label} {date}", attempts=4)
        except Exception as e:  # noqa: BLE001 — one endpoint failing must not kill the day
            print(f"[fetch] {label} {date} failed: {type(e).__name__}: {str(e)[:80]}")
            return None

    summary = safe("user_summary", lambda: g.get_user_summary(date))
    if isinstance(summary, dict):
        row["resting_hr"] = _num(summary.get("restingHeartRate"))

    stress = safe("stress", lambda: g.get_stress_data(date))
    if isinstance(stress, dict):
        row["stress_avg"] = _num(stress.get("avgStressLevel"))
        row["stress_max"] = _num(stress.get("maxStressLevel"))

    bb = safe("body_battery", lambda: g.get_body_battery(date, date))
    if isinstance(bb, list) and bb:
        el = bb[0]
        row["body_battery_charged"] = _num(el.get("charged"))
        row["body_battery_drained"] = _num(el.get("drained"))
        vals = [v[1] for v in (el.get("bodyBatteryValuesArray") or []) if isinstance(v, list) and len(v) > 1 and v[1] is not None]
        if vals:
            row["body_battery_high"] = max(vals)
            row["body_battery_low"] = min(vals)
            # "Morning" body battery = the overnight-recharge PEAK (the value you
            # wake up with), which is the day's high — NOT the first reading of
            # the day (that's the ~midnight low, before sleep recharges you).
            row["body_battery_morning"] = max(vals)

    sleep = safe("sleep", lambda: g.get_sleep_data(date))
    if isinstance(sleep, dict):
        dto = sleep.get("dailySleepDTO") or {}
        row["sleep_total_s"] = _num(dto.get("sleepTimeSeconds"))
        row["sleep_deep_s"] = _num(dto.get("deepSleepSeconds"))
        row["sleep_light_s"] = _num(dto.get("lightSleepSeconds"))
        row["sleep_rem_s"] = _num(dto.get("remSleepSeconds"))
        row["sleep_awake_s"] = _num(dto.get("awakeSleepSeconds"))

    resp = safe("respiration", lambda: g.get_respiration_data(date))
    if isinstance(resp, dict):
        row["resp_sleep_avg"] = _num(resp.get("avgSleepRespirationValue"))
        row["resp_waking_avg"] = _num(resp.get("avgWakingRespirationValue"))
        row["resp_low"] = _num(resp.get("lowestRespirationValue"))
        row["resp_high"] = _num(resp.get("highestRespirationValue"))

    mm = safe("max_metrics", lambda: g.get_max_metrics(date))
    if isinstance(mm, list) and mm:
        gen = (mm[0] or {}).get("generic") or {}
        row["vo2max"] = _num(gen.get("vo2MaxValue"))

    row["hrv_overnight"] = None  # FR245 does not record HRV Status

    # Compact raw: the normalized values only (no multi-thousand-sample epoch
    # arrays), enough to reprocess readiness without re-hitting Garmin.
    row["raw"] = {k: v for k, v in row.items() if k not in ("raw",)}
    return row


# The column set the sidecar writes. The schema-drift test asserts this equals
# the DB's information_schema (minus DB-managed columns).
WELLNESS_COLUMNS = [
    "date", "resting_hr", "vo2max", "hrv_overnight",
    "body_battery_high", "body_battery_low", "body_battery_charged",
    "body_battery_drained", "body_battery_morning",
    "stress_avg", "stress_max",
    "sleep_total_s", "sleep_deep_s", "sleep_light_s", "sleep_rem_s", "sleep_awake_s",
    "resp_sleep_avg", "resp_waking_avg", "resp_low", "resp_high",
    "readiness_score", "readiness_band", "readiness_components",
    "raw", "source",
]
