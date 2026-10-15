'use client';

import * as React from 'react';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Skeleton, cn, intlLocale, useI18n } from '@typease/ui';

/**
 * Charts of the dashboard and the reports, drawn with recharts in the theme's colours
 * (CSS variables, so light / dark and white-label brands follow automatically).
 *
 * Rules kept here: one value axis per chart (counts and money never share one), thin marks,
 * hairline grid, a legend whenever there are two or more series, the second series also
 * differs by shape (dashed line / lighter bar), text in text colours - never in series colours.
 */
const SERIES_COLOURS = ['hsl(var(--secondary))', 'hsl(var(--accent))', 'hsl(var(--primary-text))', 'hsl(var(--muted-foreground))'];
const AXIS = 'hsl(var(--muted-foreground))';
const GRID = 'hsl(var(--border))';

export interface ChartSeries {
  key: string;
  label: string;
}
export type ChartValueType = 'money' | 'number' | 'percent';
export type ChartXType = 'date' | 'month' | 'text';

export interface SeriesChartProps {
  type: 'line' | 'bar';
  /** One object per x position; series values may be decimal strings (they are only plotted, never added up here). */
  data: Array<Record<string, unknown>>;
  xKey: string;
  xType?: ChartXType;
  series: ChartSeries[];
  valueType?: ChartValueType;
  currency?: string;
  height?: number;
  /** Accessible name: what the chart shows. */
  label: string;
  className?: string;
}

function useMounted() {
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  return mounted;
}

/** Formats values, x ticks and tooltip headings of a chart in the active language. */
function useChartFormat(valueType: ChartValueType, xType: ChartXType, currency?: string) {
  const { locale, formatNumber, formatMoney, formatDate } = useI18n();
  return React.useMemo(() => {
    const dayMonth = new Intl.DateTimeFormat(intlLocale(locale), { day: 'numeric', month: 'short', timeZone: 'UTC' });
    const monthYear = new Intl.DateTimeFormat(intlLocale(locale), { month: 'short', year: '2-digit', timeZone: 'UTC' });
    const asDate = (text: string) => new Date(`${text.length === 7 ? `${text}-01` : text}T12:00:00Z`);
    const valid = (text: unknown): text is string => typeof text === 'string' && /^\d{4}-\d{2}(-\d{2})?$/.test(text);
    return {
      value: (v: unknown) => (valueType === 'money' ? formatMoney(v as string, currency) : valueType === 'percent' ? `${formatNumber(v as number, { maximumFractionDigits: 1 })}%` : formatNumber(v as number, { maximumFractionDigits: 1 })),
      axis: (v: number) => formatNumber(v, { notation: 'compact', maximumFractionDigits: 1 }),
      tick: (x: unknown) => {
        if (xType === 'date' && valid(x)) return dayMonth.format(asDate(x));
        if (xType === 'month' && valid(x)) return monthYear.format(asDate(x));
        const text = String(x ?? '');
        return text.length > 16 ? `${text.slice(0, 15)}…` : text;
      },
      heading: (x: unknown) => (xType === 'date' && valid(x) ? formatDate(x, 'long') : xType === 'month' && valid(x) ? new Intl.DateTimeFormat(intlLocale(locale), { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(asDate(x)) : String(x ?? '')),
    };
  }, [locale, formatNumber, formatMoney, formatDate, valueType, xType, currency]);
}

function LegendKey({ index, type }: { index: number; type: 'line' | 'bar' }) {
  const colour = SERIES_COLOURS[index % SERIES_COLOURS.length];
  return type === 'bar' ? (
    <span aria-hidden="true" className="inline-block size-2.5 rounded-[2px]" style={{ backgroundColor: colour, opacity: index % 2 ? 0.75 : 1 }} />
  ) : (
    <svg aria-hidden="true" width="18" height="8" className="shrink-0">
      <line x1="1" y1="4" x2="17" y2="4" stroke={colour} strokeWidth="2" strokeLinecap="round" strokeDasharray={index % 2 ? '5 4' : undefined} />
    </svg>
  );
}

/** A line or column chart with a hover tooltip and, for two or more series, a legend. */
export function SeriesChart({ type, data, xKey, xType = 'text', series, valueType = 'number', currency, height = 220, label, className }: SeriesChartProps) {
  const { isRtl } = useI18n();
  const mounted = useMounted();
  const format = useChartFormat(valueType, xType, currency);

  // Plotting needs numbers; the strings stay untouched in `data` for the tooltip.
  const rows = React.useMemo(
    () =>
      data.map((row) => {
        const out: Record<string, unknown> = { ...row };
        for (const s of series) {
          const raw = row[s.key];
          out[`__${s.key}`] = raw === null || raw === undefined || raw === '' ? null : Number(raw);
        }
        return out;
      }),
    [data, series],
  );

  const tooltip = ({ active, payload, label: x }: { active?: boolean; payload?: ReadonlyArray<{ payload?: Record<string, unknown> }>; label?: unknown }) => {
    const row = payload?.[0]?.payload;
    if (!active || !row) return null;
    return (
      <div className="rounded-lg border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md">
        <p className="mb-1 font-medium">{format.heading(x)}</p>
        <ul className="space-y-0.5">
          {series.map((s, i) => (
            <li key={s.key} className="flex items-center justify-between gap-4">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <LegendKey index={i} type={type} />
                {s.label}
              </span>
              <span className="tabular font-medium">{row[s.key] === null || row[s.key] === undefined ? '–' : format.value(row[s.key])}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  };

  const axes = (
    <>
      <CartesianGrid stroke={GRID} vertical={false} />
      <XAxis dataKey={xKey} reversed={isRtl} tickFormatter={format.tick} tick={{ fill: AXIS, fontSize: 12 }} tickLine={false} axisLine={{ stroke: GRID }} minTickGap={24} interval="preserveStartEnd" />
      <YAxis orientation={isRtl ? 'right' : 'left'} width={44} tickFormatter={format.axis} tick={{ fill: AXIS, fontSize: 12 }} tickLine={false} axisLine={false} allowDecimals={valueType !== 'number'} />
      <Tooltip content={tooltip} cursor={type === 'bar' ? { fill: 'hsl(var(--muted))', opacity: 0.6 } : { stroke: AXIS, strokeWidth: 1 }} isAnimationActive={false} />
    </>
  );

  return (
    <figure className={cn('min-w-0', className)} aria-label={label}>
      {series.length > 1 ? (
        <ul className="mb-2 flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted-foreground" aria-hidden="true">
          {series.map((s, i) => (
            <li key={s.key} className="flex items-center gap-1.5">
              <LegendKey index={i} type={type} />
              {s.label}
            </li>
          ))}
        </ul>
      ) : null}
      <div dir="ltr" style={{ height }} className="w-full [&_.recharts-surface]:outline-none">
        {!mounted ? (
          <Skeleton className="size-full" />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            {type === 'bar' ? (
              <BarChart data={rows} margin={{ top: 8, right: 4, bottom: 0, left: 4 }} barGap={2} barCategoryGap="20%">
                {axes}
                {series.map((s, i) => (
                  <Bar key={s.key} dataKey={`__${s.key}`} name={s.label} fill={SERIES_COLOURS[i % SERIES_COLOURS.length]} fillOpacity={i % 2 ? 0.75 : 1} radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={false} />
                ))}
              </BarChart>
            ) : (
              <LineChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 4 }}>
                {axes}
                {series.map((s, i) => (
                  <Line
                    key={s.key}
                    dataKey={`__${s.key}`}
                    name={s.label}
                    type="monotone"
                    stroke={SERIES_COLOURS[i % SERIES_COLOURS.length]}
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeDasharray={i % 2 ? '5 4' : undefined}
                    dot={rows.length <= 2 ? { r: 4, strokeWidth: 2, stroke: 'hsl(var(--card))', fill: SERIES_COLOURS[i % SERIES_COLOURS.length] } : false}
                    activeDot={{ r: 5, strokeWidth: 2, stroke: 'hsl(var(--card))' }}
                    connectNulls
                    isAnimationActive={false}
                  />
                ))}
              </LineChart>
            )}
          </ResponsiveContainer>
        )}
      </div>
    </figure>
  );
}

/**
 * Shares of a whole as ranked horizontal bars (what a report offers as a "pie"): readable with
 * many categories, exact values written out, and no need for one colour per slice.
 */
export function ShareBars({ items, label, valueType = 'number', currency }: { items: Array<{ name: string; value: number; display?: string }>; label: string; valueType?: ChartValueType; currency?: string }) {
  const { formatNumber, formatMoney } = useI18n();
  const total = items.reduce((sum, item) => sum + Math.max(0, item.value), 0);
  const max = Math.max(1, ...items.map((item) => item.value));
  const sorted = [...items].sort((a, b) => b.value - a.value);
  return (
    <ul aria-label={label} className="space-y-2.5">
      {sorted.map((item) => (
        <li key={item.name} className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_auto] items-center gap-3 text-sm sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)_auto]">
          <span className="truncate text-foreground" title={item.name} dir="auto">
            {item.name}
          </span>
          <span aria-hidden="true" className="h-2.5 overflow-hidden rounded-full bg-muted">
            <span className="block h-full rounded-full bg-secondary" style={{ width: `${Math.max(item.value > 0 ? 2 : 0, (item.value / max) * 100)}%` }} />
          </span>
          <span className="tabular whitespace-nowrap text-end text-foreground">
            {item.display ?? (valueType === 'money' ? formatMoney(item.value, currency) : formatNumber(item.value, { maximumFractionDigits: 1 }))}
            {total > 0 ? <span className="ms-1.5 text-muted-foreground">{formatNumber((item.value / total) * 100, { maximumFractionDigits: 0 })}%</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
