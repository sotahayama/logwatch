import os
from datetime import datetime, timezone

import psycopg

from logwatch_detector.pca import Anomaly, Row


def database_url() -> str:
    return os.environ.get("DATABASE_URL", f"postgresql://{os.environ['USER']}@localhost:5432/logwatch")


def connect(url: str | None = None) -> psycopg.Connection:
    return psycopg.connect(url or database_url())


def utc(m: datetime) -> datetime:
    return m.replace(tzinfo=timezone.utc)


def naive_utc(m: datetime) -> datetime:
    # Prisma は DateTime をタイムゾーンなしの UTC で保存している
    return m.astimezone(timezone.utc).replace(tzinfo=None)


def load_rows(conn: psycopg.Connection, host_id: int, since: datetime | None = None) -> list[Row]:
    query = 'SELECT minute, process, level::text, count FROM "MinuteCount" WHERE "hostId" = %s'
    params: list = [host_id]
    if since is not None:
        query += " AND minute >= %s"
        params.append(naive_utc(since))
    cur = conn.execute(query + " ORDER BY minute", params)
    return [Row(utc(m), p, lv, n) for m, p, lv, n in cur]


def host_ids(conn: psycopg.Connection) -> list[int]:
    return [h for (h,) in conn.execute('SELECT id FROM "Host" ORDER BY id')]


def replace_anomalies(
    conn: psycopg.Connection, host_id: int, minutes: list[datetime], anomalies: list[Anomaly]
) -> None:
    """判定し直した分の PCA の検知結果を置き換える(何度判定しても同じ結果になる)。"""
    with conn.transaction():
        conn.execute(
            """DELETE FROM "Anomaly" WHERE "hostId" = %s AND detector = 'pca' AND minute = ANY(%s)""",
            (host_id, [naive_utc(m) for m in minutes]),
        )
        with conn.cursor() as cur:
            cur.executemany(
                """INSERT INTO "Anomaly"
                   ("hostId", detector, minute, process, level, kind, count, baseline, score)
                   VALUES (%s, 'pca', %s, %s, %s::"LogLevel", %s::"AnomalyKind", %s, %s, %s)""",
                [
                    (host_id, naive_utc(a.minute), a.process, a.level, a.kind, a.count, a.baseline, a.score)
                    for a in anomalies
                ],
            )
