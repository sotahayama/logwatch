import { beforeEach, describe, expect, it } from "vitest";
import { POST } from "@/app/api/ingest/route";
import { registerHost } from "@/lib/hosts";
import { prisma } from "@/lib/prisma";

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE "MinuteCount", "Host" RESTART IDENTITY CASCADE`;
});

function ingest(body: unknown, token?: string) {
  return POST(
    new Request("http://localhost/api/ingest", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

const sample = (overrides: Record<string, unknown> = {}) => ({
  minute: "2026-10-09T09:12:00Z",
  process: "WindowServer",
  level: "notice",
  count: 42,
  ...overrides,
});

async function stored() {
  return prisma.minuteCount.findMany({
    orderBy: [{ hostId: "asc" }, { minute: "asc" }, { process: "asc" }, { level: "asc" }],
    select: { hostId: true, minute: true, process: true, level: true, count: true },
  });
}

describe("認証", () => {
  it("トークンがないと401で、何も保存しない", async () => {
    const res = await ingest({ counts: [sample()] });
    expect(res.status).toBe(401);
    expect(await stored()).toEqual([]);
  });

  it("登録されていないトークンは401", async () => {
    await registerHost("mac");
    const res = await ingest({ counts: [sample()] }, "not-a-real-token");
    expect(res.status).toBe(401);
  });

  it("トークンはハッシュだけを保存する", async () => {
    const { host, token } = await registerHost("mac");
    expect(host.tokenHash).not.toContain(token);
    expect(host.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("保存", () => {
  it("1分×プロセス×重要度ごとの件数を保存し、最終受信時刻を更新する", async () => {
    const { host, token } = await registerHost("mac");

    const res = await ingest(
      { counts: [sample(), sample({ level: "error", count: 3 })] },
      token,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stored: 2 });
    expect(await stored()).toEqual([
      { hostId: host.id, minute: new Date("2026-10-09T09:12:00Z"), process: "WindowServer", level: "notice", count: 42 },
      { hostId: host.id, minute: new Date("2026-10-09T09:12:00Z"), process: "WindowServer", level: "error", count: 3 },
    ]);
    const updated = await prisma.host.findUniqueOrThrow({ where: { id: host.id } });
    expect(updated.lastSeenAt).not.toBeNull();
  });

  it("同じ分が再送されても件数は二重にならず、新しい値で置き換わる", async () => {
    const { token } = await registerHost("mac");

    await ingest({ counts: [sample({ count: 42 })] }, token);
    await ingest({ counts: [sample({ count: 42 })] }, token);
    expect((await stored()).map((r) => r.count)).toEqual([42]);

    await ingest({ counts: [sample({ count: 50 })] }, token);
    expect((await stored()).map((r) => r.count)).toEqual([50]);
  });

  it("別の端末の同じ分・同じプロセスは別々に保存する", async () => {
    const a = await registerHost("mac-a");
    const b = await registerHost("mac-b");

    await ingest({ counts: [sample({ count: 1 })] }, a.token);
    await ingest({ counts: [sample({ count: 2 })] }, b.token);

    expect((await stored()).map((r) => [r.hostId, r.count])).toEqual([
      [a.host.id, 1],
      [b.host.id, 2],
    ]);
  });

  it("時刻はタイムゾーンに関係なくUTCのまま保存する", async () => {
    const { token } = await registerHost("mac");
    await ingest({ counts: [sample({ minute: "2026-10-09T18:12:00+09:00" })] }, token);
    const [row] = await stored();
    expect(row.minute.toISOString()).toBe("2026-10-09T09:12:00.000Z");
  });
});

describe("入力チェック", () => {
  it.each([
    ["分の区切りでない時刻", sample({ minute: "2026-10-09T09:12:30Z" })],
    ["時刻でない文字列", sample({ minute: "yesterday" })],
    ["未知の重要度", sample({ level: "warning" })],
    ["0件", sample({ count: 0 })],
    ["小数の件数", sample({ count: 1.5 })],
    ["空のプロセス名", sample({ process: "" })],
    ["未来の時刻", sample({ minute: "2099-01-01T00:00:00Z" })],
  ])("%s を含むと400で、他の正しい行も保存しない", async (_label, bad) => {
    const { token } = await registerHost("mac");
    const res = await ingest({ counts: [sample({ process: "Finder" }), bad] }, token);
    expect(res.status).toBe(400);
    expect(await stored()).toEqual([]);
  });

  it("JSONとして読めない本文は400", async () => {
    const { token } = await registerHost("mac");
    const res = await ingest("{not json", token);
    expect(res.status).toBe(400);
  });

  it("counts 配列がなければ400", async () => {
    const { token } = await registerHost("mac");
    const res = await ingest({ minute: "2026-10-09T09:12:00Z" }, token);
    expect(res.status).toBe(400);
  });
});
