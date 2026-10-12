"use client";

import { useEffect, useRef, useState } from "react";
import { formatDateTime, formatNumber, formatTime } from "@/lib/format";

export type Series = { name: string; color: string; values: (number | null)[] };
export type Marker = { index: number; label: string };

const MARGIN = { top: 12, right: 16, bottom: 28, left: 56 };
const JST_OFFSET_MS = 9 * 3_600_000;

function niceStep(raw: number) {
  if (raw <= 1) return 1;
  const exp = 10 ** Math.floor(Math.log10(raw));
  const f = raw / exp;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * exp;
}

// 目盛りが6個以下になる、日本時間のきりのよい分間隔を選ぶ
function xTickTimes(times: number[]) {
  const spanMinutes = times.length;
  const interval =
    [5, 10, 15, 30, 60, 120, 180, 240, 360].find((m) => spanMinutes / m <= 6) ??
    360;
  return times.filter((t) => ((t + JST_OFFSET_MS) / 60_000) % interval === 0);
}

// null(データなし)で線を切る
function segments(values: (number | null)[]) {
  const result: { i: number; v: number }[][] = [];
  let current: { i: number; v: number }[] = [];
  values.forEach((v, i) => {
    if (v === null) {
      if (current.length) result.push(current);
      current = [];
    } else {
      current.push({ i, v });
    }
  });
  if (current.length) result.push(current);
  return result;
}

export function TimeSeriesChart({
  title,
  description,
  times,
  series,
  markers = [],
  markerLabel = "異常を検知",
  height = 200,
}: {
  title: string;
  description?: string;
  times: number[];
  series: Series[];
  markers?: Marker[];
  markerLabel?: string;
  height?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  // 実際の幅を測るまではグラフを描かない(仮の幅で描くと、狭い画面で一瞬はみ出して見える)
  const [measuredWidth, setMeasuredWidth] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) =>
      setMeasuredWidth(entry.contentRect.width),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const width = measuredWidth ?? 0;
  const plotW = Math.max(width - MARGIN.left - MARGIN.right, 10);
  const plotH = height - MARGIN.top - MARGIN.bottom;
  const max = Math.max(
    0,
    ...series.flatMap((s) => s.values.filter((v): v is number => v !== null)),
  );
  const step = niceStep(max / 4);
  const yMax = Math.max(Math.ceil(max / step) * step, step);
  const yTicks = Array.from(
    { length: Math.round(yMax / step) + 1 },
    (_, k) => k * step,
  );

  const x = (i: number) =>
    MARGIN.left + (times.length <= 1 ? 0 : (i / (times.length - 1)) * plotW);
  const y = (v: number) => MARGIN.top + plotH - (v / yMax) * plotH;
  const baseline = y(0);

  // 同じ分に複数の異常があれば1つの印にまとめる
  const markerAt = new Map<number, string>();
  for (const m of markers) {
    if (m.index < 0) continue;
    markerAt.set(
      m.index,
      markerAt.has(m.index) ? `${markerAt.get(m.index)} / ${m.label}` : m.label,
    );
  }
  const showLegend = series.length >= 2 || markers.length > 0;

  function indexFromPointer(clientX: number, svg: SVGSVGElement) {
    const px = clientX - svg.getBoundingClientRect().left - MARGIN.left;
    const i = Math.round((px / plotW) * (times.length - 1));
    return Math.min(Math.max(i, 0), times.length - 1);
  }

  const tooltipLeft = hover === null ? 0 : x(hover);
  const flip = tooltipLeft > width - 200;

  return (
    <figure className="min-w-0 rounded-lg border border-line bg-surface p-4">
      <figcaption className="mb-2">
        <h2 className="font-semibold text-ink">{title}</h2>
        {description && (
          <p className="text-sm text-ink-secondary">{description}</p>
        )}
      </figcaption>

      {showLegend && (
        <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-ink-secondary">
          {series.map((s) => (
            <li key={s.name} className="flex items-center gap-1.5">
              <span
                className="inline-block h-0.5 w-4 rounded"
                style={{ background: s.color }}
              />
              {s.name}
            </li>
          ))}
          {markers.length > 0 && (
            <li className="flex items-center gap-1.5">
              <span className="inline-block size-2.5 rounded-full bg-critical" />
              {markerLabel}
            </li>
          )}
        </ul>
      )}

      <div ref={containerRef} className="relative min-w-0" style={{ height }}>
        {measuredWidth !== null && (
          <svg
            width={width}
            height={height}
            role="img"
            aria-label={`${title}の折れ線グラフ。矢印キーで時刻ごとの値を確認できます。`}
            tabIndex={0}
            className="block touch-none outline-none focus-visible:ring-2 focus-visible:ring-series-1"
            onPointerMove={(e) =>
              setHover(indexFromPointer(e.clientX, e.currentTarget))
            }
            onPointerLeave={() => setHover(null)}
            onBlur={() => setHover(null)}
            onKeyDown={(e) => {
              if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
              e.preventDefault();
              const delta = e.key === "ArrowLeft" ? -1 : 1;
              setHover((h) =>
                Math.min(
                  Math.max((h ?? times.length - 1) + delta, 0),
                  times.length - 1,
                ),
              );
            }}
          >
            {yTicks.map((v) => (
              <g key={v}>
                <line
                  x1={MARGIN.left}
                  x2={MARGIN.left + plotW}
                  y1={y(v)}
                  y2={y(v)}
                  stroke={v === 0 ? "var(--axis)" : "var(--grid)"}
                  strokeWidth={1}
                />
                <text
                  x={MARGIN.left - 8}
                  y={y(v)}
                  textAnchor="end"
                  dominantBaseline="middle"
                  className="fill-ink-muted text-[11px] tabular-nums"
                >
                  {formatNumber(v)}
                </text>
              </g>
            ))}

            {xTickTimes(times).map((t) => {
              const i = times.indexOf(t);
              return (
                <text
                  key={t}
                  x={x(i)}
                  y={baseline + 18}
                  textAnchor="middle"
                  className="fill-ink-muted text-[11px] tabular-nums"
                >
                  {formatTime(t)}
                </text>
              );
            })}

            {series.map((s) =>
              segments(s.values).map((seg, k) => {
                const line = seg
                  .map((p, j) => `${j ? "L" : "M"}${x(p.i)},${y(p.v)}`)
                  .join("");
                const area = `${line}L${x(seg.at(-1)!.i)},${baseline}L${x(seg[0].i)},${baseline}Z`;
                return (
                  <g key={`${s.name}-${k}`}>
                    {series.length === 1 && (
                      <path d={area} fill={s.color} opacity={0.1} />
                    )}
                    <path
                      d={line}
                      fill="none"
                      stroke={s.color}
                      strokeWidth={2}
                      strokeLinejoin="round"
                      strokeLinecap="round"
                    />
                  </g>
                );
              }),
            )}

            {[...markerAt.keys()].map((index) => {
              const v = series[0]?.values[index];
              return (
                <circle
                  key={index}
                  cx={x(index)}
                  cy={v == null ? baseline : y(v)}
                  r={4}
                  fill="var(--status-critical)"
                  stroke="var(--surface)"
                  strokeWidth={2}
                />
              );
            })}

            {hover !== null && (
              <line
                x1={x(hover)}
                x2={x(hover)}
                y1={MARGIN.top}
                y2={baseline}
                stroke="var(--ink-muted)"
                strokeWidth={1}
                pointerEvents="none"
              />
            )}
          </svg>
        )}

        {hover !== null && (
          <div
            role="status"
            className="pointer-events-none absolute z-10 min-w-40 rounded-md border border-line bg-surface px-3 py-2 text-sm shadow-md"
            style={{
              top: MARGIN.top,
              left: flip ? undefined : tooltipLeft + 12,
              right: flip ? width - tooltipLeft + 12 : undefined,
            }}
          >
            <div className="mb-1 text-xs text-ink-muted">
              {formatDateTime(times[hover])}
            </div>
            {series.map((s) => {
              const v = s.values[hover];
              return (
                <div key={s.name} className="flex items-center gap-2">
                  <span
                    className="inline-block h-0.5 w-3 rounded"
                    style={{ background: s.color }}
                  />
                  <span className="font-semibold text-ink tabular-nums">
                    {v === null ? "データなし" : `${formatNumber(v)}件`}
                  </span>
                  <span className="text-ink-secondary">{s.name}</span>
                </div>
              );
            })}
            {markerAt.has(hover) && (
              <div className="mt-1 flex items-center gap-2 text-ink">
                <span className="inline-block size-2 rounded-full bg-critical" />
                {markerAt.get(hover)}
              </div>
            )}
          </div>
        )}
      </div>

      <details className="mt-2 text-sm">
        <summary className="cursor-pointer text-ink-secondary">
          表で見る
        </summary>
        <div className="mt-2 max-h-64 overflow-auto">
          <table className="w-full text-left tabular-nums">
            <thead className="sticky top-0 bg-surface text-ink-muted">
              <tr>
                <th className="py-1 pr-4 font-normal">時刻</th>
                {series.map((s) => (
                  <th key={s.name} className="py-1 pr-4 font-normal">
                    {s.name}
                  </th>
                ))}
                {markers.length > 0 && (
                  <th className="py-1 font-normal">{markerLabel}</th>
                )}
              </tr>
            </thead>
            <tbody>
              {times.map((t, i) =>
                series.every((s) => s.values[i] === null) ? null : (
                  <tr key={t} className="border-t border-line">
                    <td className="py-1 pr-4 text-ink-secondary">
                      {formatDateTime(t)}
                    </td>
                    {series.map((s) => (
                      <td key={s.name} className="py-1 pr-4">
                        {formatNumber(s.values[i] ?? 0)}
                      </td>
                    ))}
                    {markers.length > 0 && (
                      <td className="py-1">{markerAt.get(i) ?? ""}</td>
                    )}
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
