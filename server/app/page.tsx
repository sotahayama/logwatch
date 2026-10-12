import Link from "next/link";
import { Suspense } from "react";
import type { Detector } from "@/app/generated/prisma/client";
import {
  type Dashboard,
  DETECTORS,
  getDashboard,
  isDetector,
  isRangeKey,
  listHosts,
  RANGES,
  type RangeKey,
  STALE_AFTER_MS,
} from "@/lib/dashboard";
import { formatDateTime, formatNumber, formatTime } from "@/lib/format";
import { AutoRefresh } from "./auto-refresh";
import { type Marker, TimeSeriesChart } from "./time-series-chart";

const REFRESH_MS = 30_000;

const LEVEL_LABEL: Record<string, string> = {
  debug: "デバッグ",
  info: "情報",
  notice: "通知",
  error: "エラー",
  fault: "障害",
};

const KIND_LABEL = { spike: "↑ 急増", silence: "⌀ 沈黙" } as const;

const DETECTOR_DESCRIPTION: Record<Detector, string> = {
  pca: "端末全体の状態(作業中・放置中など)から予想される件数と比べて、大きく外れた「プロセス × 重要度」です。",
  statistical: "直前60分の平常時と比べて、件数が大きく外れた「プロセス × 重要度」です。",
};

type Params = { host: number; range: RangeKey; process: string | null; detector: Detector };

function href(params: Params, change: Partial<Params>) {
  const next = { ...params, ...change };
  const search = new URLSearchParams({
    host: String(next.host),
    range: next.range,
    detector: next.detector,
  });
  if (next.process) search.set("process", next.process);
  return `/?${search}`;
}

// 見出しなどの固定部分は先に表示し、URLパラメータとDBを使う部分だけを読み込み後に差し込む
export default function Home({ searchParams }: PageProps<"/">) {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4 sm:p-6">
      <AutoRefresh intervalMs={REFRESH_MS} />
      <h1 className="text-xl font-bold">logwatch</h1>
      <Suspense fallback={<p className="text-ink-muted">読み込み中…</p>}>
        <DashboardView searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function DashboardView({ searchParams }: Pick<PageProps<"/">, "searchParams">) {
  const query = await searchParams;
  const hosts = await listHosts();

  if (hosts.length === 0) {
    return (
      <p className="text-ink-secondary">
        まだ端末が登録されていません。<code>npm run host:add -- &lt;端末名&gt;</code>{" "}
        で登録し、表示されたトークンでエージェントを起動してください。
      </p>
    );
  }

  const host = hosts.find((h) => String(h.id) === query.host) ?? hosts[0];
  const range: RangeKey = isRangeKey(query.range) ? query.range : "3h";
  const process = typeof query.process === "string" && query.process ? query.process : null;
  const detector: Detector = isDetector(query.detector) ? query.detector : "pca";
  const params: Params = { host: host.id, range, process, detector };

  const now = new Date();
  const data = await getDashboard(host.id, range, process, detector, now);
  const receiving = host.lastSeenAt && now.getTime() - host.lastSeenAt.getTime() < STALE_AFTER_MS;

  return (
    <>
      <nav aria-label="表示条件" className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        <div className="flex items-center gap-2">
          <span className="text-ink-muted">期間</span>
          <div className="flex overflow-hidden rounded-md border border-line">
            {(Object.keys(RANGES) as RangeKey[]).map((key) => (
              <Link
                key={key}
                href={href(params, { range: key })}
                aria-current={key === range ? "page" : undefined}
                className={`px-3 py-1 ${key === range ? "bg-ink text-page" : "bg-surface text-ink-secondary hover:bg-grid"}`}
              >
                {RANGES[key].label}
              </Link>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-ink-muted">検知方法</span>
          <div className="flex overflow-hidden rounded-md border border-line">
            {(Object.keys(DETECTORS) as Detector[]).map((key) => (
              <Link
                key={key}
                href={href(params, { detector: key })}
                aria-current={key === detector ? "page" : undefined}
                className={`px-3 py-1 ${key === detector ? "bg-ink text-page" : "bg-surface text-ink-secondary hover:bg-grid"}`}
              >
                {DETECTORS[key]}
              </Link>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-ink-muted">端末</span>
          {hosts.map((h) => (
            <Link
              key={h.id}
              href={href(params, { host: h.id, process: null })}
              aria-current={h.id === host.id ? "page" : undefined}
              className={h.id === host.id ? "font-semibold text-ink" : "text-ink-secondary underline"}
            >
              {h.name}
            </Link>
          ))}
        </div>
        <p className="text-ink-muted sm:ml-auto">{formatTime(now)} 時点 ・ 30秒ごとに自動更新</p>
      </nav>

      <section aria-label="概要" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="エージェント">
          <span className="flex items-center gap-2">
            <span
              aria-hidden
              className={`inline-flex size-5 items-center justify-center rounded-full text-xs text-white ${receiving ? "bg-good" : "bg-critical"}`}
            >
              {receiving ? "✓" : "!"}
            </span>
            {receiving ? "受信中" : host.lastSeenAt ? "停止中" : "未受信"}
          </span>
          <span className="mt-1 block text-xs font-normal text-ink-muted">
            最終受信 {host.lastSeenAt ? formatDateTime(host.lastSeenAt) : "なし"}
          </span>
        </Tile>
        <Tile label={`ログ件数(${RANGES[range].label})`}>{formatNumber(data.summary.logs)}</Tile>
        <Tile label="エラー・障害">{formatNumber(data.summary.errors)}</Tile>
        <Tile label="検知した異常">{formatNumber(data.summary.anomalies)}</Tile>
      </section>

      {data.summary.activeMinutes === 0 ? (
        <p className="rounded-lg border border-line bg-surface p-6 text-ink-secondary">
          この期間のデータはまだありません。
        </p>
      ) : (
        <>
          <TimeSeriesChart
            title="1分ごとのログ件数"
            description="線が途切れている時間は、エージェントからデータが届いていません。"
            times={data.times}
            series={[{ name: "ログ件数", color: "var(--series-1)", values: data.total }]}
            markers={minuteMarkers(data)}
          />
          <TimeSeriesChart
            title="エラー・障害の件数"
            times={data.times}
            series={[
              { name: "エラー", color: "var(--series-1)", values: data.errors },
              { name: "障害(fault)", color: "var(--series-2)", values: data.faults },
            ]}
            height={160}
          />

          <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
            <AnomalyTable data={data} params={params} />
            {data.process ? (
              <ProcessPanel data={data} params={params} />
            ) : (
              <TopProcesses data={data} params={params} />
            )}
          </div>
        </>
      )}
    </>
  );
}

function Tile({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <div className="text-sm text-ink-secondary">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-ink">{children}</div>
    </div>
  );
}

function minuteMarkers(data: Dashboard): Marker[] {
  const byMinute = new Map<number, string[]>();
  for (const a of data.anomalies) {
    const name = `${a.process}(${LEVEL_LABEL[a.level]})`;
    byMinute.set(a.minute, [...(byMinute.get(a.minute) ?? []), name]);
  }
  return [...byMinute].map(([minute, processes]) => ({
    index: data.times.indexOf(minute),
    label: `異常 ${processes.length}件: ${processes.slice(0, 3).join("、")}${processes.length > 3 ? " ほか" : ""}`,
  }));
}

function AnomalyTable({ data, params }: { data: Dashboard; params: Params }) {
  return (
    <section className="min-w-0 rounded-lg border border-line bg-surface p-4">
      <h2 className="font-semibold">検知した異常</h2>
      <p className="mb-2 text-sm text-ink-secondary">{DETECTOR_DESCRIPTION[params.detector]}</p>
      {data.anomalies.length === 0 ? (
        <p className="text-sm text-ink-muted">この期間に検知した異常はありません。</p>
      ) : (
        <div className="max-h-96 overflow-auto">
          <table className="w-full whitespace-nowrap text-left text-sm">
            <thead className="sticky top-0 bg-surface text-ink-muted">
              <tr>
                <th className="py-1 pr-3 font-normal">時刻</th>
                <th className="py-1 pr-3 font-normal">プロセス</th>
                <th className="py-1 pr-3 font-normal">重要度</th>
                <th className="py-1 pr-3 font-normal">種類</th>
                <th className="py-1 pr-3 text-right font-normal">件数</th>
                <th className="py-1 text-right font-normal">平常時</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {data.anomalies.map((a) => (
                <tr key={`${a.minute}-${a.process}-${a.level}`} className="border-t border-line">
                  <td className="py-1.5 pr-3 text-ink-secondary">{formatTime(a.minute)}</td>
                  <td className="max-w-48 truncate py-1.5 pr-3" title={a.process}>
                    <Link href={href(params, { process: a.process })} className="underline">
                      {a.process}
                    </Link>
                  </td>
                  <td className="py-1.5 pr-3">{LEVEL_LABEL[a.level]}</td>
                  <td className="py-1.5 pr-3">{KIND_LABEL[a.kind]}</td>
                  <td className="py-1.5 pr-3 text-right font-semibold">{formatNumber(a.count)}</td>
                  <td className="py-1.5 text-right text-ink-secondary">
                    {formatNumber(Math.round(a.baseline))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function TopProcesses({ data, params }: { data: Dashboard; params: Params }) {
  const max = data.topProcesses[0]?.count ?? 1;
  return (
    <section className="min-w-0 rounded-lg border border-line bg-surface p-4">
      <h2 className="font-semibold">ログの多いプロセス</h2>
      <p className="mb-3 text-sm text-ink-secondary">選ぶと、そのプロセスの推移を表示します。</p>
      <ol className="flex flex-col gap-2 text-sm">
        {data.topProcesses.map((p) => (
          <li key={p.process}>
            <Link href={href(params, { process: p.process })} className="group block">
              <div className="flex justify-between gap-2">
                <span className="truncate group-hover:underline" title={p.process}>
                  {p.process}
                </span>
                <span className="tabular-nums text-ink-secondary">{formatNumber(p.count)}</span>
              </div>
              <div className="mt-1 h-1.5 rounded-full bg-grid">
                <div
                  className="h-1.5 rounded-full bg-series-1"
                  style={{ width: `${(p.count / max) * 100}%` }}
                />
              </div>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}

function ProcessPanel({ data, params }: { data: Dashboard; params: Params }) {
  const process = data.process!;
  const markers: Marker[] = data.anomalies
    .filter((a) => a.process === process.name)
    .map((a) => ({
      index: data.times.indexOf(a.minute),
      label: `${KIND_LABEL[a.kind]}(${LEVEL_LABEL[a.level]}・平常時 ${formatNumber(Math.round(a.baseline))}件)`,
    }));

  return (
    <section className="flex min-w-0 flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="truncate font-semibold" title={process.name}>
          {process.name}
        </h2>
        <Link href={href(params, { process: null })} className="shrink-0 text-sm text-ink-secondary underline">
          選択を解除
        </Link>
      </div>
      <TimeSeriesChart
        title="このプロセスのログ件数"
        times={data.times}
        series={[{ name: process.name, color: "var(--series-1)", values: process.counts }]}
        markers={markers}
        height={180}
      />
    </section>
  );
}
