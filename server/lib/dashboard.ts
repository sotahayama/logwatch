import { prisma } from "@/lib/prisma";
import type { Detector } from "@/app/generated/prisma/client";

export const DETECTORS: Record<Detector, string> = {
  pca: "機械学習(PCA)",
  statistical: "統計的な方法",
};

export function isDetector(value: unknown): value is Detector {
  return typeof value === "string" && value in DETECTORS;
}

export const RANGES = {
  "1h": { minutes: 60, label: "1時間" },
  "3h": { minutes: 180, label: "3時間" },
  "24h": { minutes: 1440, label: "24時間" },
} as const;
export type RangeKey = keyof typeof RANGES;

export function isRangeKey(value: unknown): value is RangeKey {
  return typeof value === "string" && value in RANGES;
}

/** これ以上受信がなければエージェントが止まっているとみなす */
export const STALE_AFTER_MS = 3 * 60_000;

export async function listHosts() {
  return prisma.host.findMany({
    orderBy: { id: "asc" },
    select: { id: true, name: true, lastSeenAt: true },
  });
}

export async function getDashboard(
  hostId: number,
  range: RangeKey,
  process: string | null,
  detector: Detector,
  now = new Date(),
) {
  const end = Math.floor(now.getTime() / 60_000) * 60_000 + 60_000;
  const start = end - RANGES[range].minutes * 60_000;
  const where = { hostId, minute: { gte: new Date(start), lt: new Date(end) } };

  const [byLevel, anomalies, topProcesses, processRows] = await Promise.all([
    prisma.minuteCount.groupBy({ by: ["minute", "level"], where, _sum: { count: true } }),
    prisma.anomaly.findMany({
      where: { ...where, detector },
      orderBy: [{ minute: "desc" }, { score: "desc" }],
      take: 200,
    }),
    prisma.minuteCount.groupBy({
      by: ["process"],
      where,
      _sum: { count: true },
      orderBy: { _sum: { count: "desc" } },
      take: 10,
    }),
    process
      ? prisma.minuteCount.groupBy({
          by: ["minute"],
          where: { ...where, process },
          _sum: { count: true },
        })
      : Promise.resolve([]),
  ]);

  const total = new Map<number, number>();
  const errors = new Map<number, number>();
  const faults = new Map<number, number>();
  for (const row of byLevel) {
    const t = row.minute.getTime();
    const n = row._sum.count ?? 0;
    total.set(t, (total.get(t) ?? 0) + n);
    if (row.level === "error") errors.set(t, n);
    if (row.level === "fault") faults.set(t, n);
  }
  const processCounts = new Map(processRows.map((r) => [r.minute.getTime(), r._sum.count ?? 0]));

  // データが届いていない分(エージェント停止)は null にして、0件と区別する
  const times: number[] = [];
  for (let t = start; t < end; t += 60_000) times.push(t);
  const active = (t: number) => total.has(t);
  const valueAt = (map: Map<number, number>) =>
    times.map((t) => (active(t) ? (map.get(t) ?? 0) : null));

  return {
    times,
    total: valueAt(total),
    errors: valueAt(errors),
    faults: valueAt(faults),
    process: process ? { name: process, counts: valueAt(processCounts) } : null,
    anomalies: anomalies.map((a) => ({ ...a, minute: a.minute.getTime() })),
    topProcesses: topProcesses.map((p) => ({ process: p.process, count: p._sum.count ?? 0 })),
    summary: {
      logs: [...total.values()].reduce((a, b) => a + b, 0),
      errors: [...errors.values(), ...faults.values()].reduce((a, b) => a + b, 0),
      anomalies: anomalies.length,
      activeMinutes: total.size,
      rangeMinutes: RANGES[range].minutes,
    },
  };
}

export type Dashboard = Awaited<ReturnType<typeof getDashboard>>;
