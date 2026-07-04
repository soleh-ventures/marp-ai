"""
Readiness score — the derived HRV proxy the FR245 can't produce natively.

Approach (chosen at the autoplan gate: percentile-of-3 over z-score-of-5):
Rank three INDEPENDENT signals against the athlete's own trailing history —
  - resting HR (lower is better -> inverted)
  - morning body battery (higher is better)
  - sleep quality = (deep + rem) / total (higher is better)
readiness = mean of available signal percentiles (0-100). Band by tertile.

Why not a weighted z-score of five signals: Body Battery is computed FROM Stress
(both HRV-derived), so weighting both double-counts autonomic tone; and z-scores
off a tiny baseline blow up. Percentiles are robust at small n, need no weight
tuning, and are self-explaining ("RHR in your worst 20% today"). Stress and
respiration are kept as separate context/illness flags, not folded into the score.
"""

from statistics import quantiles

MIN_BASELINE = 14  # days of history a signal needs before it can score
GREEN, AMBER, RED = "green", "amber", "red"


def _winsorize(values, lo=0.05, hi=0.95):
    """Clamp to robust percentiles so a travel/3h-sleep outlier can't poison
    the baseline. Needs enough points for quantiles(); else return as-is."""
    xs = sorted(v for v in values if v is not None)
    if len(xs) < 5:
        return xs
    # 100 cut points -> percentile lookup by index.
    qs = quantiles(xs, n=100, method="inclusive")
    lo_v, hi_v = qs[int(lo * 100) - 1], qs[int(hi * 100) - 1]
    return [min(max(x, lo_v), hi_v) for x in xs]


def _percentile_rank(value, dist):
    """0-100: share of the (winsorized) distribution at or below `value`,
    with half-credit for ties. Higher value -> higher percentile."""
    w = _winsorize(dist)
    if not w:
        return None
    below = sum(1 for x in w if x < value)
    equal = sum(1 for x in w if x == value)
    return 100.0 * (below + 0.5 * equal) / len(w)


def _sleep_quality(row):
    total = row.get("sleep_total_s")
    if not total:
        return None
    restorative = (row.get("sleep_deep_s") or 0) + (row.get("sleep_rem_s") or 0)
    return restorative / total


# (name, extractor, higher_is_better)
SIGNALS = [
    ("resting_hr", lambda r: r.get("resting_hr"), False),
    ("body_battery_morning", lambda r: r.get("body_battery_morning"), True),
    ("sleep_quality", _sleep_quality, True),
]


def _band(score):
    if score >= 200 / 3:      # >= 66.7 -> top tertile
        return GREEN
    if score >= 100 / 3:      # >= 33.3 -> mid tertile
        return AMBER
    return RED


def compute_readiness(today: dict, history: list[dict]) -> dict:
    """today: a wellness row (dict). history: prior rows EXCLUDING today.
    Returns {score, band, components} — score/band None while calibrating."""
    components = {}
    percentiles = []
    for name, get, higher_better in SIGNALS:
        val = get(today)
        if val is None:
            components[name] = {"value": None, "reason": "missing"}
            continue
        dist = [v for v in (get(h) for h in history) if v is not None]
        if len(dist) < MIN_BASELINE:
            components[name] = {"value": val, "reason": f"calibrating ({len(dist)}/{MIN_BASELINE}d)"}
            continue
        rank = _percentile_rank(val, dist)
        pct = rank if higher_better else 100.0 - rank
        components[name] = {"value": val, "percentile": round(pct, 1), "baseline_days": len(dist)}
        percentiles.append(pct)

    present = [n for n, c in components.items() if "percentile" in c]
    if not percentiles:
        return {"score": None, "band": "calibrating",
                "components": {**components, "components_present": present}}

    score = round(sum(percentiles) / len(percentiles))
    return {
        "score": score,
        "band": _band(score),
        "components": {**components, "components_present": present},
    }
