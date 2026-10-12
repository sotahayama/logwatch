"""PCA による異常検知。

各分を「(プロセス, 重要度) ごとのログ件数」を並べたベクトルとみなす。Mac を使い始める・スリープする
といった状態の変化では多くのプロセスが一斉に増減するので、それを主成分(正常部分空間)として学習し、
そこで説明できない残り(残差)が大きい系列を異常とする。
(Xu et al., "Detecting Large-Scale System Problems by Mining Console Logs", SOSP 2009 と同じ考え方)
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime

import numpy as np
from sklearn.decomposition import PCA

Key = tuple[str, str]  # (process, level)

SPIKE_LEVELS_FOR_UNMODELED = ("error", "fault")


@dataclass(frozen=True)
class Row:
    minute: datetime
    process: str
    level: str
    count: int


@dataclass(frozen=True)
class Anomaly:
    minute: datetime
    process: str
    level: str
    kind: str  # "spike" | "silence"
    count: int
    baseline: float  # 全体の状態から予想される件数
    score: float


@dataclass(frozen=True)
class Settings:
    # 既定値は evaluate.py で実データに異常を混ぜて比べた結果で選んだ(README 参照)
    # 正常部分空間の主成分の数。None なら variance の割合の分散を残す数にする
    n_components: int | None = 3
    variance: float = 0.9
    # 残差のばらつきを学習に使っていない分で見積もるための分割数(0 なら学習データそのもので見積もる)
    cv_folds: int = 5
    # 残差が学習時の残差のばらつきの何倍なら異常か
    score_threshold: float = 6.0
    # 急増を知らせる重要度(None ならすべて)。情報・通知レベルまで含めると通知が約3倍に増える
    spike_levels: tuple[str, ...] | None = ("error", "fault")
    # 件数の少ない系列の揺らぎで騒がないための、予想からの最小の増加数
    min_spike_increase: float = 20
    # 沈黙は、予想件数がこれ以上の系列だけを対象にする
    min_silence_expected: float = 30
    # 学習期間のこの割合以上の分に現れた系列だけを学習する(まれな系列は統計が取れない)
    min_presence: float = 0.2
    max_series: int = 300
    # 学習していない系列(新しいプロセスなど)は、エラー・障害がこの件数以上出たときだけ知らせる
    unmodeled_min_count: int = 100
    # ほとんど変動しない系列で、わずかな差が大きな値に見えないようにする下限
    std_floor: float = 0.1


def group_by_minute(rows: list[Row]) -> dict[datetime, dict[Key, int]]:
    table: dict[datetime, dict[Key, int]] = defaultdict(dict)
    for r in rows:
        table[r.minute][(r.process, r.level)] = r.count
    return table


class PcaDetector:
    def __init__(self, settings: Settings = Settings()):
        self.settings = settings
        self.keys: list[Key] = []

    def fit(self, rows: list[Row]) -> PcaDetector:
        s = self.settings
        table = group_by_minute(rows)
        minutes = sorted(table)
        if len(minutes) < 10:
            raise ValueError("学習には10分以上のデータが必要です。")

        presence: dict[Key, int] = defaultdict(int)
        volume: dict[Key, int] = defaultdict(int)
        for counts in table.values():
            for key, n in counts.items():
                presence[key] += 1
                volume[key] += n
        eligible = [k for k in presence if presence[k] / len(minutes) >= s.min_presence]
        self.keys = sorted(eligible, key=lambda k: -volume[k])[: s.max_series]
        self.index = {k: i for i, k in enumerate(self.keys)}

        x = np.log1p(self._matrix(table, minutes))
        self.mean = x.mean(axis=0)
        self.std = np.maximum(x.std(axis=0), s.std_floor)
        z = (x - self.mean) / self.std

        components = s.n_components if s.n_components is not None else s.variance
        self.pca = PCA(n_components=components, svd_solver="full").fit(z)

        if s.cv_folds >= 2:
            # 学習に使ったデータの残差は小さく出すぎる(過学習)ため、時間順に区切ったブロックごとに
            # 残りのブロックで学習し、そのブロックの残差でばらつきを見積もる
            residual = np.empty_like(z)
            for block in np.array_split(np.arange(len(z)), s.cv_folds):
                rest = np.setdiff1d(np.arange(len(z)), block)
                model = PCA(n_components=components, svd_solver="full").fit(z[rest])
                residual[block] = z[block] - model.inverse_transform(model.transform(z[block]))
        else:
            residual = z - self.pca.inverse_transform(self.pca.transform(z))
        self.residual_std = np.maximum(residual.std(axis=0), s.std_floor)
        return self

    @property
    def n_components(self) -> int:
        return int(self.pca.n_components_)

    def _matrix(self, table: dict[datetime, dict[Key, int]], minutes: list[datetime]) -> np.ndarray:
        m = np.zeros((len(minutes), len(self.keys)))
        for i, minute in enumerate(minutes):
            for key, n in table[minute].items():
                j = self.index.get(key)
                if j is not None:
                    m[i, j] = n
        return m

    def detect(self, rows: list[Row], targets: list[datetime]) -> list[Anomaly]:
        """targets の各分を判定する。rows にはその分の行が含まれていればよい(過去の行は使わない)。"""
        s = self.settings
        table = group_by_minute(rows)
        minutes = [t for t in targets if t in table]  # 行がない分はエージェント停止中なので判定しない
        if not minutes:
            return []

        counts = self._matrix(table, minutes)
        z = (np.log1p(counts) - self.mean) / self.std
        z_hat = self.pca.inverse_transform(self.pca.transform(z))
        scores = (z - z_hat) / self.residual_std
        expected = np.maximum(np.expm1(self.mean + self.std * z_hat), 0)

        found: list[Anomaly] = []
        for i, minute in enumerate(minutes):
            for j, (process, level) in enumerate(self.keys):
                count, exp, score = counts[i, j], expected[i, j], scores[i, j]
                spike_level_ok = s.spike_levels is None or level in s.spike_levels
                if spike_level_ok and score >= s.score_threshold and count - exp >= s.min_spike_increase:
                    kind = "spike"
                elif count == 0 and exp >= s.min_silence_expected and score <= -s.score_threshold:
                    kind = "silence"
                else:
                    continue
                found.append(
                    Anomaly(minute, process, level, kind, int(count), round(float(exp), 1), round(float(score), 1))
                )

            for (process, level), n in table[minute].items():
                if (process, level) in self.index:
                    continue
                if level in SPIKE_LEVELS_FOR_UNMODELED and n >= s.unmodeled_min_count:
                    found.append(Anomaly(minute, process, level, "spike", n, 0.0, float(n)))

        return sorted(found, key=lambda a: (a.minute, -abs(a.score)))
