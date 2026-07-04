"""DB-backed tests: schema-drift contract + partial-merge invariant.

Run against a LOCAL dev/test DB only. All writes happen inside a transaction
that is rolled back, so nothing persists. Skips cleanly if DATABASE_URL is unset.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

psycopg = pytest.importorskip("psycopg")
from psycopg.rows import dict_row  # noqa: E402

import ingest  # noqa: E402

DB = os.getenv("DATABASE_URL")
pytestmark = pytest.mark.skipif(not DB, reason="DATABASE_URL not set")

# DB-managed columns the sidecar never writes.
DB_MANAGED = {"id", "athlete_id", "ingested_at"}


@pytest.fixture
def conn():
    if "proxy.rlwy.net" in (DB or ""):
        pytest.skip("refusing to run against a Railway proxy (prod) URL")
    c = psycopg.connect(DB, row_factory=dict_row)
    try:
        yield c
    finally:
        c.rollback()  # undo everything the test wrote
        c.close()


def test_schema_contract_matches_sidecar_columns(conn):
    """The columns the sidecar writes must equal the table's columns exactly
    (minus DB-managed). Catches Drizzle/Python drift before it corrupts data."""
    rows = conn.execute(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_name='garmin_wellness'"
    ).fetchall()
    db_cols = {r["column_name"] for r in rows} - DB_MANAGED
    sidecar_cols = set(ingest.DATA_COLUMNS) | {
        "date", "source", "raw",
        "readiness_score", "readiness_band", "readiness_components",
    }
    assert sidecar_cols == db_cols, (
        f"schema drift: only in DB={db_cols - sidecar_cols}, "
        f"only in sidecar={sidecar_cols - db_cols}"
    )


def _make_athlete(conn):
    row = conn.execute(
        "INSERT INTO athletes (phone, name) VALUES (%s, %s) RETURNING id",
        ("+000000000000", "garmin-test"),
    ).fetchone()
    return str(row["id"])


def test_partial_merge_keeps_nonnull(conn):
    """A later partial pull (nulls) must not clobber good values."""
    aid = _make_athlete(conn)
    full = {"date": "2026-07-01", "source": "garmin", "resting_hr": 52,
            "body_battery_morning": 80, "sleep_total_s": 28800,
            "sleep_deep_s": 5400, "sleep_rem_s": 5400, "raw": {"x": 1}}
    ingest.upsert_day(conn, aid, full)
    # Re-pull the same day but sleep endpoint failed -> those come back null.
    partial = {"date": "2026-07-01", "source": "garmin", "resting_hr": 53,
               "body_battery_morning": None, "sleep_total_s": None,
               "sleep_deep_s": None, "sleep_rem_s": None, "raw": {"x": 2}}
    ingest.upsert_day(conn, aid, partial)
    got = conn.execute(
        "SELECT resting_hr, body_battery_morning, sleep_total_s FROM garmin_wellness "
        "WHERE athlete_id=%s AND date='2026-07-01'", (aid,)
    ).fetchone()
    assert got["resting_hr"] == 53           # newer non-null overwrites
    assert got["body_battery_morning"] == 80  # null did NOT clobber
    assert got["sleep_total_s"] == 28800      # null did NOT clobber


def test_rescore_after_baseline(conn):
    """With >=14 prior days, rescore writes a real score + band."""
    aid = _make_athlete(conn)
    import datetime as dt
    base = dt.date(2026, 6, 1)
    for i in range(20):
        d = (base + dt.timedelta(days=i)).isoformat()
        ingest.upsert_day(conn, aid, {
            "date": d, "source": "garmin", "resting_hr": 55 + (i % 3),
            "body_battery_morning": 70 + (i % 4), "sleep_total_s": 28000,
            "sleep_deep_s": 5000, "sleep_rem_s": 5000, "raw": {}})
    target = (base + dt.timedelta(days=20)).isoformat()
    ingest.upsert_day(conn, aid, {
        "date": target, "source": "garmin", "resting_hr": 50,
        "body_battery_morning": 92, "sleep_total_s": 30000,
        "sleep_deep_s": 6500, "sleep_rem_s": 6000, "raw": {}})
    result = ingest.rescore_day(conn, aid, target)
    assert result["score"] is not None
    assert result["band"] in {"green", "amber", "red"}
