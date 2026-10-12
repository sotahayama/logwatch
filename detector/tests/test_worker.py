"""テスト用DB(logwatch_test)を使った結合テスト。開発用の logwatch には触れない。"""

import os
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import psycopg
import pytest

from logwatch_detector.db import naive_utc
from logwatch_detector.pca import Settings
from logwatch_detector.worker import Worker

TEST_DATABASE_URL = os.environ.get(
    "TEST_DATABASE_URL", f"postgresql://{os.environ['USER']}@localhost:5432/logwatch_test"
)
SERVER_DIR = Path(__file__).resolve().parents[2] / "server"
NOW = datetime(2026, 10, 12, 6, 0, tzinfo=timezone.utc)


@pytest.fixture(scope="module", autouse=True)
def migrated():
    subprocess.run(
        ["npx", "prisma", "migrate", "deploy"],
        cwd=SERVER_DIR,
        env={**os.environ, "DATABASE_URL": TEST_DATABASE_URL},
        check=True,
        capture_output=True,
    )


@pytest.fixture
def conn():
    with psycopg.connect(TEST_DATABASE_URL, autocommit=True) as c:
        c.execute('TRUNCATE "Anomaly", "MinuteCount", "Host" RESTART IDENTITY CASCADE')
        c.execute("""INSERT INTO "Host" (name, "tokenHash") VALUES ('mac', 'x')""")
        yield c


def insert_counts(conn, minutes: int, burst_at: int | None = None):
    """直前 minutes 分の、忙しさが変わる平常データ。burst_at の分だけ kernel のエラーを急増させる。"""
    rng = np.random.default_rng(0)
    rows = []
    for i in range(minutes):
        minute = NOW - timedelta(minutes=minutes - i)
        activity = [0.2, 1.0, 3.0][(i // 10) % 3]
        for p in range(30):
            rows.append((minute, f"proc{p}", "notice", int(rng.poisson((20 + 10 * p) * activity)) + 1))
        errors = 300 if i == burst_at else int(rng.poisson(5 * activity)) + 1
        rows.append((minute, "kernel", "error", errors))
    with conn.cursor() as cur:
        cur.executemany(
            """INSERT INTO "MinuteCount" ("hostId", minute, process, level, count)
               VALUES (1, %s, %s, %s::"LogLevel", %s)""",
            [(naive_utc(m), p, lv, n) for m, p, lv, n in rows],
        )


def pca_anomalies(conn):
    return conn.execute(
        """SELECT minute, process, level::text, kind::text FROM "Anomaly" WHERE detector = 'pca' ORDER BY minute"""
    ).fetchall()


# テストデータは「忙しさ」1つで作っているので主成分も1つにする(test_pca.py と同じ理由)
SETTINGS = Settings(n_components=1)


def test_waits_until_enough_training_data(conn):
    insert_counts(conn, 20)
    assert Worker(TEST_DATABASE_URL, SETTINGS).run_once(NOW) == 0
    assert pca_anomalies(conn) == []


def test_detects_and_stores_pca_anomalies(conn):
    insert_counts(conn, 120, burst_at=119)
    worker = Worker(TEST_DATABASE_URL, SETTINGS)

    assert worker.run_once(NOW) == 1
    assert pca_anomalies(conn) == [(naive_utc(NOW - timedelta(minutes=1)), "kernel", "error", "spike")]


def test_running_again_does_not_duplicate_and_keeps_statistical_results(conn):
    insert_counts(conn, 120, burst_at=119)
    conn.execute(
        """INSERT INTO "Anomaly" ("hostId", detector, minute, process, level, kind, count, baseline, score)
           VALUES (1, 'statistical', %s, 'kernel', 'error', 'spike', 300, 5, 50)""",
        (naive_utc(NOW - timedelta(minutes=1)),),
    )
    worker = Worker(TEST_DATABASE_URL, SETTINGS)

    worker.run_once(NOW)
    worker.run_once(NOW + timedelta(minutes=1))

    assert len(pca_anomalies(conn)) == 1
    statistical = conn.execute("""SELECT count(*) FROM "Anomaly" WHERE detector = 'statistical'""").fetchone()
    assert statistical == (1,)
