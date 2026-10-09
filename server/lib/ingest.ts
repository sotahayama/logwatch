import { prisma } from "@/lib/prisma";

export const LEVELS = ["debug", "info", "notice", "error", "fault"] as const;
export type Level = (typeof LEVELS)[number];

export type IncomingCount = {
  minute: Date;
  process: string;
  level: Level;
  count: number;
};

export class IngestError extends Error {}

export const MAX_COUNTS_PER_REQUEST = 20_000;
const MAX_PROCESS_NAME = 256;
const ALLOWED_CLOCK_SKEW_MS = 5 * 60_000;

// 1件でも不正なら全体を拒否する(一部だけ保存すると、どこまで届いたかがエージェントから分からなくなる)
export function parseCounts(body: unknown, now = new Date()): IncomingCount[] {
  const counts = (body as { counts?: unknown })?.counts;
  if (!Array.isArray(counts)) {
    throw new IngestError("counts 配列が必要です。");
  }
  if (counts.length > MAX_COUNTS_PER_REQUEST) {
    throw new IngestError(`1回に送れるのは ${MAX_COUNTS_PER_REQUEST} 件までです。`);
  }

  return counts.map((raw, i) => {
    const c = raw as Record<string, unknown>;
    const where = `counts[${i}]`;

    const minute = typeof c.minute === "string" ? new Date(c.minute) : null;
    if (!minute || Number.isNaN(minute.getTime()) || minute.getTime() % 60_000 !== 0) {
      throw new IngestError(`${where}.minute は分の区切りの時刻(ISO 8601)にしてください。`);
    }
    if (minute.getTime() > now.getTime() + ALLOWED_CLOCK_SKEW_MS) {
      throw new IngestError(`${where}.minute が未来の時刻です。`);
    }
    if (typeof c.process !== "string" || !c.process || c.process.length > MAX_PROCESS_NAME) {
      throw new IngestError(`${where}.process が不正です。`);
    }
    if (!LEVELS.includes(c.level as Level)) {
      throw new IngestError(`${where}.level は ${LEVELS.join(" / ")} のいずれかにしてください。`);
    }
    if (!Number.isInteger(c.count) || (c.count as number) <= 0) {
      throw new IngestError(`${where}.count は1以上の整数にしてください。`);
    }

    return { minute, process: c.process, level: c.level as Level, count: c.count as number };
  });
}

// 同じ (端末, 分, プロセス, 重要度) が再送されたら件数を置き換える。足し込むと再送のたびに水増しされる。
// 時刻はUTCの文字列で渡す(Prisma は DateTime をタイムゾーンなしのUTCで保存するため、DBの設定に左右されない形にする)。
export async function storeCounts(hostId: number, counts: IncomingCount[]) {
  await prisma.$transaction([
    prisma.$executeRaw`
      INSERT INTO "MinuteCount" ("hostId", "minute", "process", "level", "count", "receivedAt")
      SELECT ${hostId}, t.minute::timestamp(3), t.process, t.level::"LogLevel", t.count, now()
      FROM unnest(
        ${counts.map((c) => c.minute.toISOString())}::text[],
        ${counts.map((c) => c.process)}::text[],
        ${counts.map((c) => c.level)}::text[],
        ${counts.map((c) => c.count)}::int[]
      ) AS t(minute, process, level, count)
      ON CONFLICT ("hostId", "minute", "process", "level")
      DO UPDATE SET "count" = EXCLUDED."count", "receivedAt" = now()`,
    prisma.host.update({ where: { id: hostId }, data: { lastSeenAt: new Date() } }),
  ]);
}
