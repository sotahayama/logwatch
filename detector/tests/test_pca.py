from datetime import datetime, timedelta, timezone

import numpy as np
import pytest

from logwatch_detector.pca import PcaDetector, Row, Settings

T0 = datetime(2026, 10, 12, 0, 0, tzinfo=timezone.utc)
PROCESSES = [f"proc{i}" for i in range(20)]


def minute(i: int) -> datetime:
    return T0 + timedelta(minutes=i)


def simulate(n: int, activity, seed: int = 0) -> list[Row]:
    """プロセスごとの基準量 × 端末の忙しさ(activity)で件数が決まる、Mac らしい人工データ。"""
    rng = np.random.default_rng(seed)
    base = np.linspace(20, 400, len(PROCESSES))
    rows = []
    for i in range(n):
        a = activity(i)
        for p, b in zip(PROCESSES, base):
            rows.append(Row(minute(i), p, "notice", int(rng.poisson(b * a)) + 1))
        rows.append(Row(minute(i), "kernel", "error", int(rng.poisson(5 * a)) + 1))
    return rows


# 学習期間には放置(0.1)・軽い作業(1)・重い作業(3)が混ざっている
def mixed(i: int) -> float:
    return [0.1, 1.0, 3.0][(i // 15) % 3]


@pytest.fixture(scope="module")
def detector() -> PcaDetector:
    # 人工データは「端末の忙しさ」1つだけで作っているので主成分も1つにする。
    # 余分な主成分は、系列の少ないデータでは個別の系列の動き(=異常)まで吸収してしまう
    return PcaDetector(Settings(n_components=1)).fit(simulate(300, mixed))


def detect_one(detector: PcaDetector, rows: list[Row], i: int):
    return detector.detect(rows, [minute(i)])


def test_variance_mode_keeps_a_low_dimensional_normal_space():
    detector = PcaDetector(Settings(n_components=None)).fit(simulate(300, mixed))
    assert 1 <= detector.n_components <= 5


def test_whole_host_getting_busy_is_not_an_anomaly(detector):
    # 放置から作業開始で全プロセスが30倍に増えても、全体の状態の変化として説明できる
    rows = simulate(2, lambda i: 0.1 if i == 0 else 3.0, seed=1)
    assert detector.detect(rows, [minute(0), minute(1)]) == []


def jumped_alone(seed: int) -> list[Row]:
    return [
        Row(r.minute, r.process, r.level, r.count * 6 + 200) if r.process == "proc5" else r
        for r in simulate(1, lambda i: 1.0, seed=seed)
    ]


def test_one_process_jumping_alone_is_a_spike_when_all_levels_are_watched():
    detector = PcaDetector(Settings(n_components=1, spike_levels=None)).fit(simulate(300, mixed))
    found = detect_one(detector, jumped_alone(2), 0)
    assert [(a.process, a.level, a.kind) for a in found] == [("proc5", "notice", "spike")]
    assert found[0].baseline < found[0].count


def test_by_default_only_error_and_fault_spikes_are_reported(detector):
    assert detect_one(detector, jumped_alone(2), 0) == []


def test_error_burst_is_a_spike(detector):
    rows = [
        Row(r.minute, r.process, r.level, 300) if r.process == "kernel" else r
        for r in simulate(1, lambda i: 1.0, seed=3)
    ]
    assert [(a.process, a.kind) for a in detect_one(detector, rows, 0)] == [("kernel", "spike")]


def test_busy_process_going_silent_is_detected(detector):
    rows = [r for r in simulate(1, lambda i: 1.0, seed=4) if r.process != "proc19"]
    found = detect_one(detector, rows, 0)
    assert [(a.process, a.kind, a.count) for a in found] == [("proc19", "silence", 0)]


def test_quiet_host_does_not_produce_silence(detector):
    rows = simulate(1, lambda i: 0.1, seed=5)
    assert detect_one(detector, rows, 0) == []


def test_unmodeled_process_reports_only_large_error_bursts(detector):
    rows = simulate(1, lambda i: 1.0, seed=6) + [
        Row(minute(0), "newdaemon", "error", 150),
        Row(minute(0), "NewApp", "notice", 5000),
    ]
    found = detect_one(detector, rows, 0)
    assert [(a.process, a.level, a.kind) for a in found] == [("newdaemon", "error", "spike")]


def test_minutes_without_data_are_skipped(detector):
    assert detector.detect(simulate(1, lambda i: 1.0), [minute(5)]) == []


def test_needs_enough_training_data():
    with pytest.raises(ValueError):
        PcaDetector().fit(simulate(5, mixed))
