'use client';

import * as React from 'react';
import { RELATIVE_RANGES } from '@typease/validation';
import { DatePicker, Input, Label, Select, useI18n } from '@typease/ui';
import { useBranches } from '@/components/branch';
import type { ReportDefinition, ReportParameter, ReportRow } from './types';

export type ReportParams = Record<string, string>;

const PERIOD_KEYS = new Set(['from', 'to', 'range']);
const ALL = '__all__';

/** Report parameters kept in the URL, so a filtered report can be bookmarked, shared and reloaded. */
export function useUrlReportParams(allowed: readonly string[]) {
  const [params, setParams] = React.useState<ReportParams>({});
  const [ready, setReady] = React.useState(false);
  const allowedKey = allowed.join(',');
  React.useEffect(() => {
    const read = () => {
      const search = new URLSearchParams(window.location.search);
      const next: ReportParams = {};
      for (const key of allowedKey.split(',').filter(Boolean)) {
        const value = search.get(key);
        if (value) next[key] = value;
      }
      setParams(next);
    };
    read();
    setReady(true);
    window.addEventListener('popstate', read);
    return () => window.removeEventListener('popstate', read);
  }, [allowedKey]);
  const update = React.useCallback((next: ReportParams) => {
    setParams(next);
    const url = new URL(window.location.href);
    url.search = new URLSearchParams(next).toString();
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}`);
  }, []);
  return { params, update, ready };
}

/** The parameters a person sets on the report itself (not the ones a drill-down adds). */
export const reportFilterKeys = (definition: ReportDefinition | undefined) => [...(definition?.parameters ?? []).filter((p) => !p.drilldownOnly).map((p) => p.key), '__custom'];

/**
 * Drill-down parameters a row determines: the row's own value for the parameter
 * (`date`, `serviceId`, `customerId` ...) or its key / value twin (`statusKey`, `ratingValue`).
 */
export function drilldownParamsOfRow(definition: ReportDefinition, row: ReportRow): ReportParams {
  const out: ReportParams = {};
  for (const p of definition.parameters) {
    if (!p.drilldownOnly) continue;
    const value = row[p.key] ?? row[`${p.key}Key`] ?? row[`${p.key}Value`];
    if (value !== null && value !== undefined && value !== '') out[p.key] = String(value);
  }
  return out;
}

/**
 * The parameter form of a report, built from the report's definition: period (relative
 * presets or two dates), branch and the report's own filters. Changes apply immediately.
 */
export function ReportFilters({ definition, params, onChange }: { definition: ReportDefinition; params: ReportParams; onChange: (next: ReportParams) => void }) {
  const { t, pick, today } = useI18n();
  const branches = useBranches();
  const id = React.useId();
  const parameters = definition.parameters.filter((p) => !p.drilldownOnly);
  const hasPeriod = parameters.some((p) => p.key === 'range' || p.key === 'from');
  const others = parameters.filter((p) => !PERIOD_KEYS.has(p.key));

  const preset = params.range ?? (params.from || params.to || params.__custom ? 'custom' : 'default');
  const set = (patch: Record<string, string | undefined>) => {
    const next: ReportParams = { ...params };
    for (const [key, value] of Object.entries(patch)) {
      if (value) next[key] = value;
      else delete next[key];
    }
    onChange(next);
  };

  const field = (p: ReportParameter) => {
    // The API labels its parameters in English; the two every report shares are worded here.
    const text = p.key === 'branchId' ? t('fin.common.branch') : p.key === 'withinDays' ? t('fin.reports.params.withinDays') : p.label;
    if (p.type === 'branch') {
      if (!branches.data || branches.data.length < 2) return null;
      return (
        <div key={p.key} className="w-full space-y-1.5 sm:w-52">
          <Label htmlFor={`${id}-${p.key}`}>{text}</Label>
          <Select
            id={`${id}-${p.key}`}
            value={params[p.key] ?? ALL}
            onValueChange={(v) => set({ [p.key]: v === ALL ? undefined : v })}
            options={[{ value: ALL, label: t('shell.allBranches') }, ...branches.data.map((b) => ({ value: b.id, label: pick(b.name, b.nameAr) }))]}
          />
        </div>
      );
    }
    if (p.type === 'enum' && p.options) {
      return (
        <div key={p.key} className="w-full space-y-1.5 sm:w-52">
          <Label htmlFor={`${id}-${p.key}`}>{text}</Label>
          <Select id={`${id}-${p.key}`} value={params[p.key] ?? ALL} onValueChange={(v) => set({ [p.key]: v === ALL ? undefined : v })} options={[{ value: ALL, label: t('common.all') }, ...p.options.map((o) => ({ value: o, label: o }))]} />
        </div>
      );
    }
    if (p.type === 'number') {
      return (
        <div key={p.key} className="w-full space-y-1.5 sm:w-44">
          <Label htmlFor={`${id}-${p.key}`}>{text}</Label>
          <NumberField id={`${id}-${p.key}`} value={params[p.key] ?? ''} onCommit={(v) => set({ [p.key]: v || undefined })} placeholder={p.key === 'withinDays' ? '30' : undefined} />
        </div>
      );
    }
    return null;
  };

  return (
    <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
      {hasPeriod ? (
        <div className="w-full space-y-1.5 sm:w-56">
          <Label htmlFor={`${id}-period`}>{t('fin.common.period')}</Label>
          <Select
            id={`${id}-period`}
            value={preset}
            onValueChange={(v) => {
              if (v === 'default') set({ range: undefined, from: undefined, to: undefined, __custom: undefined });
              else if (v === 'custom') set({ range: undefined, __custom: '1' });
              else set({ range: v, from: undefined, to: undefined, __custom: undefined });
            }}
            options={[
              { value: 'default', label: t('fin.reports.ranges.default') },
              ...RELATIVE_RANGES.map((r) => ({ value: r, label: t(`fin.reports.ranges.${r}`) })),
              { value: 'custom', label: t('fin.reports.ranges.custom') },
            ]}
          />
        </div>
      ) : null}
      {hasPeriod && preset === 'custom' ? (
        <fieldset className="flex w-full min-w-0 items-end gap-2 sm:w-auto">
          <legend className="sr-only">{t('fin.common.period')}</legend>
          <div className="min-w-0 flex-1 space-y-1.5 sm:w-40 sm:flex-none">
            <Label htmlFor={`${id}-from`}>{t('common.from')}</Label>
            <DatePicker id={`${id}-from`} value={params.from ?? ''} max={params.to || today()} onChange={(from) => set({ from: from || undefined })} className="min-w-0" />
          </div>
          <div className="min-w-0 flex-1 space-y-1.5 sm:w-40 sm:flex-none">
            <Label htmlFor={`${id}-to`}>{t('common.to')}</Label>
            <DatePicker id={`${id}-to`} value={params.to ?? ''} min={params.from || undefined} max={today()} onChange={(to) => set({ to: to || undefined })} className="min-w-0" />
          </div>
        </fieldset>
      ) : null}
      {others.map(field)}
    </div>
  );
}

/** A small number field that applies its value when it is left or Enter is pressed (not on every key). */
function NumberField({ id, value, onCommit, placeholder }: { id: string; value: string; onCommit: (value: string) => void; placeholder?: string }) {
  const [text, setText] = React.useState(value);
  React.useEffect(() => setText(value), [value]);
  const commit = () => {
    const clean = text.replace(/[^\d]/g, '');
    if (clean !== value) onCommit(clean);
  };
  return <Input id={id} inputMode="numeric" dir="ltr" className="tabular" value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />;
}

/** What goes to the API: the URL parameters without the form's own bookkeeping. */
export function toApiParams(params: ReportParams): ReportParams {
  const { __custom: _custom, ...rest } = params;
  return rest;
}
