"""PCA で異常を判定し続ける常駐プログラム。

    python -m logwatch_detector.worker          # 毎分判定し続ける
    python -m logwatch_detector.worker --once   # 1回だけ判定して終わる
"""

from __future__ import annotations

import argparse
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

import psycopg

from logwatch_detector.db import connect, host_ids, load_rows, replace_anomalies
from logwatch_detector.pca import PcaDetector, Settings

# 評価(evaluate.py)と同じく、15分ごとにその時点までのデータで学習し直す
RETRAIN_EVERY = timedelta(minutes=15)
TRAINING_WINDOW = timedelta(hours=24)
MIN_TRAINING_MINUTES = 30
# エージェントの再送などで遅れて届く分に備え、直近のこの範囲は毎回判定し直す
RESCORE_WINDOW = timedelta(minutes=5)
# 起動直後に遡って判定する範囲
INITIAL_LOOKBACK = timedelta(hours=1)


def log(message: str) -> None:
    print(f"[logwatch-detector] {message}", file=sys.stderr, flush=True)


@dataclass
class HostState:
    detector: PcaDetector | None = None
    trained_at: datetime | None = None
    scored_until: datetime | None = None


@dataclass
class Worker:
    url: str | None = None
    settings: Settings = field(default_factory=Settings)
    states: dict[int, HostState] = field(default_factory=dict)

    def run_once(self, now: datetime) -> int:
        total = 0
        with connect(self.url) as conn:
            for host_id in host_ids(conn):
                total += self.process_host(conn, host_id, now)
        return total

    def process_host(self, conn: psycopg.Connection, host_id: int, now: datetime) -> int:
        state = self.states.setdefault(host_id, HostState())

        if state.detector is None or now - state.trained_at >= RETRAIN_EVERY:
            # 判定する分を学習に含めないよう、学習データは「今」より前に限る
            history = [r for r in load_rows(conn, host_id, since=now - TRAINING_WINDOW) if r.minute < now]
            if len({r.minute for r in history}) < MIN_TRAINING_MINUTES:
                log(f"host {host_id}: 学習データが{MIN_TRAINING_MINUTES}分に満たないため待機します")
                return 0
            state.detector = PcaDetector(self.settings).fit(history)
            state.trained_at = now

        start = (state.scored_until - RESCORE_WINDOW) if state.scored_until else now - INITIAL_LOOKBACK
        rows = load_rows(conn, host_id, since=start)
        targets = sorted({r.minute for r in rows})
        if not targets:
            return 0

        anomalies = state.detector.detect(rows, targets)
        replace_anomalies(conn, host_id, targets, anomalies)
        state.scored_until = targets[-1]
        return len(anomalies)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    worker = Worker()

    while True:
        try:
            found = worker.run_once(datetime.now(timezone.utc))
            log(f"判定しました(異常 {found}件)")
        except psycopg.Error as e:
            log(f"DBに接続できませんでした(次回再試行します): {e}")
            if args.once:
                sys.exit(1)
        if args.once:
            return
        # エージェントが分の区切りの5秒後に送るので、その後に判定する
        now = time.time()
        time.sleep(60 - now % 60 + 15)


if __name__ == "__main__":
    main()
