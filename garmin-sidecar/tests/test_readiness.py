"""Unit tests for the readiness scorer (no DB, no network)."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import readiness as rd  # noqa: E402


def _day(rhr=55, bb=70, total=28800, deep=5400, rem=5400):
    return {"resting_hr": rhr, "body_battery_morning": bb,
            "sleep_total_s": total, "sleep_deep_s": deep, "sleep_rem_s": rem}


def _history(n, **kw):
    return [_day(**kw) for _ in range(n)]


def test_calibrating_below_min_baseline():
    r = rd.compute_readiness(_day(), _history(rd.MIN_BASELINE - 1))
    assert r["score"] is None
    assert r["band"] == "calibrating"
    assert r["components"]["components_present"] == []


def test_scores_once_baseline_met():
    r = rd.compute_readiness(_day(), _history(rd.MIN_BASELINE))
    assert r["score"] is not None
    assert set(r["components"]["components_present"]) == {
        "resting_hr", "body_battery_morning", "sleep_quality"}


def test_good_day_scores_high_bad_day_low():
    # History centered on rhr 55 / bb 70 / decent sleep.
    hist = [_day(rhr=55 + i % 5, bb=68 + i % 5) for i in range(30)]
    good = rd.compute_readiness(_day(rhr=48, bb=90, deep=7000, rem=6000), hist)
    bad = rd.compute_readiness(_day(rhr=68, bb=40, deep=1000, rem=1000), hist)
    assert good["score"] > bad["score"]
    assert good["band"] == "green"
    assert bad["band"] == "red"


def test_resting_hr_is_inverted():
    # Lower RHR than history -> better -> high percentile on that signal.
    hist = _history(20, rhr=60)
    low = rd.compute_readiness(_day(rhr=45), hist)
    high = rd.compute_readiness(_day(rhr=75), hist)
    assert low["components"]["resting_hr"]["percentile"] > \
        high["components"]["resting_hr"]["percentile"]


def test_missing_signal_still_scores_from_others():
    today = _day()
    today["resting_hr"] = None  # RHR unavailable that day
    r = rd.compute_readiness(today, _history(20))
    assert r["score"] is not None
    assert "resting_hr" not in r["components"]["components_present"]
    assert r["components"]["resting_hr"]["reason"] == "missing"


def test_score_always_bounded_0_100_even_with_outliers():
    hist = _history(20, rhr=55)
    hist.append(_day(rhr=200))  # absurd outlier must not break bounds
    r = rd.compute_readiness(_day(rhr=30), hist)
    assert 0 <= r["score"] <= 100


def test_near_constant_history_does_not_explode():
    # A perfectly flat week would make an SD-based score explode; percentiles
    # must stay sane (mid-ish) and bounded.
    hist = _history(20, rhr=55, bb=70)
    r = rd.compute_readiness(_day(rhr=55, bb=70), hist)
    assert 0 <= r["score"] <= 100


def test_band_thresholds():
    assert rd._band(80) == "green"
    assert rd._band(50) == "amber"
    assert rd._band(10) == "red"
