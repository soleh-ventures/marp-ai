#!/usr/bin/env python3
"""
Probe your Garmin Connect account for ONE day of recovery data.

Purpose: before we design the ingester schema, confirm exactly which fields the
Forerunner 245 actually returns. Different watches expose different metrics, so
we read reality instead of guessing. This writes NOTHING to any database — it
just fetches a day and dumps it to out/ plus a presence summary.

Usage:
    cd garmin-sidecar
    python3 -m venv .venv && source .venv/bin/activate
    pip install -r requirements.txt
    cp .env.example .env         # fill GARMIN_EMAIL / GARMIN_PASSWORD
    python probe.py              # probes yesterday
    python probe.py 2026-07-03   # probe a specific date

First run opens an interactive MFA prompt if your account has 2FA. After that,
the token in tokens/ is reused and you won't need the password again.
"""

import datetime as dt
import json
import sys
from pathlib import Path

from garmin_client import connect  # shared auth + display-name fix (DRY)
from garminconnect import Garmin

OUT_DIR = Path("out")


# (label, callable). Each is tried independently so one 404 on the FR245
# doesn't abort the rest.
def endpoints(g: Garmin, date: str):
    return [
        ("user_summary", lambda: g.get_user_summary(date)),
        ("resting_hr", lambda: g.get_rhr_day(date)),
        ("body_battery", lambda: g.get_body_battery(date, date)),
        ("stress", lambda: g.get_stress_data(date)),
        ("sleep", lambda: g.get_sleep_data(date)),
        ("respiration", lambda: g.get_respiration_data(date)),
        ("hrv", lambda: g.get_hrv_data(date)),          # expected empty on FR245
        ("max_metrics", lambda: g.get_max_metrics(date)),  # VO2max, fitness age
    ]


def summarize(label: str, value) -> str:
    """One-line verdict on whether a metric is usable for this watch."""
    if value is None:
        return f"  {label:14s} -> None (not supported on this device)"
    if isinstance(value, (list, dict)) and len(value) == 0:
        return f"  {label:14s} -> EMPTY (device does not record this)"
    if isinstance(value, dict):
        keys = ", ".join(list(value.keys())[:8])
        return f"  {label:14s} -> dict[{len(value)}]: {keys}..."
    if isinstance(value, list):
        return f"  {label:14s} -> list[{len(value)}]"
    return f"  {label:14s} -> {value}"


def main() -> None:
    date = sys.argv[1] if len(sys.argv) > 1 else (
        dt.date.today() - dt.timedelta(days=1)
    ).isoformat()

    g = connect()
    print(f"\n[probe] fetching {date}\n")

    results = {}
    for label, fn in endpoints(g, date):
        try:
            value = fn()
        except Exception as e:  # noqa: BLE001 - we want to see every failure, not stop
            value = None
            print(f"  {label:14s} -> ERROR: {type(e).__name__}: {e}")
            results[label] = {"__error__": f"{type(e).__name__}: {e}"}
            continue
        print(summarize(label, value))
        results[label] = value

    OUT_DIR.mkdir(exist_ok=True)
    out_file = OUT_DIR / f"probe-{date}.json"
    out_file.write_text(json.dumps(results, indent=2, default=str))
    print(f"\n[probe] full payload written to {out_file}")
    print("[probe] paste the summary above (or the JSON) back so we can lock the schema.")


if __name__ == "__main__":
    main()
