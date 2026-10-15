'use client';

import * as React from 'react';
import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { CheckCircle2, Download, FileSpreadsheet, TriangleAlert, Upload } from 'lucide-react';
import { Alert, Badge, Button, Checkbox, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, useApi, useErrorMessage, useI18n, useToast } from '@typease/ui';

interface PreviewRow {
  rowNo: number;
  data: Record<string, unknown>;
  errors: Array<{ field: string; message: string }>;
  duplicate: { kind: 'FILE'; rowNo: number } | { kind: 'EXISTING'; customerNo?: string; fullName?: string; code?: string } | null;
}
interface Preview {
  rows: PreviewRow[];
  ignoredColumns?: string[];
  summary: { total: number; valid: number; invalid: number; duplicates: number };
}
interface Result {
  created: number;
  skipped: number;
  failed: Array<{ rowNo: number; code: string; message: string }>;
}

/** "fullName" -> "Full name", "price.serviceFee" -> "Service fee". */
const fieldLabel = (f: string) => {
  const w = (f.split('.').pop() ?? f).replace(/([A-Z])/g, ' $1').toLowerCase().trim();
  return w.charAt(0).toUpperCase() + w.slice(1);
};

/**
 * Bulk import from a CSV or Excel file: download the template, upload, check the preview (nothing is saved yet),
 * import. `base` is `/customers` or `/services`; the API offers `${base}/import/template|preview` and `${base}/import`.
 */
export function ImportDialog({ base, kind, invalidate, onClose }: { base: '/customers' | '/services'; kind: 'customers' | 'services'; invalidate: QueryKey; onClose: () => void }) {
  const { t, tn } = useI18n();
  const api = useApi();
  const queryClient = useQueryClient();
  const toasts = useToast();
  const describe = useErrorMessage();
  const input = React.useRef<HTMLInputElement>(null);
  const [preview, setPreview] = React.useState<Preview | null>(null);
  const [fileName, setFileName] = React.useState<string | null>(null);
  const [skipDuplicates, setSkipDuplicates] = React.useState(true);
  const [result, setResult] = React.useState<Result | null>(null);
  const check = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return api.client.upload<Preview>(`${base}/import/preview`, form);
    },
    onSuccess: setPreview,
  });
  const run = useMutation({
    mutationFn: () => {
      const rows = preview!.rows.filter((r) => !r.errors.length && (!r.duplicate || (kind === 'customers' && !skipDuplicates)));
      return api.client.post<Result>(`${base}/import`, { rows: rows.map((r) => ({ rowNo: r.rowNo, data: r.data })), ...(kind === 'customers' ? { skipDuplicates } : {}) });
    },
    onSuccess: (r) => {
      setResult(r);
      toasts.success(tn(`imports.${kind}.done`, r.created));
      void queryClient.invalidateQueries({ queryKey: invalidate });
    },
  });
  const template = async () => {
    try {
      const file = await api.client.download(`${base}/import/template`, { fallbackFilename: `${kind}-template.csv` });
      const url = URL.createObjectURL(file.blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      toasts.error(describe(e));
    }
  };
  const importable = preview ? preview.rows.filter((r) => !r.errors.length && (!r.duplicate || (kind === 'customers' && !skipDuplicates))).length : 0;
  const label = (r: PreviewRow) => String(r.data.fullName ?? r.data.name ?? r.data.code ?? '—');
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>{t(`imports.${kind}.title`)}</DialogTitle>
          <DialogDescription>{t(`imports.${kind}.text`)}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {result ? (
            <div className="space-y-3">
              <Alert tone="success" title={tn(`imports.${kind}.done`, result.created)}>
                {result.skipped ? tn('imports.skipped', result.skipped) : null}
              </Alert>
              {result.failed.length ? (
                <Alert tone="warning" title={tn('imports.failed', result.failed.length)}>
                  <ul className="mt-1 list-disc ps-5 text-sm">
                    {result.failed.slice(0, 20).map((f) => (
                      <li key={f.rowNo}>{t('imports.rowError', { row: f.rowNo, message: f.message })}</li>
                    ))}
                  </ul>
                </Alert>
              ) : null}
            </div>
          ) : (
            <>
              <ol className="grid gap-3 sm:grid-cols-2">
                <li className="rounded-lg border p-4">
                  <p className="text-sm font-semibold">1. {t('imports.step1')}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{t(`imports.${kind}.columns`)}</p>
                  <Button variant="outline" size="sm" className="mt-3" onClick={() => void template()}>
                    <Download aria-hidden="true" />
                    {t('imports.template')}
                  </Button>
                </li>
                <li className="rounded-lg border p-4">
                  <p className="text-sm font-semibold">2. {t('imports.step2')}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{t('imports.formats')}</p>
                  <input
                    ref={input}
                    type="file"
                    accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                    className="sr-only"
                    aria-label={t('imports.choose')}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      setFileName(file.name);
                      setPreview(null);
                      check.mutate(file);
                    }}
                  />
                  <Button size="sm" className="mt-3" loading={check.isPending} onClick={() => input.current?.click()}>
                    <Upload aria-hidden="true" />
                    {fileName ? t('imports.another') : t('imports.choose')}
                  </Button>
                  {fileName ? (
                    <span className="ms-2 inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <FileSpreadsheet aria-hidden="true" className="size-3.5" />
                      {fileName}
                    </span>
                  ) : null}
                </li>
              </ol>
              {check.error ? <Alert tone="danger">{describe(check.error)}</Alert> : null}
              {preview ? (
                <>
                  <div className="flex flex-wrap gap-2 text-sm">
                    <Badge tone="neutral">{tn('imports.rows', preview.summary.total)}</Badge>
                    <Badge tone="success" dot>{tn('imports.ready', preview.summary.valid)}</Badge>
                    {preview.summary.duplicates ? <Badge tone="warning" dot>{tn('imports.duplicates', preview.summary.duplicates)}</Badge> : null}
                    {preview.summary.invalid ? <Badge tone="danger" dot>{tn('imports.invalid', preview.summary.invalid)}</Badge> : null}
                  </div>
                  {preview.ignoredColumns?.length ? <p className="text-xs text-muted-foreground">{t('imports.ignored', { columns: preview.ignoredColumns.join(', ') })}</p> : null}
                  <div className="max-h-80 overflow-auto rounded-lg border">
                    <table className="w-full text-sm">
                      <caption className="sr-only">{t('imports.previewCaption')}</caption>
                      <thead className="sticky top-0 bg-muted text-xs uppercase tracking-wide text-muted-foreground">
                        <tr>
                          <th scope="col" className="px-3 py-2 text-start font-medium">{t('imports.row')}</th>
                          <th scope="col" className="px-3 py-2 text-start font-medium">{t(`imports.${kind}.item`)}</th>
                          <th scope="col" className="px-3 py-2 text-start font-medium">{t('imports.result')}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {preview.rows.map((r) => (
                          <tr key={r.rowNo} className={r.errors.length ? 'bg-destructive/5' : r.duplicate ? 'bg-warning-soft/40' : ''}>
                            <td className="px-3 py-2 tabular text-muted-foreground">{r.rowNo}</td>
                            <td className="px-3 py-2 font-medium">{label(r)}</td>
                            <td className="px-3 py-2">
                              {r.errors.length ? (
                                <span className="flex items-start gap-1 text-destructive">
                                  <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                                  {r.errors.map((e) => `${e.field ? `${fieldLabel(e.field)}: ` : ''}${e.message}`).join(' · ')}
                                </span>
                              ) : r.duplicate ? (
                                <span className="text-warning-text">
                                  {r.duplicate.kind === 'FILE' ? t('imports.dupFile', { row: r.duplicate.rowNo }) : t('imports.dupExisting', { name: r.duplicate.fullName ?? r.duplicate.code ?? '' })}
                                </span>
                              ) : (
                                <span className="flex items-center gap-1 text-success-text">
                                  <CheckCircle2 aria-hidden="true" className="size-3.5" />
                                  {t('imports.ok')}
                                </span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {kind === 'customers' && preview.summary.duplicates ? (
                    <label className="flex items-start gap-2 text-sm">
                      <Checkbox checked={skipDuplicates} onCheckedChange={(v) => setSkipDuplicates(v === true)} className="mt-0.5" />
                      {t('imports.skipDuplicates')}
                    </label>
                  ) : null}
                </>
              ) : null}
              {run.error ? <Alert tone="danger">{describe(run.error)}</Alert> : null}
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {result ? t('common.close') : t('common.cancel')}
          </Button>
          {!result ? (
            <Button disabled={!importable} loading={run.isPending} onClick={() => run.mutate()}>
              {tn(`imports.${kind}.import`, importable)}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
