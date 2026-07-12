"""
Daily Garmin ingester. Pulls the working FR245 endpoints, upserts into
garmin_wellness with a keep-non-null merge, then recomputes readiness from the
merged row. Idempotent and catch-up safe: each run backfills from the last
stored date (re-pulling the trailing few days to catch late-arriving sleep).

Usage:
    export DATABASE_URL=postgres://USER@localhost:5432/marp_ai_dev
    python ingest.py                 # backfill to yesterday
    python ingest.py 2026-07-01      # single day
    python ingest.py 2026-06-20 2026-07-03   # explicit range
"""

import datetime as dt
import os
import sys
import time

import psycopg
from dotenv import load_dotenv
from psycopg.rows import dict_row
from psycopg.types.json import Json

import garmin_client as gc
import readiness as rd

load_dotenv()

DATA_COLUMNS = [
    "resting_hr", "vo2max", "hrv_overnight",
    "body_battery_high", "body_battery_low", "body_battery_charged",
    "body_battery_drained", "body_battery_morning",
    "stress_avg", "stress_max",
    "sleep_total_s", "sleep_deep_s", "sleep_light_s", "sleep_rem_s", "sleep_awake_s",
    "resp_sleep_avg", "resp_waking_avg", "resp_low", "resp_high",
]
# Columns used to score readiness (kept small — the scorer only needs these).
SCORE_COLUMNS = ["date", "resting_hr", "body_battery_morning",
                 "sleep_total_s", "sleep_deep_s", "sleep_rem_s"]
BACKFILL_CAP = 45  # never pull more than this many days in one run
RE_PULL_TRAILING = 3  # re-pull last N stored days to catch late sleep data


def resolve_athlete_id(conn) -> str:
    forced = os.getenv("GARMIN_ATHLETE_ID")
    if forced:
        return forced
    rows = conn.execute("SELECT id FROM athletes ORDER BY created_at LIMIT 2").fetchall()
    if len(rows) == 1:
        return str(rows[0]["id"])
    raise SystemExit(
        "[ingest] set GARMIN_ATHLETE_ID — DB has "
        f"{len(rows)} athletes, can't guess which is you."
    )


def dates_to_pull(conn, athlete_id, argv) -> list[str]:
    yesterday = dt.date.today() - dt.timedelta(days=1)
    if len(argv) == 1:
        return [argv[0]]
    if len(argv) == 2:
        start, end = dt.date.fromisoformat(argv[0]), dt.date.fromisoformat(argv[1])
    else:
        row = conn.execute(
            "SELECT max(date) AS m FROM garmin_wellness WHERE athlete_id=%s",
            (athlete_id,),
        ).fetchone()
        last = row and row["m"]
        if last:
            start = dt.date.fromisoformat(last) - dt.timedelta(days=RE_PULL_TRAILING)
        else:
            start = yesterday - dt.timedelta(days=29)  # first run: 30-day baseline
        end = yesterday
    start = max(start, end - dt.timedelta(days=BACKFILL_CAP - 1))
    n = (end - start).days + 1
    return [(start + dt.timedelta(days=i)).isoformat() for i in range(max(n, 0))]


def upsert_day(conn, athlete_id: str, row: dict) -> None:
    """Insert or keep-non-null merge. Never clobbers a good value with a later
    null (partial-day pulls); raw always takes the newest."""
    cols = ["athlete_id"] + DATA_COLUMNS + ["raw", "source", "date"]
    values = {
        "athlete_id": athlete_id,
        "date": row["date"],
        "source": row.get("source", "garmin"),
        "raw": Json(row.get("raw")),
        **{c: row.get(c) for c in DATA_COLUMNS},
    }
    placeholders = ", ".join(f"%({c})s" for c in cols)
    merge = ", ".join(f"{c} = COALESCE(EXCLUDED.{c}, garmin_wellness.{c})" for c in DATA_COLUMNS)
    conn.execute(
        f"INSERT INTO garmin_wellness ({', '.join(cols)}) VALUES ({placeholders}) "
        f"ON CONFLICT (athlete_id, date) DO UPDATE SET {merge}, "
        f"raw = EXCLUDED.raw, ingested_at = now()",
        values,
    )


def rescore_day(conn, athlete_id: str, date: str) -> dict:
    """Recompute readiness for `date` from the merged row + prior history."""
    cols = ", ".join(SCORE_COLUMNS)
    today = conn.execute(
        f"SELECT {cols} FROM garmin_wellness WHERE athlete_id=%s AND date=%s",
        (athlete_id, date),
    ).fetchone()
    history = conn.execute(
        f"SELECT {cols} FROM garmin_wellness WHERE athlete_id=%s AND date < %s ORDER BY date",
        (athlete_id, date),
    ).fetchall()
    result = rd.compute_readiness(dict(today), [dict(h) for h in history])
    conn.execute(
        "UPDATE garmin_wellness SET readiness_score=%s, readiness_band=%s, "
        "readiness_components=%s WHERE athlete_id=%s AND date=%s",
        (result["score"], result["band"], Json(result["components"]), athlete_id, date),
    )
    return result


# How many recent activities to pull each run. Dedup on (source, source_id)
# makes re-pulls free, so this just needs to cover the gap since the last run
# (daily cron → a handful) with headroom for a first-run backfill.
ACTIVITY_PULL_LIMIT = 30


def upsert_activity(conn, athlete_id: str, act: dict) -> bool:
    """Insert one Garmin activity; ON CONFLICT (source, source_id) DO NOTHING.
    Returns True if a new row landed."""
    cur = conn.execute(
        "INSERT INTO activities "
        "(athlete_id, discipline, source, started_at, duration_s, metrics, "
        " source_id, long_run) "
        "VALUES (%s, %s, 'garmin', %s, %s, %s, %s, %s) "
        "ON CONFLICT (source, source_id) DO NOTHING",
        (athlete_id, act["discipline"], act["started_at"], act["duration_s"],
         Json(act["metrics"]), act["source_id"], act["long_run"]),
    )
    return cur.rowcount > 0


def ingest_activities(conn, g, athlete_id: str, full: bool = False) -> None:
    """Pull recent Garmin activities into the shared activities table so the
    coach can analyze them + plan from them (source-agnostic downstream).
    full=True pulls the ENTIRE history (one-time backfill); otherwise the cheap
    recent-N pull the daily cron uses (dedup makes re-pulls free)."""
    acts = gc.fetch_all_activities(g) if full else gc.fetch_activities(g, ACTIVITY_PULL_LIMIT)
    new = 0
    for a in acts:
        try:
            if upsert_activity(conn, athlete_id, a):
                new += 1
        except Exception as e:  # noqa: BLE001 — one bad row never kills the batch
            print(f"[activities] upsert failed for {a.get('source_id')}: "
                  f"{type(e).__name__}: {str(e)[:80]}")
    print(f"[activities] pulled {len(acts)}, {new} new")


# Deep streams: fetch per-second detail for recent Garmin activities that don't
# yet have an activity_streams summary, and POST to the TS summarizer (option B:
# the pure summarizeStreams stays the single source of truth). Bounded per run
# so Garmin's rate limiter (harsher on datacenter IPs) never wedges the ingest.
STREAM_BACKFILL_LIMIT = 8


def ingest_streams(conn, g, athlete_id: str, limit: int | None = STREAM_BACKFILL_LIMIT,
                   resummarize: bool = False) -> None:
    """For recent Garmin runs missing a stream summary, fetch detail+laps+zones
    and POST to /internal/streams/summarize. Best-effort, rate-limit bounded.

    resummarize=True + limit=None re-processes EVERY Garmin run (ignores the
    existing-summary filter and the cap) — used by the one-time backfill so a
    summarizer fix (e.g. the cadence normalization) lands on already-stored
    rows too. The endpoint upserts, so re-POSTing is safe."""
    import requests  # local import — only this path needs it

    base = (os.getenv("MARP_APP_BASE") or "").rstrip("/")
    secret = os.getenv("CRON_SECRET")
    if not base or not secret:
        print("[streams] MARP_APP_BASE / CRON_SECRET unset — skipping stream ingest")
        return

    where_missing = "" if resummarize else "AND s.id IS NULL"
    limit_clause = "" if limit is None else f"LIMIT {int(limit)}"
    rows = conn.execute(
        "SELECT a.source_id FROM activities a "
        "LEFT JOIN activity_streams s ON s.activity_id = a.id "
        "WHERE a.athlete_id=%s AND a.source='garmin' AND a.discipline='run' "
        f"  AND a.source_id IS NOT NULL {where_missing} "
        f"ORDER BY a.started_at DESC {limit_clause}",
        (athlete_id,),
    ).fetchall()
    if not rows:
        print("[streams] none pending")
        return

    done = 0
    for r in rows:
        sid = r["source_id"]
        payload = gc.fetch_activity_streams(g, sid)
        if not payload:
            print(f"[streams] {sid}: no usable detail")
            time.sleep(1.5)
            continue
        try:
            resp = requests.post(
                f"{base}/internal/streams/summarize",
                json={"source": "garmin", "source_id": str(sid), **payload},
                headers={"X-Cron-Secret": secret},
                timeout=30,
            )
            ok = resp.status_code == 200 and resp.json().get("stored")
            print(f"[streams] {sid}: {'stored' if ok else f'HTTP {resp.status_code}'}")
            if ok:
                done += 1
        except Exception as e:  # noqa: BLE001
            print(f"[streams] {sid}: POST failed {type(e).__name__}: {str(e)[:60]}")
        time.sleep(1.5)  # gentle with Garmin's detail endpoint
    print(f"[streams] summarized {done}/{len(rows)}")


def backfill_all(conn, g, athlete_id: str) -> None:
    """One-time: pull the ENTIRE Garmin activity history + re-summarize every
    run's streams (also re-applies summarizer fixes like cadence normalization
    to already-stored rows). Skips the wellness day-loop entirely."""
    print(f"[backfill] athlete={athlete_id} — full activity + stream history")
    ingest_activities(conn, g, athlete_id, full=True)
    ingest_streams(conn, g, athlete_id, limit=None, resummarize=True)


def main() -> None:
    db = os.getenv("DATABASE_URL")
    if not db:
        raise SystemExit("[ingest] DATABASE_URL not set")
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    flags = {a for a in sys.argv[1:] if a.startswith("--")}
    g = gc.connect()
    with psycopg.connect(db, row_factory=dict_row, autocommit=True) as conn:
        athlete_id = resolve_athlete_id(conn)
        if "--backfill-all" in flags:
            backfill_all(conn, g, athlete_id)
            print("[ingest] done")
            return
        dates = dates_to_pull(conn, athlete_id, args)
        print(f"[ingest] athlete={athlete_id} pulling {len(dates)} day(s): "
              f"{dates[0] if dates else '-'}..{dates[-1] if dates else '-'}")
        for date in dates:
            row = gc.fetch_day(g, date)
            upsert_day(conn, athlete_id, row)
            r = rescore_day(conn, athlete_id, date)
            print(f"  {date}: rhr={row.get('resting_hr')} "
                  f"bb_morning={row.get('body_battery_morning')} "
                  f"sleep_h={round((row.get('sleep_total_s') or 0)/3600,1)} "
                  f"-> readiness={r['score']} ({r['band']})")
            time.sleep(1.2)  # be gentle with Garmin's rate limiter
        # Activities + deep streams: independent of the wellness loop and
        # best-effort — a failure here must never lose the recovery data.
        try:
            ingest_activities(conn, g, athlete_id)
        except Exception as e:  # noqa: BLE001
            print(f"[activities] block failed: {type(e).__name__}: {str(e)[:80]}")
        try:
            ingest_streams(conn, g, athlete_id)
        except Exception as e:  # noqa: BLE001
            print(f"[streams] block failed: {type(e).__name__}: {str(e)[:80]}")
    print("[ingest] done")


if __name__ == "__main__":
    # Exit 0 even on failure. On Railway a cron run that exits non-zero marks
    # the deployment FAILED, and a FAILED active deployment DISARMS the daily
    # schedule — so a single transient Garmin blip (expired token, 429, a bad
    # night's data) silently halts the sync for days (observed: 6-day gap after
    # an auth failure). Log loudly and exit clean so the schedule survives and
    # the next scheduled run self-heals. A persistent failure shows in the logs
    # and in garmin_wellness.ingested_at going stale, not as a dead cron.
    try:
        main()
    except SystemExit as e:
        if e.code not in (0, None):
            print(f"[ingest] '{e.code}' — exiting 0 anyway to keep the cron schedule armed")
        sys.exit(0)
    except BaseException as e:  # noqa: BLE001 — nothing should disarm the schedule
        print(f"[ingest] run failed ({type(e).__name__}: {str(e)[:120]}) — "
              f"exiting 0 to keep the cron schedule armed; next run will retry")
        sys.exit(0)
