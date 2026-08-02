"""
Always-on scheduler for the Garmin ingest.

WHY THIS EXISTS: Railway's cron never fired this service. A run-once cron
container shows as FAILED (restartPolicyType=NEVER + exit), and the schedule
simply never executed — proven by a heartbeat marker that never appeared across
3 weeks of a */3 schedule (zero rows, zero deployments). Rather than keep
fighting Railway's cron, run as a NORMAL long-running service that schedules
itself: ingest once on startup (catch-up + proves the deploy is healthy), then
once daily at 05:15 UTC, forever. The process never exits, so Railway keeps the
container RUNNING (no cosmetic FAILED), and restartPolicyType=ON_FAILURE brings
it back if it ever crashes.

startCommand: python scheduler.py   (NOT a cronSchedule)
"""

from __future__ import annotations

import datetime as dt
import time

import ingest

RUN_HOUR_UTC = 5   # ~07:15 Europe/Berlin (summer) — after last night's sleep finalizes
RUN_MIN_UTC = 15


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def _next_target() -> dt.datetime:
    now = _now()
    nxt = now.replace(hour=RUN_HOUR_UTC, minute=RUN_MIN_UTC, second=0, microsecond=0)
    if nxt <= now:
        nxt += dt.timedelta(days=1)
    return nxt


def _run() -> None:
    print(f"[scheduler] ingest run at {_now():%Y-%m-%d %H:%M:%S} UTC", flush=True)
    try:
        ingest.main()
    except BaseException as e:  # noqa: BLE001 — one failure must never kill the loop
        print(f"[scheduler] ingest failed: {type(e).__name__}: {e}", flush=True)


def main() -> None:
    print("[scheduler] up — running catch-up ingest on startup", flush=True)
    _run()  # every deploy/restart catches up immediately and self-verifies
    while True:
        target = _next_target()
        print(f"[scheduler] next ingest {target:%Y-%m-%d %H:%M} UTC", flush=True)
        # Sleep toward the target in <=1h chunks so a clock hiccup or long nap
        # can't overshoot; re-check the wall clock each time.
        while _now() < target:
            time.sleep(min((target - _now()).total_seconds(), 3600))
        _run()


if __name__ == "__main__":
    main()
