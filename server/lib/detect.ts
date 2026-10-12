import type { Level } from "@/lib/ingest";

export type CountRow = {
  minute: Date;
  process: string;
  level: Level;
  count: number;
};

export type DetectedAnomaly = {
  minute: Date;
  process: string;
  level: Level;
  kind: "spike" | "silence";
  count: number;
  baseline: number;
  score: number;
};

export const DETECTION = {
  /** 平常時とみなす直前の分数(エージェントが動いていた分だけを数える) */
  windowMinutes: 60,
  /** これより平常時のデータが少ないうちは判定しない */
  minBaselineMinutes: 30,
  /** 平常時のばらつきの何倍ずれたら異常とするか */
  scoreThreshold: 6,
  /** 件数の少ないプロセスの揺らぎで騒がないよう、平常時より最低これだけ増えたときだけ急増とする */
  minSpikeIncrease: 20,
  /** 沈黙は、平常時にこれ以上出しているプロセスだけを対象にする */
  minSilenceBaseline: 30,
  /**
   * 急増を知らせる重要度。情報・通知レベルのログ量は Mac の使い方(放置→作業開始など)で
   * 何倍にも変わり、実データではアラートの9割以上がそれだったため対象外にする。
   */
  spikeLevels: ["error", "fault"] as readonly Level[],
  /** 端末全体のログ量が平常時のこの割合を下回る分(スリープ・放置)は、沈黙を判定しない */
  minActivityRatioForSilence: 0.3,
} as const;

function median(sorted: number[]) {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const keyOf = (r: { process: string; level: string }) => `${r.level}\u0000${r.process}`;

// target の1分について、直前の平常時と比べて外れている (プロセス, 重要度) を返す。
// rows には target とそれ以前の行を渡す。行が1つもない分は「エージェントが止まっていた分」として基準から除く。
export function detectMinute(target: Date, rows: CountRow[]): DetectedAnomaly[] {
  const t = target.getTime();
  const activeMinutes = [...new Set(rows.map((r) => r.minute.getTime()).filter((m) => m < t))]
    .sort((a, b) => a - b)
    .slice(-DETECTION.windowMinutes);
  if (activeMinutes.length < DETECTION.minBaselineMinutes) return [];

  const inWindow = new Set(activeMinutes);
  const history = new Map<string, Map<number, number>>();
  const current = new Map<string, CountRow>();
  const meta = new Map<string, { process: string; level: Level }>();

  for (const r of rows) {
    const m = r.minute.getTime();
    const key = keyOf(r);
    if (m === t) {
      current.set(key, r);
    } else if (inWindow.has(m)) {
      if (!history.has(key)) history.set(key, new Map());
      history.get(key)!.set(m, r.count);
    } else {
      continue;
    }
    meta.set(key, { process: r.process, level: r.level });
  }

  const totals = new Map<number, number>();
  let currentTotal = 0;
  for (const r of rows) {
    const m = r.minute.getTime();
    if (m === t) currentTotal += r.count;
    else if (inWindow.has(m)) totals.set(m, (totals.get(m) ?? 0) + r.count);
  }
  const usualTotal = median(activeMinutes.map((m) => totals.get(m) ?? 0).sort((a, b) => a - b));
  const hostIsQuiet = currentTotal < usualTotal * DETECTION.minActivityRatioForSilence;

  const anomalies: DetectedAnomaly[] = [];
  for (const [key, { process, level }] of meta) {
    const past = history.get(key);
    // 動いていた分にその系列の行がなければ0件だったとみなす
    const counts = activeMinutes.map((m) => past?.get(m) ?? 0).sort((a, b) => a - b);
    const baseline = median(counts);
    const mad = median(counts.map((c) => Math.abs(c - baseline)).sort((a, b) => a - b));
    // 毎分ほぼ同じ件数の系列はばらつきが0になるため、件数の自然な揺らぎ(√件数)を下限にする
    const scale = Math.max(1.4826 * mad, Math.sqrt(baseline), 1);
    const count = current.get(key)?.count ?? 0;
    const score = (count - baseline) / scale;

    const isSpike =
      DETECTION.spikeLevels.includes(level) &&
      score >= DETECTION.scoreThreshold &&
      count - baseline >= DETECTION.minSpikeIncrease;
    const isSilence =
      !hostIsQuiet &&
      count === 0 &&
      baseline >= DETECTION.minSilenceBaseline &&
      score <= -DETECTION.scoreThreshold;

    if (isSpike || isSilence) {
      anomalies.push({
        minute: target,
        process,
        level,
        kind: isSpike ? "spike" : "silence",
        count,
        baseline,
        score: Math.round(score * 10) / 10,
      });
    }
  }

  return anomalies.sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
}
