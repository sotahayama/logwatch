import { prisma } from "@/lib/prisma";
import { detectMinutes, LOOKBACK_MS } from "@/lib/detect";

// 受信した分それぞれについて検知し直し、その分の以前の検知結果を置き換える(再送されても結果は同じ)
export async function detectAndStore(hostId: number, minutes: Date[]) {
  const targets = [...new Set(minutes.map((m) => m.getTime()))].sort((a, b) => a - b);
  if (targets.length === 0) return [];

  const rows = await prisma.minuteCount.findMany({
    where: {
      hostId,
      minute: { gte: new Date(targets[0] - LOOKBACK_MS), lte: new Date(targets.at(-1)!) },
    },
    select: { minute: true, process: true, level: true, count: true },
  });

  const found = detectMinutes(
    targets.map((t) => new Date(t)),
    rows,
  );

  await prisma.$transaction([
    prisma.anomaly.deleteMany({
      where: { hostId, detector: "statistical", minute: { in: targets.map((t) => new Date(t)) } },
    }),
    prisma.anomaly.createMany({
      data: found.map((a) => ({ hostId, detector: "statistical" as const, ...a })),
    }),
  ]);
  return found;
}
