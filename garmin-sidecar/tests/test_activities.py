"""Unit tests for the Garmin activity normalizer (no DB, no network)."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import garmin_client as gc  # noqa: E402


def test_map_discipline():
    assert gc._map_discipline("running") == "run"
    assert gc._map_discipline("trail_running") == "run"
    assert gc._map_discipline("road_biking") == "ride"
    assert gc._map_discipline("lap_swimming") == "swim"
    assert gc._map_discipline("hiking") == "hike"
    assert gc._map_discipline("strength_training") == "strength"
    assert gc._map_discipline("some_new_sport") == "other"
    assert gc._map_discipline(None) == "other"


def test_gmt_to_iso():
    assert gc._gmt_to_iso("2026-07-04 20:30:00") == "2026-07-04T20:30:00+00:00"
    assert gc._gmt_to_iso(None) is None
    assert gc._gmt_to_iso("garbage") is None


def _normalize_one(raw):
    """Drive fetch_activities' mapping without Garmin by faking get_activities."""
    class FakeG:
        def get_activities(self, start, limit):
            return [raw]
    return gc.fetch_activities(FakeG(), 1)


def test_fetch_activities_normalizes_a_run():
    raw = {
        "activityId": 19103858666,
        "activityName": "Night Run",
        "startTimeGMT": "2026-07-04 20:30:00",
        "activityType": {"typeKey": "running"},
        "duration": 3600.0,
        "distance": 12043.3,
        "averageHR": 157,
        "maxHR": 175,
        "calories": 1044.0,
        "averageRunningCadenceInStepsPerMinute": 80.4,
        "elevationGain": 21.0,
        "averageSpeed": 3.35,  # m/s → ~298 s/km
    }
    [a] = _normalize_one(raw)
    assert a["source_id"] == "19103858666"
    assert a["discipline"] == "run"
    assert a["started_at"] == "2026-07-04T20:30:00+00:00"
    assert a["duration_s"] == 3600
    assert a["long_run"] is False  # 12 km < 16 km
    m = a["metrics"]
    assert m["name"] == "Night Run"
    assert m["distance_m"] == 12043.3
    assert m["avg_hr"] == 157
    assert m["calories"] == 1044
    assert m["avg_pace_s_per_km"] == round(1000 / 3.35)


def test_long_run_flag_and_missing_fields():
    raw = {
        "activityId": 5,
        "startTimeGMT": "2026-07-06 06:00:00",
        "activityType": {"typeKey": "running"},
        "duration": 7200,
        "distance": 21097.0,  # half marathon → long run
    }
    [a] = _normalize_one(raw)
    assert a["long_run"] is True
    assert a["metrics"]["avg_hr"] is None  # missing → None, not a crash
    assert a["metrics"]["avg_pace_s_per_km"] is None  # no speed


def test_skips_rows_without_id_or_start():
    class FakeG:
        def get_activities(self, s, l):
            return [
                {"activityId": None, "startTimeGMT": "2026-07-06 06:00:00"},
                {"activityId": 9, "startTimeGMT": None},
                {"activityId": 10, "startTimeGMT": "2026-07-06 06:00:00",
                 "activityType": {"typeKey": "running"}, "duration": 60,
                 "distance": 1000.0},
            ]
    out = gc.fetch_activities(FakeG(), 5)
    assert len(out) == 1
    assert out[0]["source_id"] == "10"
