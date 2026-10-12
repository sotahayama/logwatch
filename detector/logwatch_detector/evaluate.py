"""実データに既知の異常を混ぜ、統計的な方法(本番の TypeScript 実装)と PCA の検知性能を比べる。

    python -m logwatch_detector.evaluate --host 1 --trials 10

- 前半を学習用、後半を評価用に分け、評価用の分にだけ異常を混ぜる
- PCA は本番と同じく、評価期間を一定の区切りごとに進め、その時点までのデータで学習し直す
- 誤報は、同じ系列で続けて出たアラートを1件の出来事にまとめて数える(運用者に届く通知の数)
"""

from __future__ import annotations

import argparse
import json
import subprocess
from collections import defaultdict
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np

from logwatch_detector.db import connect, load_rows
from logwatch_detector.pca import PcaDetector, Row, Settings, group_by_minute

SERVER_DIR = Path(__file__).resolve().parents[2] / "server"
REPORT_DIR = Path(__file__).resolve().parents[1] / "reports"
INJECTION_TYPES = ("error_burst", "volume_burst", "silence")
# この時間以内に同じ系列でアラートが続けば、同じ出来事とみなす
INCIDENT_GAP = timedelta(minutes=5)

AlertKey = tuple[datetime, str, str]


@dataclass(frozen=True)
class Injection:
    minute: datetime
    process: str
    level: str
    type: str

    @property
    def key(self) -> AlertKey:
        return (self.minute, self.process, self.level)


def split(rows: list[Row], train_ratio: float):
    minutes = sorted({r.minute for r in rows})
    cut = minutes[int(len(minutes) * train_ratio)]
    return [r for r in rows if r.minute < cut], [r for r in rows if r.minute >= cut]


def inject(test: list[Row], n: int, rng: np.random.Generator):
    """test の中から n 個の分を選び、1分につき1つ異常を混ぜる。"""
    table = group_by_minute(test)
    minutes = sorted(table)
    chosen = rng.choice(len(minutes), size=min(n, len(minutes)), replace=False)
    injections: list[Injection] = []

    for i, idx in enumerate(sorted(chosen)):
        m = minutes[idx]
        counts = table[m]
        kind = INJECTION_TYPES[i % len(INJECTION_TYPES)]
        if kind == "error_burst":
            process = rng.choice(sorted({p for p, _ in counts}))
            counts[(process, "error")] = counts.get((process, "error"), 0) + int(rng.choice([30, 100, 300]))
            injections.append(Injection(m, process, "error", kind))
        elif kind == "volume_burst":
            candidates = sorted(k for k, c in counts.items() if k[1] in ("info", "notice") and c >= 10)
            if not candidates:
                continue
            key = candidates[rng.integers(len(candidates))]
            counts[key] = counts[key] * 5 + 50
            injections.append(Injection(m, key[0], key[1], kind))
        else:
            candidates = sorted(k for k, c in counts.items() if c >= 50)
            if not candidates:
                continue
            key = candidates[rng.integers(len(candidates))]
            del counts[key]
            injections.append(Injection(m, key[0], key[1], kind))

    rows = [Row(m, p, lv, c) for m, counts in table.items() for (p, lv), c in counts.items()]
    return rows, injections


def run_statistical(history: list[Row], test: list[Row], targets: list[datetime]) -> list[AlertKey]:
    payload = {
        "targets": [t.isoformat() for t in targets],
        "rows": [
            {"minute": r.minute.isoformat(), "process": r.process, "level": r.level, "count": r.count}
            for r in history + test
        ],
    }
    out = subprocess.run(
        ["npx", "tsx", "scripts/detect-cli.mts"],
        cwd=SERVER_DIR,
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    return [(datetime.fromisoformat(a["minute"]), a["process"], a["level"]) for a in json.loads(out)]


def run_pca(
    settings: Settings, history: list[Row], test: list[Row], targets: list[datetime], block: int
) -> list[AlertKey]:
    """評価期間を block 分ずつ進め、その時点までのデータで学習し直してから判定する。"""
    by_minute = group_by_minute(test)
    seen = list(history)
    alerts: list[AlertKey] = []
    for start in range(0, len(targets), block):
        chunk = targets[start : start + block]
        detector = PcaDetector(settings).fit(seen)
        chunk_rows = [Row(m, p, lv, c) for m in chunk for (p, lv), c in by_minute.get(m, {}).items()]
        alerts += [(a.minute, a.process, a.level) for a in detector.detect(chunk_rows, chunk)]
        seen += chunk_rows
    return alerts


def incidents(alerts: set[AlertKey]) -> int:
    """同じ系列で INCIDENT_GAP 以内に続いたアラートを1件にまとめた数。"""
    by_series: dict[tuple[str, str], list[datetime]] = defaultdict(list)
    for minute, process, level in alerts:
        by_series[(process, level)].append(minute)
    total = 0
    for minutes in by_series.values():
        minutes.sort()
        total += 1 + sum(b - a > INCIDENT_GAP for a, b in zip(minutes, minutes[1:]))
    return total


def score(alerts: list[AlertKey], injections: list[Injection], test_hours: float):
    alert_set = set(alerts)
    truth = {i.key for i in injections}
    hits: dict[str, list[bool]] = defaultdict(list)
    for i in injections:
        hits[i.type].append(i.key in alert_set)
    return {
        "recall": {t: float(np.mean(h)) for t, h in hits.items()},
        "recall_all": float(np.mean([i.key in alert_set for i in injections])),
        "other_incidents_per_hour": incidents(alert_set - truth) / test_hours,
    }


def mean_of(results: list[dict]) -> dict:
    return {
        "recall_all": float(np.mean([r["recall_all"] for r in results])),
        "recall": {
            t: float(np.mean([r["recall"][t] for r in results if t in r["recall"]])) for t in INJECTION_TYPES
        },
        "other_incidents_per_hour": float(np.mean([r["other_incidents_per_hour"] for r in results])),
    }


CANDIDATES = {
    "PCA(本番設定:エラー・障害のみ)": Settings(),
    "PCA(全レベル)": Settings(spike_levels=None),
    "PCA(全レベル・しきい値8)": Settings(spike_levels=None, score_threshold=8.0),
    "PCA(主成分の数を分散90%で自動決定)": Settings(n_components=None),
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", type=int, default=1)
    parser.add_argument("--trials", type=int, default=10)
    parser.add_argument("--injections", type=int, default=12)
    parser.add_argument("--train-ratio", type=float, default=0.7)
    parser.add_argument("--block", type=int, default=15, help="PCA を学習し直す間隔(評価期間の分数)")
    args = parser.parse_args()

    with connect() as conn:
        rows = load_rows(conn, args.host)
    history, test = split(rows, args.train_ratio)
    targets = sorted({r.minute for r in test})
    hours = len(targets) / 60
    print(f"データ: 学習 {len({r.minute for r in history})}分 / 評価 {len(targets)}分")

    methods = {
        "統計的な方法(本番)": lambda t: run_statistical(history, t, targets),
        **{
            name: (lambda t, s=s: run_pca(s, history, t, targets, args.block))
            for name, s in CANDIDATES.items()
        },
    }

    summary = {}
    for name, run in methods.items():
        clean = incidents(set(run(test))) / hours
        trials = []
        for seed in range(args.trials):
            injected, injections = inject(test, args.injections, np.random.default_rng(seed))
            trials.append(score(run(injected), injections, hours))
        summary[name] = {**mean_of(trials), "clean_incidents_per_hour": clean}

    print()
    print("| 方法 | 検出率(全体) | エラー急増 | ログ量急増 | 沈黙 | 混ぜた異常以外の通知/時 | 元データでの通知/時 |")
    print("|---|---|---|---|---|---|---|")
    for name, s in summary.items():
        r = s["recall"]
        print(
            f"| {name} | {s['recall_all']:.0%} | {r['error_burst']:.0%} | {r['volume_burst']:.0%} | "
            f"{r['silence']:.0%} | {s['other_incidents_per_hour']:.1f} | {s['clean_incidents_per_hour']:.1f} |"
        )

    REPORT_DIR.mkdir(exist_ok=True)
    report = REPORT_DIR / f"evaluation-{datetime.now():%Y%m%d-%H%M}.json"
    report.write_text(
        json.dumps(
            {
                "args": vars(args),
                "train_minutes": len({r.minute for r in history}),
                "test_minutes": len(targets),
                "candidates": {name: asdict(s) for name, s in CANDIDATES.items()},
                "summary": summary,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    print(f"\n結果を {report.relative_to(REPORT_DIR.parent)} に保存しました。")


if __name__ == "__main__":
    main()
