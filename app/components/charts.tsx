import { useState } from "react";
import type { SpendingClass } from "~/db/schema";
import { formatMonth } from "~/lib/dates";
import { formatCents } from "~/lib/money";

/** Class palette — validated for CVD separation + contrast on the app surface. */
export const CHART_CLASS_COLORS: Record<"base" | "living" | "luxury" | "uncategorized", string> = {
  base: "#26854b",
  living: "#d99a06",
  luxury: "#a2371d",
  uncategorized: "#8a9490",
};
const INCOME_COLOR = "#2f7fb8";
const SERIES_COLORS = ["#26854b", "#2f7fb8", "#a2371d", "#d99a06"];

function fmtShort(cents: number): string {
  const d = Math.abs(cents) / 100;
  if (d >= 1_000_000) return `$${(d / 1_000_000).toFixed(1)}m`;
  if (d >= 10_000) return `$${Math.round(d / 1000)}k`;
  if (d >= 1_000) return `$${(d / 1000).toFixed(1)}k`;
  return `$${Math.round(d)}`;
}

function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0];
  const rough = max / count;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= rough) ?? rough;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(Math.round(v));
  return ticks;
}

export interface MonthSpend {
  month: string;
  /** Positive cents per slice */
  base: number;
  living: number;
  luxury: number;
  uncategorized: number;
  income: number;
}

const SLICE_ORDER = ["base", "living", "luxury", "uncategorized"] as const;
const SLICE_LABELS: Record<(typeof SLICE_ORDER)[number], string> = {
  base: "Base",
  living: "Living",
  luxury: "Luxury",
  uncategorized: "Uncategorized",
};

export function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-gray-600">
      <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}

/**
 * Stacked monthly spending by class with an income line on the same $ axis.
 */
export function SpendStackChart({ data }: { data: MonthSpend[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 720;
  const H = 240;
  const PAD = { top: 12, right: 12, bottom: 24, left: 48 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  const maxSpend = Math.max(
    ...data.map((d) => d.base + d.living + d.luxury + d.uncategorized),
    ...data.map((d) => d.income),
    100,
  );
  const ticks = niceTicks(maxSpend);
  const yMax = ticks[ticks.length - 1] || maxSpend;
  const y = (v: number) => PAD.top + innerH - (v / yMax) * innerH;
  const slot = innerW / Math.max(data.length, 1);
  const barW = Math.min(40, slot * 0.55);

  const incomePts = data.map((d, i) => ({
    x: PAD.left + slot * i + slot / 2,
    y: y(d.income),
  }));

  return (
    <div className="relative">
      <div className="mb-2 flex flex-wrap gap-3 px-1">
        {SLICE_ORDER.map((k) => (
          <LegendDot key={k} color={CHART_CLASS_COLORS[k]} label={SLICE_LABELS[k]} />
        ))}
        <LegendDot color={INCOME_COLOR} label="Income" />
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Monthly spending by class with income">
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(t)}
              y2={y(t)}
              stroke="#e5ece7"
              strokeWidth={1}
            />
            <text x={PAD.left - 6} y={y(t) + 3.5} textAnchor="end" fontSize={10} fill="#8a948f">
              {fmtShort(t)}
            </text>
          </g>
        ))}

        {data.map((d, i) => {
          const cx = PAD.left + slot * i + slot / 2;
          const x0 = cx - barW / 2;
          let acc = 0;
          const segs = SLICE_ORDER.map((k) => {
            const v = d[k];
            const seg = { key: k, y0: acc, y1: acc + v, v };
            acc += v;
            return seg;
          }).filter((s) => s.v > 0);
          const total = acc;
          return (
            <g key={d.month}>
              {segs.map((s, si) => {
                const top = y(s.y1);
                const bottom = y(s.y0);
                const h = Math.max(bottom - top - (si < segs.length - 1 ? 2 : 0), 1);
                const isTop = si === segs.length - 1;
                const r = isTop ? Math.min(4, h / 2, barW / 2) : 0;
                return (
                  <path
                    key={s.key}
                    d={`M ${x0} ${top + h}
                        L ${x0} ${top + r}
                        Q ${x0} ${top} ${x0 + r} ${top}
                        L ${x0 + barW - r} ${top}
                        Q ${x0 + barW} ${top} ${x0 + barW} ${top + r}
                        L ${x0 + barW} ${top + h} Z`}
                    fill={CHART_CLASS_COLORS[s.key]}
                    opacity={hover === null || hover === i ? 1 : 0.45}
                  />
                );
              })}
              {total > 0 && hover === i && (
                <text
                  x={cx}
                  y={y(total) - 5}
                  textAnchor="middle"
                  fontSize={10}
                  fontWeight={600}
                  fill="#374742"
                >
                  {fmtShort(total)}
                </text>
              )}
              <text
                x={cx}
                y={H - 8}
                textAnchor="middle"
                fontSize={10}
                fill={hover === i ? "#374742" : "#8a948f"}
              >
                {formatMonth(d.month).replace(" 20", " '")}
              </text>
            </g>
          );
        })}

        <polyline
          points={incomePts.map((p) => `${p.x},${p.y}`).join(" ")}
          fill="none"
          stroke={INCOME_COLOR}
          strokeWidth={2}
          strokeLinejoin="round"
        />
        {incomePts.map((p, i) => (
          <circle
            key={i}
            cx={p.x}
            cy={p.y}
            r={hover === i ? 4.5 : 3}
            fill={INCOME_COLOR}
            stroke="#ffffff"
            strokeWidth={2}
          />
        ))}

        {data.map((_, i) => (
          <rect
            key={i}
            x={PAD.left + slot * i}
            y={PAD.top}
            width={slot}
            height={innerH}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          />
        ))}
      </svg>

      {hover !== null && data[hover] && (
        <div
          className="pointer-events-none absolute top-8 z-10 rounded-lg border border-primary-100 bg-white px-3 py-2 text-xs shadow-md"
          style={{
            left: `${((PAD.left + slot * hover + slot / 2) / W) * 100}%`,
            transform: hover > data.length / 2 ? "translateX(-105%)" : "translateX(8px)",
          }}
        >
          <p className="mb-1 font-semibold text-gray-800">{formatMonth(data[hover].month)}</p>
          {SLICE_ORDER.filter((k) => data[hover][k] > 0).map((k) => (
            <p key={k} className="flex items-center justify-between gap-4 text-gray-600">
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full" style={{ background: CHART_CLASS_COLORS[k] }} />
                {SLICE_LABELS[k]}
              </span>
              <span className="tabular-nums">{formatCents(data[hover][k])}</span>
            </p>
          ))}
          <p className="mt-1 flex items-center justify-between gap-4 border-t border-primary-50 pt-1 font-medium text-gray-800">
            <span>Spent</span>
            <span className="tabular-nums">
              {formatCents(
                data[hover].base + data[hover].living + data[hover].luxury + data[hover].uncategorized,
              )}
            </span>
          </p>
          <p className="flex items-center justify-between gap-4 text-gray-600">
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ background: INCOME_COLOR }} />
              Income
            </span>
            <span className="tabular-nums">{formatCents(data[hover].income)}</span>
          </p>
        </div>
      )}
    </div>
  );
}

export interface TrendSeries {
  name: string;
  points: { date: string; balanceCents: number }[];
}

/** Multi-series balance trend line chart with direct end labels. */
export function TrendLineChart({ series }: { series: TrendSeries[] }) {
  const [hover, setHover] = useState<{ si: number; pi: number } | null>(null);
  const W = 720;
  const H = 220;
  const PAD = { top: 12, right: 110, bottom: 20, left: 56 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  const allPoints = series.flatMap((s) => s.points);
  if (allPoints.length === 0) return null;
  const dates = [...new Set(allPoints.map((p) => p.date))].sort();
  const dateIndex = new Map(dates.map((d, i) => [d, i]));
  const minV = Math.min(...allPoints.map((p) => p.balanceCents));
  const maxV = Math.max(...allPoints.map((p) => p.balanceCents));
  const padV = Math.max((maxV - minV) * 0.1, 100);
  const lo = Math.max(0, minV - padV);
  const hi = maxV + padV;

  const x = (date: string) =>
    PAD.left + ((dateIndex.get(date) ?? 0) / Math.max(dates.length - 1, 1)) * innerW;
  const y = (v: number) => PAD.top + innerH - ((v - lo) / (hi - lo)) * innerH;

  const yTicks = [lo, (lo + hi) / 2, hi];

  return (
    <div className="relative">
      {series.length > 1 && (
        <div className="mb-2 flex flex-wrap gap-3 px-1">
          {series.map((s, i) => (
            <LegendDot key={s.name} color={SERIES_COLORS[i % SERIES_COLORS.length]} label={s.name} />
          ))}
        </div>
      )}
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Account balance trend">
        {yTicks.map((t, i) => (
          <g key={i}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke="#e5ece7" strokeWidth={1} />
            <text x={PAD.left - 6} y={y(t) + 3.5} textAnchor="end" fontSize={10} fill="#8a948f">
              {fmtShort(t)}
            </text>
          </g>
        ))}
        <text x={PAD.left} y={H - 4} fontSize={10} fill="#8a948f">
          {dates[0]}
        </text>
        <text x={W - PAD.right} y={H - 4} textAnchor="end" fontSize={10} fill="#8a948f">
          {dates[dates.length - 1]}
        </text>

        {series.map((s, si) => {
          const color = SERIES_COLORS[si % SERIES_COLORS.length];
          const pts = s.points.map((p) => ({ px: x(p.date), py: y(p.balanceCents), p }));
          const last = pts[pts.length - 1];
          return (
            <g key={s.name}>
              <polyline
                points={pts.map((pt) => `${pt.px},${pt.py}`).join(" ")}
                fill="none"
                stroke={color}
                strokeWidth={2}
                strokeLinejoin="round"
              />
              {last && (
                <text
                  x={last.px + 8}
                  y={last.py + 3.5}
                  fontSize={10.5}
                  fontWeight={600}
                  fill="#374742"
                >
                  {s.name}
                </text>
              )}
              {pts.map((pt, pi) => (
                <circle
                  key={pi}
                  cx={pt.px}
                  cy={pt.py}
                  r={hover?.si === si && hover?.pi === pi ? 4.5 : 2.5}
                  fill={color}
                  stroke="#ffffff"
                  strokeWidth={hover?.si === si && hover?.pi === pi ? 2 : 1}
                  onMouseEnter={() => setHover({ si, pi })}
                  onMouseLeave={() => setHover(null)}
                />
              ))}
            </g>
          );
        })}
      </svg>

      {hover && series[hover.si]?.points[hover.pi] && (
        <div
          className="pointer-events-none absolute top-2 z-10 rounded-lg border border-primary-100 bg-white px-3 py-1.5 text-xs shadow-md"
          style={{
            left: `${(x(series[hover.si].points[hover.pi].date) / W) * 100}%`,
            transform: "translateX(-50%)",
          }}
        >
          <p className="font-semibold text-gray-800">{series[hover.si].name}</p>
          <p className="text-gray-600">
            {series[hover.si].points[hover.pi].date} ·{" "}
            {formatCents(series[hover.si].points[hover.pi].balanceCents)}
          </p>
        </div>
      )}
    </div>
  );
}
