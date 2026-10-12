from datetime import datetime, timedelta, timezone

import numpy as np

from logwatch_detector.evaluate import Injection, incidents, inject, score
from logwatch_detector.pca import Row, group_by_minute

T0 = datetime(2026, 10, 12, 0, 0, tzinfo=timezone.utc)


def minute(i: int) -> datetime:
    return T0 + timedelta(minutes=i)


def test_consecutive_alerts_on_the_same_series_are_one_incident():
    alerts = {(minute(i), "imagent", "error") for i in range(10)}
    assert incidents(alerts) == 1


def test_alerts_separated_by_a_long_gap_are_separate_incidents():
    alerts = {(minute(0), "imagent", "error"), (minute(20), "imagent", "error")}
    assert incidents(alerts) == 2


def test_different_series_are_separate_incidents():
    alerts = {(minute(0), "imagent", "error"), (minute(0), "imagent", "fault"), (minute(0), "kernel", "error")}
    assert incidents(alerts) == 3


def sample_rows(n: int) -> list[Row]:
    return [
        Row(minute(i), p, lv, c)
        for i in range(n)
        for p, lv, c in [("WindowServer", "notice", 200), ("bluetoothd", "info", 80), ("kernel", "error", 3)]
    ]


def test_injections_modify_the_data_as_recorded():
    original = group_by_minute(sample_rows(30))
    rows, injections = inject(sample_rows(30), 9, np.random.default_rng(0))
    table = group_by_minute(rows)

    assert len(injections) == 9
    assert len({i.minute for i in injections}) == 9  # 1分に1つまで
    for i in injections:
        before = original[i.minute].get((i.process, i.level), 0)
        after = table[i.minute].get((i.process, i.level), 0)
        if i.type == "error_burst":
            assert after - before in (30, 100, 300)
        elif i.type == "volume_burst":
            assert after == before * 5 + 50
        else:
            assert before >= 50 and after == 0


def test_score_counts_hits_and_other_incidents():
    injections = [Injection(minute(1), "kernel", "error", "error_burst"), Injection(minute(2), "x", "info", "silence")]
    alerts = [(minute(1), "kernel", "error"), (minute(5), "Safari", "error"), (minute(6), "Safari", "error")]

    result = score(alerts, injections, test_hours=0.5)

    assert result["recall"] == {"error_burst": 1.0, "silence": 0.0}
    assert result["recall_all"] == 0.5
    assert result["other_incidents_per_hour"] == 2.0  # Safari の2分は1件、30分なので1時間あたり2件
