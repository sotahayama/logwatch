import { describe, expect, it } from "vitest";
import { type CountRow, detectMinute } from "@/lib/detect";
import type { Level } from "@/lib/ingest";

const T0 = Date.parse("2026-10-09T09:00:00Z");
const minute = (i: number) => new Date(T0 + i * 60_000);

// i分目の件数を返す関数から、60分の平常時 + 判定する1分(60分目)の行を作る
function series(
  process: string,
  countAt: (i: number) => number,
  { level = "notice" as Level, minutes = 61 } = {},
): CountRow[] {
  return Array.from({ length: minutes }, (_, i) => ({
    minute: minute(i),
    process,
    level,
    count: countAt(i),
  })).filter((r) => r.count > 0);
}

// 揺らぎのある平常時(80〜120件)
const noisy = (i: number) => 100 + ((i * 37) % 41) - 20;
const TARGET = minute(60);

describe("検知しない(平常時)", () => {
  it("揺らぎの範囲内なら何も検知しない", () => {
    expect(detectMinute(TARGET, series("WindowServer", noisy))).toEqual([]);
  });

  it("件数の少ないプロセスが数件増えただけでは騒がない", () => {
    const rows = series("cron", (i) => (i === 60 ? 12 : i % 3));
    expect(detectMinute(TARGET, rows)).toEqual([]);
  });

  it("平常時のデータが30分に満たないうちは判定しない", () => {
    const rows = series("WindowServer", (i) => (i === 20 ? 5000 : 100), { minutes: 21 });
    expect(detectMinute(minute(20), rows)).toEqual([]);
  });
});

describe("急増", () => {
  it("平常時から大きく増えたら、件数と平常時の値とともに検知する", () => {
    const rows = series("kernel", (i) => (i === 60 ? 400 : noisy(i)), { level: "error" });

    const [anomaly] = detectMinute(TARGET, rows);

    expect(anomaly).toMatchObject({
      process: "kernel",
      level: "error",
      kind: "spike",
      count: 400,
    });
    expect(anomaly.baseline).toBeGreaterThan(90);
    expect(anomaly.baseline).toBeLessThan(110);
    expect(anomaly.score).toBeGreaterThan(6);
  });

  it("これまで出ていなかったプロセスが大量に出たら検知する", () => {
    const rows = [
      ...series("WindowServer", noisy),
      ...series("logger", (i) => (i === 60 ? 500 : 0), { level: "fault" }),
    ];
    expect(detectMinute(TARGET, rows)).toEqual([
      expect.objectContaining({ process: "logger", kind: "spike", count: 500, baseline: 0 }),
    ]);
  });

  it("情報・通知レベルの急増はアラートにしない(使い方で大きく変わるため)", () => {
    const rows = [
      ...series("WindowServer", (i) => (i === 60 ? 5000 : noisy(i)), { level: "notice" }),
      ...series("Safari", (i) => (i === 60 ? 3000 : 0), { level: "info" }),
    ];
    expect(detectMinute(TARGET, rows)).toEqual([]);
  });

  it("同じプロセスでも重要度ごとに判定する", () => {
    const rows = [
      ...series("kernel", noisy, { level: "info" }),
      ...series("kernel", (i) => (i === 60 ? 80 : 1), { level: "error" }),
    ];
    expect(detectMinute(TARGET, rows)).toEqual([
      expect.objectContaining({ process: "kernel", level: "error", kind: "spike" }),
    ]);
  });
});

describe("沈黙", () => {
  it("普段たくさん出すプロセスが0件になったら検知する", () => {
    const rows = [
      ...series("WindowServer", noisy),
      ...series("bluetoothd", (i) => (i === 60 ? 0 : noisy(i))),
    ];
    expect(detectMinute(TARGET, rows)).toEqual([
      expect.objectContaining({ process: "bluetoothd", kind: "silence", count: 0 }),
    ]);
  });

  it("端末全体が静かになった分(スリープ・放置)では沈黙を判定しない", () => {
    const rows = [
      ...series("WindowServer", (i) => (i === 60 ? 10 : noisy(i))),
      ...series("bluetoothd", (i) => (i === 60 ? 0 : noisy(i))),
    ];
    expect(detectMinute(TARGET, rows)).toEqual([]);
  });

  it("普段から少ししか出さないプロセスが0件になっても騒がない", () => {
    const rows = [...series("WindowServer", noisy), ...series("cron", (i) => (i === 60 ? 0 : 5))];
    expect(detectMinute(TARGET, rows)).toEqual([]);
  });
});

describe("エージェントの停止", () => {
  it("データが届いていない分は0件ではなく平常時から除外する", () => {
    // 前半30分はエージェントが止まっていた(行がない)。0件扱いなら基準が下がり、平常の100件を急増と誤検知する
    const rows = series("WindowServer", (i) => (i < 30 ? 0 : 100));
    expect(detectMinute(TARGET, rows)).toEqual([]);
  });

  it("判定する分より後の行は使わない", () => {
    const rows = series("WindowServer", (i) => (i > 60 ? 5000 : 100), { minutes: 70 });
    expect(detectMinute(TARGET, rows)).toEqual([]);
  });
});
