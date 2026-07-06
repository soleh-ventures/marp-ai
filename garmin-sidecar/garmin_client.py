"""
Garmin Connect client for the sidecar: login (token cache + one-time MFA),
the display-name fix, a shared retry/backoff wrapper for Garmin's 429s, and
per-day normalization into the garmin_wellness column shape.

Personal use only — own account, own data.
"""

# Make all annotations lazy strings (PEP 563) so `str | None` and friends
# never get evaluated at runtime — the Railway/nixpacks container runs a
# Python < 3.10 where PEP 604 union syntax in an annotation would crash the
# whole module at import (which took the wellness ingest down with it).
from __future__ import annotations

import datetime as dt
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

    # Headless/cron auth: a serialized garth token string (mint it once locally
    # with `python mint_token.py`, then set GARMIN_TOKEN_STRING on the cron).
    # Strings >512 chars are loaded directly by login(); garth auto-refreshes
    # the short-lived access token from the long-lived one, so this survives
    # ~a year with no interactive MFA.
    token_str = os.getenv("GARMIN_TOKEN_STRING")
    if token_str and len(token_str) > 512:
        try:
            g = Garmin()
            g.login(token_str)
        except Exception as e:
            print(f"[auth] GARMIN_TOKEN_STRING unusable ({e}); trying other methods")
            g = None

    if g is None and token_dir.exists() and any(token_dir.iterdir()):
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


# ── Activities (runs/rides/etc) ──────────────────────────────────────────
# The recovery ingester's sibling: pull recent Garmin ACTIVITIES and normalize
# them into MARP's `activities` metrics shape (same as the Strava path), so the
# coach can analyze workouts and plan from them after Strava's API paywall.

# Garmin activityType.typeKey → MARP discipline vocabulary. Unknown → "other".
_GARMIN_DISCIPLINE = {
    "running": "run", "trail_running": "run", "treadmill_running": "run",
    "track_running": "run", "virtual_run": "run", "obstacle_run": "run",
    "cycling": "ride", "road_biking": "ride", "mountain_biking": "ride",
    "indoor_cycling": "ride", "virtual_ride": "ride", "gravel_cycling": "ride",
    "lap_swimming": "swim", "open_water_swimming": "swim",
    "walking": "walk", "casual_walking": "walk", "speed_walking": "walk",
    "hiking": "hike",
    "strength_training": "strength", "indoor_cardio": "cross",
    "yoga": "mobility", "pilates": "mobility", "elliptical": "cross",
}
_LONG_RUN_MIN_DISTANCE_M = 16_000


def _map_discipline(type_key: str | None) -> str:
    return _GARMIN_DISCIPLINE.get((type_key or "").lower(), "other")


def _gmt_to_iso(s: str | None) -> str | None:
    """Garmin's startTimeGMT ('2026-07-04 20:30:00', UTC) → ISO8601 UTC."""
    if not s:
        return None
    try:
        d = dt.datetime.strptime(s, "%Y-%m-%d %H:%M:%S")
        return d.replace(tzinfo=dt.timezone.utc).isoformat()
    except (ValueError, TypeError):
        return None


def fetch_activities(g: Garmin, limit: int = 30) -> list[dict]:
    """Most recent `limit` activities, normalized to MARP's shape. Skips any
    row missing an id or start time; one bad activity never kills the batch."""
    try:
        raw = _retry(lambda: g.get_activities(0, limit), what="get_activities")
    except Exception as e:  # noqa: BLE001
        print(f"[activities] fetch failed: {type(e).__name__}: {str(e)[:80]}")
        return []
    out: list[dict] = []
    for a in raw or []:
        aid = a.get("activityId")
        started = _gmt_to_iso(a.get("startTimeGMT"))
        if aid is None or started is None:
            continue
        type_key = (a.get("activityType") or {}).get("typeKey")
        discipline = _map_discipline(type_key)
        distance_m = _num(a.get("distance"))
        avg_speed = _num(a.get("averageSpeed"))  # m/s
        pace = round(1000 / avg_speed) if avg_speed and avg_speed > 0 else None
        elev = _num(a.get("elevationGain"))
        cal = _num(a.get("calories"))
        out.append({
            "source_id": str(aid),
            "discipline": discipline,
            "started_at": started,
            "duration_s": int(_num(a.get("duration")) or 0),
            "long_run": discipline == "run"
            and (distance_m or 0) >= _LONG_RUN_MIN_DISTANCE_M,
            "metrics": {
                "name": a.get("activityName"),
                "avg_hr": _num(a.get("averageHR")),
                "max_hr": _num(a.get("maxHR")),
                "calories": round(cal) if cal is not None else None,
                "distance_m": distance_m,
                "avg_cadence": _num(a.get("averageRunningCadenceInStepsPerMinute")),
                "description": None,
                "elev_gain_m": round(elev) if elev is not None else None,
                "avg_pace_s_per_km": pace,
            },
        })
    return out


# ── Per-activity streams (deep analysis) ─────────────────────────────────
# Fetch Garmin's per-second detail + laps + HR-zones for ONE activity, and
# normalize into the shape the TS /internal/streams/summarize endpoint expects
# (option B: the TS pure summarizer stays the single source of truth). Returns
# None when the activity has no usable detail (strength, sparse, error).

# Garmin metricDescriptor keys → our channel names.
_STREAM_METRIC = {
    "directTimestamp": "time",
    "sumDistance": "distance",
    "directHeartRate": "heartrate",
    "directSpeed": "velocity_smooth",
    "directElevation": "altitude",
    "directRunCadence": "cadence",
    "directBikeCadence": "cadence",
    "directDoubleCadence": "cadence",
}


def fetch_activity_streams(g: Garmin, activity_id: str) -> dict | None:
    """Return {streams:{key:{data:[...]}}, laps:[...], hr_zone_seconds:[...]}
    or None. Best-effort; any sub-fetch failing degrades that piece to empty."""
    def safe(label, fn):
        try:
            return _retry(fn, what=f"{label} {activity_id}", attempts=3)
        except Exception as e:  # noqa: BLE001
            print(f"[streams] {label} {activity_id} failed: {type(e).__name__}: {str(e)[:70]}")
            return None

    details = safe("details", lambda: g.get_activity_details(activity_id))
    if not isinstance(details, dict):
        return None
    descriptors = details.get("metricDescriptors") or []
    idx_by_key: dict[str, int] = {}
    for d in descriptors:
        key = d.get("key")
        i = d.get("metricsIndex")
        if key in _STREAM_METRIC and isinstance(i, int):
            idx_by_key[_STREAM_METRIC[key]] = i
    rows = details.get("activityDetailMetrics") or []
    if "time" not in idx_by_key or "distance" not in idx_by_key or not rows:
        return None

    channels: dict[str, list] = {k: [] for k in idx_by_key}
    t0 = None
    for r in rows:
        m = r.get("metrics") or []
        for ch, i in idx_by_key.items():
            v = m[i] if i < len(m) else None
            if ch == "time":
                # directTimestamp is epoch ms → seconds-from-start.
                if v is None:
                    channels[ch].append(None)
                    continue
                if t0 is None:
                    t0 = v
                channels[ch].append((v - t0) / 1000.0)
            elif ch == "velocity_smooth":
                channels[ch].append(v)  # m/s (unused by summarizer but harmless)
            else:
                channels[ch].append(v)
    streams = {k: {"data": [x for x in v]} for k, v in channels.items()}

    # Laps (typed splits) → normalized.
    laps: list[dict] = []
    splits = safe("splits", lambda: g.get_activity_typed_splits(activity_id)) \
        or safe("splits2", lambda: g.get_activity_splits(activity_id))
    lap_list = []
    if isinstance(splits, dict):
        lap_list = splits.get("lapDTOs") or splits.get("splits") or []
    elif isinstance(splits, list):
        lap_list = splits
    for i, lp in enumerate(lap_list or []):
        dist = _num(lp.get("distance"))
        dur = _num(lp.get("duration") or lp.get("elapsedDuration"))
        hr = _num(lp.get("averageHR"))
        pace = round(dur / (dist / 1000)) if dist and dur and dist > 0 else None
        laps.append({
            "index": i + 1,
            "distance_m": round(dist) if dist else 0,
            "time_s": round(dur) if dur else 0,
            "avg_hr": round(hr) if hr else None,
            "avg_pace_s_per_km": pace,
        })

    # HR zones → seconds per zone.
    hr_zone_seconds: list[dict] = []
    zones = safe("hrzones", lambda: g.get_activity_hr_in_timezones(activity_id))
    if isinstance(zones, list):
        for z in zones:
            zn = z.get("zoneNumber")
            secs = _num(z.get("secsInZone"))
            if isinstance(zn, int) and secs is not None:
                hr_zone_seconds.append({"zone": zn, "seconds": round(secs)})

    return {"streams": streams, "laps": laps, "hr_zone_seconds": hr_zone_seconds}
