'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BadgeDollarSign, CheckCircle2, Download, FileText, Pencil, Plus, Settings2, Trash2, Wallet } from 'lucide-react';
import {
  Alert, Badge, Button, Card, Checkbox, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, EmptyState, Input, Label, MoneyInput, PageHeader,
  Select, Skeleton, StatCard, Tabs, TabsContent, TabsList, TabsTrigger, useApiClient, useErrorMessage, useI18n, useSession, useToast,
} from '@typease/ui';

type RunStatus = 'DRAFT' | 'APPROVED' | 'PAID';
interface StaffRow {
  membershipId: string;
  name: string;
  jobTitle: string | null;
  role: string | null;
  pay: { basicSalary: string; housingAllowance: string; transportAllowance: string; otherAllowance: string; payMethod: 'WPS' | 'BANK' | 'CASH'; employeeWpsId: string | null; bankRoutingCode: string | null; ibanMasked: string | null; includeCommission: boolean; isActive: boolean; monthlyTotal: string } | null;
}
interface Line {
  id: string;
  membershipId: string;
  staffName: string;
  jobTitle: string | null;
  payMethod: string;
  daysWorked: number;
  daysInPeriod: number;
  basicSalary: string;
  allowances: string;
  overtime: string;
  commission: string;
  deductions: string;
  deductionNote: string | null;
  gross: string;
  net: string;
}
interface Run {
  id: string;
  runNo: string;
  period: string;
  status: RunStatus;
  currency: string;
  totalGross: string;
  totalDeductions: string;
  totalNet: string;
  paidAt: string | null;
  paymentReference: string | null;
  lines?: Line[];
}
const KEY = ['payroll'] as const;
const TONE: Record<RunStatus, 'neutral' | 'info' | 'success'> = { DRAFT: 'neutral', APPROVED: 'info', PAID: 'success' };

export function Payroll() {
  const { t } = useI18n();
  const session = useSession();
  const manage = session.hasPermission('payroll.manage');
  const [tab, setTab] = React.useState(manage ? 'runs' : 'mine');
  return (
    <>
      <PageHeader title={t('payroll.title')} description={manage ? t('payroll.description') : t('payroll.descriptionOwn')} />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-5">
          {manage ? <TabsTrigger value="runs">{t('payroll.tabs.runs')}</TabsTrigger> : null}
          {manage ? <TabsTrigger value="staff">{t('payroll.tabs.staff')}</TabsTrigger> : null}
          <TabsTrigger value="mine">{t('payroll.tabs.mine')}</TabsTrigger>
          {manage ? <TabsTrigger value="settings">{t('payroll.tabs.settings')}</TabsTrigger> : null}
        </TabsList>
        {manage ? <TabsContent value="runs">{tab === 'runs' ? <Runs /> : null}</TabsContent> : null}
        {manage ? <TabsContent value="staff">{tab === 'staff' ? <StaffPay /> : null}</TabsContent> : null}
        <TabsContent value="mine">{tab === 'mine' ? <MyPayslips /> : null}</TabsContent>
        {manage ? <TabsContent value="settings">{tab === 'settings' ? <Settings /> : null}</TabsContent> : null}
      </Tabs>
    </>
  );
}

function useDownload() {
  const client = useApiClient();
  const toasts = useToast();
  const describe = useErrorMessage();
  return async (path: string, fallback: string, open = false) => {
    try {
      const file = await client.download(path, { fallbackFilename: fallback });
      const url = URL.createObjectURL(file.blob);
      if (open) window.open(url, '_blank', 'noopener');
      else {
        const a = document.createElement('a');
        a.href = url;
        a.download = file.filename;
        a.click();
      }
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (e) {
      toasts.error(describe(e));
    }
  };
}

const monthLabel = (period: string, locale: string) => new Intl.DateTimeFormat(locale === 'ar' ? 'ar-AE-u-nu-latn' : 'en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${period}-01T00:00:00Z`));

// ---------------------------------------------------------------- runs
function Runs() {
  const { t, locale, formatMoney, today } = useI18n();
  const client = useApiClient();
  const queryClient = useQueryClient();
  const describe = useErrorMessage();
  const runs = useQuery({ queryKey: [...KEY, 'runs'], queryFn: () => client.get<Run[]>('/payroll/runs') });
  const [open, setOpen] = React.useState<string | null>(null);
  const [period, setPeriod] = React.useState(today().slice(0, 7));
  const create = useMutation({
    mutationFn: () => client.post<Run>('/payroll/runs', { period }),
    onSuccess: (r) => {
      void queryClient.invalidateQueries({ queryKey: KEY });
      setOpen(r.id);
    },
  });
  const last = runs.data?.[0];
  return (
    <div className="space-y-5">
      <Card className="flex flex-wrap items-end gap-3 p-4">
        <div className="space-y-1.5">
          <Label htmlFor="pr-period">{t('payroll.month')}</Label>
          <Input id="pr-period" type="month" value={period} max={today().slice(0, 7)} onChange={(e) => setPeriod(e.target.value)} className="w-48" />
        </div>
        <Button onClick={() => create.mutate()} loading={create.isPending} disabled={!period}>
          <Plus aria-hidden="true" />
          {t('payroll.prepare')}
        </Button>
        <p className="text-xs text-muted-foreground sm:max-w-md">{t('payroll.prepareHint')}</p>
        {create.error ? <Alert tone="danger" className="w-full">{describe(create.error)}</Alert> : null}
      </Card>
      {last ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <StatCard tone="brand" icon={<Wallet />} label={t('payroll.lastNet', { month: monthLabel(last.period, locale) })} value={formatMoney(last.totalNet, last.currency)} />
          <StatCard tone="neutral" icon={<BadgeDollarSign />} label={t('payroll.gross')} value={formatMoney(last.totalGross, last.currency)} />
          <StatCard tone={last.status === 'PAID' ? 'success' : 'warning'} icon={<CheckCircle2 />} label={t('payroll.status')} value={t(`payroll.statuses.${last.status}`)} />
        </div>
      ) : null}
      {!runs.data ? (
        <Skeleton className="h-40 w-full" />
      ) : runs.data.length === 0 ? (
        <EmptyState icon={<Wallet />} title={t('payroll.empty')} description={t('payroll.emptyText')} />
      ) : (
        <ul className="divide-y rounded-lg border bg-card">
          {runs.data.map((r) => (
            <li key={r.id}>
              <button type="button" onClick={() => setOpen(r.id)} className="flex w-full flex-wrap items-center justify-between gap-3 px-4 py-3 text-start hover:bg-muted/40">
                <span>
                  <span className="block font-medium">{monthLabel(r.period, locale)}</span>
                  <span className="block text-xs text-muted-foreground tabular">{r.runNo}</span>
                </span>
                <span className="flex items-center gap-3">
                  <span className="font-semibold tabular">{formatMoney(r.totalNet, r.currency)}</span>
                  <Badge tone={TONE[r.status]} dot>{t(`payroll.statuses.${r.status}`)}</Badge>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {open ? <RunDialog id={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

function RunDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { t, locale, formatMoney } = useI18n();
  const client = useApiClient();
  const queryClient = useQueryClient();
  const toasts = useToast();
  const describe = useErrorMessage();
  const download = useDownload();
  const run = useQuery({ queryKey: [...KEY, 'run', id], queryFn: () => client.get<Run>(`/payroll/runs/${id}`) });
  const [editing, setEditing] = React.useState<Line | null>(null);
  const [paying, setPaying] = React.useState(false);
  const [reference, setReference] = React.useState('');
  const [paidFrom, setPaidFrom] = React.useState<'BANK' | 'CASH'>('BANK');
  const act = useMutation({
    mutationFn: ({ path, body, method = 'post' }: { path: string; body?: unknown; method?: 'post' | 'delete' }) => (method === 'delete' ? client.delete(`/payroll/runs/${id}`) : client.post<Run>(`/payroll/runs/${id}${path}`, body)),
    onSuccess: (r, v) => {
      void queryClient.invalidateQueries({ queryKey: KEY });
      if (v.method === 'delete') onClose();
      else {
        setPaying(false);
        toasts.success(t(`payroll.done.${v.path.slice(1)}`));
      }
    },
  });
  const r = run.data;
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {r ? monthLabel(r.period, locale) : t('common.loading')}
            {r ? <Badge tone={TONE[r.status]} dot>{t(`payroll.statuses.${r.status}`)}</Badge> : null}
          </DialogTitle>
          <DialogDescription>{r ? `${r.runNo}${r.paymentReference ? ` · ${r.paymentReference}` : ''}` : ''}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {!r?.lines ? (
            <Skeleton className="h-64 w-full" />
          ) : (
            <>
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full text-sm">
                  <caption className="sr-only">{r.runNo}</caption>
                  <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      {(['staff', 'days', 'salary', 'overtime', 'commission', 'deductions', 'net', 'actions'] as const).map((c) => (
                        <th key={c} scope="col" className={`px-3 py-2 font-medium ${['salary', 'overtime', 'commission', 'deductions', 'net'].includes(c) ? 'text-end' : 'text-start'}`}>
                          {c === 'actions' ? <span className="sr-only">{t('payroll.columns.actions')}</span> : t(`payroll.columns.${c}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {r.lines.map((l) => (
                      <tr key={l.id}>
                        <td className="px-3 py-2">
                          <span className="block font-medium">{l.staffName}</span>
                          <span className="block text-xs text-muted-foreground">{t(`payroll.methods.${l.payMethod}`)}</span>
                        </td>
                        <td className="px-3 py-2 tabular">
                          {l.daysWorked}/{l.daysInPeriod}
                        </td>
                        <td className="px-3 py-2 text-end tabular">{formatMoney(Number(l.basicSalary) + Number(l.allowances), r.currency)}</td>
                        <td className="px-3 py-2 text-end tabular">{Number(l.overtime) ? formatMoney(l.overtime, r.currency) : '—'}</td>
                        <td className="px-3 py-2 text-end tabular">{Number(l.commission) ? formatMoney(l.commission, r.currency) : '—'}</td>
                        <td className="px-3 py-2 text-end tabular" title={l.deductionNote ?? undefined}>
                          {Number(l.deductions) ? `− ${formatMoney(l.deductions, r.currency)}` : '—'}
                        </td>
                        <td className="px-3 py-2 text-end font-semibold tabular">{formatMoney(l.net, r.currency)}</td>
                        <td className="px-3 py-2 text-end">
                          <span className="inline-flex gap-1">
                            {r.status === 'DRAFT' ? (
                              <Button size="icon-sm" variant="ghost" aria-label={t('payroll.editLine', { name: l.staffName })} onClick={() => setEditing(l)}>
                                <Pencil aria-hidden="true" />
                              </Button>
                            ) : (
                              <Button size="icon-sm" variant="ghost" aria-label={t('payroll.payslipOf', { name: l.staffName })} onClick={() => void download(`/payroll/payslips/${l.id}/pdf`, 'payslip.pdf', true)}>
                                <FileText aria-hidden="true" />
                              </Button>
                            )}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="border-t bg-muted/30 font-semibold">
                    <tr>
                      <td className="px-3 py-2" colSpan={5}>
                        {t('payroll.total')}
                      </td>
                      <td className="px-3 py-2 text-end tabular">{Number(r.totalDeductions) ? `− ${formatMoney(r.totalDeductions, r.currency)}` : '—'}</td>
                      <td className="px-3 py-2 text-end tabular">{formatMoney(r.totalNet, r.currency)}</td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
              {paying ? (
                <Card className="grid gap-3 p-4 sm:grid-cols-[10rem_1fr_auto] sm:items-end">
                  <div className="space-y-1.5">
                    <Label htmlFor="pr-from">{t('payroll.paidFrom')}</Label>
                    <Select id="pr-from" value={paidFrom} onValueChange={(v) => setPaidFrom(v as 'BANK' | 'CASH')} options={[{ value: 'BANK', label: t('payroll.bank') }, { value: 'CASH', label: t('payroll.cash') }]} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="pr-ref">{t('payroll.reference')}</Label>
                    <Input id="pr-ref" value={reference} onChange={(e) => setReference(e.target.value)} placeholder={t('payroll.referenceHint')} maxLength={120} />
                  </div>
                  <Button disabled={!reference.trim()} loading={act.isPending} onClick={() => act.mutate({ path: '/pay', body: { paidFrom, reference } })}>
                    {t('payroll.confirmPaid')}
                  </Button>
                </Card>
              ) : null}
              {act.error ? <Alert tone="danger">{describe(act.error)}</Alert> : null}
              {r.status === 'DRAFT' ? <p className="text-xs text-muted-foreground">{t('payroll.draftHint')}</p> : null}
            </>
          )}
        </DialogBody>
        {r ? (
          <DialogFooter className="flex-wrap gap-2">
            {r.status !== 'PAID' ? (
              <Button variant="ghost" onClick={() => act.mutate({ path: '', method: 'delete' })}>
                <Trash2 aria-hidden="true" />
                {t('payroll.delete')}
              </Button>
            ) : null}
            {r.status !== 'DRAFT' ? (
              <Button variant="outline" onClick={() => void download(`/payroll/runs/${id}/wps`, `${r.runNo}.SIF`)}>
                <Download aria-hidden="true" />
                {t('payroll.wps')}
              </Button>
            ) : null}
            {r.status === 'DRAFT' ? (
              <Button loading={act.isPending} onClick={() => act.mutate({ path: '/approve' })}>
                <CheckCircle2 aria-hidden="true" />
                {t('payroll.approve')}
              </Button>
            ) : null}
            {r.status === 'APPROVED' && !paying ? (
              <Button onClick={() => setPaying(true)}>
                <Wallet aria-hidden="true" />
                {t('payroll.markPaid')}
              </Button>
            ) : null}
          </DialogFooter>
        ) : null}
        {editing && r ? <LineDialog runId={id} line={editing} currency={r.currency} onClose={() => setEditing(null)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function LineDialog({ runId, line, currency, onClose }: { runId: string; line: Line; currency: string; onClose: () => void }) {
  const { t, formatMoney } = useI18n();
  const client = useApiClient();
  const queryClient = useQueryClient();
  const describe = useErrorMessage();
  const [days, setDays] = React.useState(String(line.daysWorked));
  const [overtime, setOvertime] = React.useState(line.overtime);
  const [deductions, setDeductions] = React.useState(line.deductions);
  const [note, setNote] = React.useState(line.deductionNote ?? '');
  const save = useMutation({
    mutationFn: () => client.patch(`/payroll/runs/${runId}/lines/${line.id}`, { daysWorked: Number(days), overtime: overtime || '0', deductions: deductions || '0', deductionNote: note || null }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: KEY });
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{line.staffName}</DialogTitle>
          <DialogDescription>{t('payroll.lineText', { commission: formatMoney(line.commission, currency) })}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="pl-days">{t('payroll.daysWorked', { total: line.daysInPeriod })}</Label>
            <Input id="pl-days" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, '').slice(0, 2))} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="pl-ot">{t('payroll.columns.overtime')}</Label>
              <MoneyInput id="pl-ot" value={overtime} onChange={setOvertime} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pl-ded">{t('payroll.columns.deductions')}</Label>
              <MoneyInput id="pl-ded" value={deductions} onChange={setDeductions} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pl-note">{t('payroll.deductionNote')}</Label>
            <Input id="pl-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('payroll.deductionHint')} maxLength={300} />
          </div>
          {save.error ? <Alert tone="danger">{describe(save.error)}</Alert> : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={days === ''}>
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- staff pay
function StaffPay() {
  const { t, formatMoney } = useI18n();
  const client = useApiClient();
  const staff = useQuery({ queryKey: [...KEY, 'staff'], queryFn: () => client.get<StaffRow[]>('/payroll/staff') });
  const [editing, setEditing] = React.useState<StaffRow | null>(null);
  return (
    <div className="space-y-4">
      <Alert tone="info">{t('payroll.staffHelp')}</Alert>
      {!staff.data ? (
        <Skeleton className="h-48 w-full" />
      ) : (
        <ul className="divide-y rounded-lg border bg-card">
          {staff.data.map((s) => (
            <li key={s.membershipId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <span className="min-w-0">
                <span className="block font-medium">{s.name}</span>
                <span className="block text-xs text-muted-foreground">{[s.jobTitle, s.role].filter(Boolean).join(' · ')}</span>
              </span>
              <span className="flex items-center gap-3">
                {s.pay ? (
                  <>
                    <span className="text-end text-sm">
                      <span className="block font-semibold tabular">{formatMoney(s.pay.monthlyTotal)}</span>
                      <span className="block text-xs text-muted-foreground">
                        {t(`payroll.methods.${s.pay.payMethod}`)}
                        {s.pay.ibanMasked ? ` · ${s.pay.ibanMasked}` : ''}
                      </span>
                    </span>
                    {!s.pay.isActive ? <Badge tone="neutral">{t('payroll.inactive')}</Badge> : null}
                  </>
                ) : (
                  <Badge tone="warning">{t('payroll.notSetUp')}</Badge>
                )}
                <Button size="sm" variant="outline" onClick={() => setEditing(s)}>
                  <Pencil aria-hidden="true" />
                  {t('payroll.editPay')}
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {editing ? <PayDialog row={editing} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

function PayDialog({ row, onClose }: { row: StaffRow; onClose: () => void }) {
  const { t } = useI18n();
  const client = useApiClient();
  const queryClient = useQueryClient();
  const describe = useErrorMessage();
  const p = row.pay;
  const [v, setV] = React.useState({
    basicSalary: p?.basicSalary ?? '',
    housingAllowance: p?.housingAllowance ?? '0',
    transportAllowance: p?.transportAllowance ?? '0',
    otherAllowance: p?.otherAllowance ?? '0',
    payMethod: p?.payMethod ?? 'WPS',
    employeeWpsId: p?.employeeWpsId ?? '',
    bankRoutingCode: p?.bankRoutingCode ?? '',
    iban: '',
    includeCommission: p?.includeCommission ?? true,
    isActive: p?.isActive ?? true,
  });
  const set = (patch: Partial<typeof v>) => setV((x) => ({ ...x, ...patch }));
  const save = useMutation({
    mutationFn: () => client.put(`/payroll/staff/${row.membershipId}`, { ...v, employeeWpsId: v.employeeWpsId || null, bankRoutingCode: v.bankRoutingCode || null, iban: v.iban || undefined }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: KEY });
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{row.name}</DialogTitle>
          <DialogDescription>{t('payroll.payText')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            {(['basicSalary', 'housingAllowance', 'transportAllowance', 'otherAllowance'] as const).map((k) => (
              <div key={k} className="space-y-1.5">
                <Label htmlFor={`pay-${k}`}>{t(`payroll.fields.${k}`)}</Label>
                <MoneyInput id={`pay-${k}`} value={v[k]} onChange={(x) => set({ [k]: x })} />
              </div>
            ))}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pay-method">{t('payroll.fields.payMethod')}</Label>
            <Select id="pay-method" value={v.payMethod} onValueChange={(x) => set({ payMethod: x as 'WPS' | 'BANK' | 'CASH' })} options={(['WPS', 'BANK', 'CASH'] as const).map((m) => ({ value: m, label: t(`payroll.methods.${m}`) }))} />
          </div>
          {v.payMethod !== 'CASH' ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {v.payMethod === 'WPS' ? (
                <>
                  <div className="space-y-1.5">
                    <Label htmlFor="pay-wps">{t('payroll.fields.employeeWpsId')}</Label>
                    <Input id="pay-wps" dir="ltr" inputMode="numeric" value={v.employeeWpsId} onChange={(e) => set({ employeeWpsId: e.target.value.replace(/\D/g, '').slice(0, 14) })} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="pay-routing">{t('payroll.fields.bankRoutingCode')}</Label>
                    <Input id="pay-routing" dir="ltr" inputMode="numeric" value={v.bankRoutingCode} onChange={(e) => set({ bankRoutingCode: e.target.value.replace(/\D/g, '').slice(0, 9) })} />
                  </div>
                </>
              ) : null}
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="pay-iban">{t('payroll.fields.iban')}</Label>
                <Input id="pay-iban" dir="ltr" value={v.iban} onChange={(e) => set({ iban: e.target.value.toUpperCase() })} placeholder={p?.ibanMasked ?? 'AE07 0331 2345 6789 0123 456'} />
                <p className="text-xs text-muted-foreground">{t('payroll.ibanHint')}</p>
              </div>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-6 text-sm">
            <label className="flex items-center gap-2">
              <Checkbox checked={v.includeCommission} onCheckedChange={(x) => set({ includeCommission: x === true })} />
              {t('payroll.fields.includeCommission')}
            </label>
            <label className="flex items-center gap-2">
              <Checkbox checked={v.isActive} onCheckedChange={(x) => set({ isActive: x === true })} />
              {t('payroll.fields.isActive')}
            </label>
          </div>
          {save.error ? <Alert tone="danger">{describe(save.error)}</Alert> : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!v.basicSalary}>
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- own payslips and settings
function MyPayslips() {
  const { t, locale, formatMoney } = useI18n();
  const client = useApiClient();
  const download = useDownload();
  const mine = useQuery({ queryKey: [...KEY, 'mine'], queryFn: () => client.get<Array<{ id: string; period: string; status: RunStatus; currency: string; gross: string; deductions: string; net: string }>>('/payroll/payslips/mine') });
  if (!mine.data) return <Skeleton className="h-32 w-full" />;
  if (!mine.data.length) return <EmptyState icon={<FileText />} title={t('payroll.noPayslips')} description={t('payroll.noPayslipsText')} />;
  return (
    <ul className="divide-y rounded-lg border bg-card">
      {mine.data.map((p) => (
        <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <span>
            <span className="block font-medium">{monthLabel(p.period, locale)}</span>
            <Badge tone={TONE[p.status]} dot>{t(`payroll.statuses.${p.status}`)}</Badge>
          </span>
          <span className="flex items-center gap-3">
            <span className="font-semibold tabular">{formatMoney(p.net, p.currency)}</span>
            <Button size="sm" variant="outline" onClick={() => void download(`/payroll/payslips/${p.id}/pdf`, 'payslip.pdf', true)}>
              <FileText aria-hidden="true" />
              {t('payroll.payslip')}
            </Button>
          </span>
        </li>
      ))}
    </ul>
  );
}

function Settings() {
  const { t } = useI18n();
  const client = useApiClient();
  const queryClient = useQueryClient();
  const toasts = useToast();
  const describe = useErrorMessage();
  const settings = useQuery({ queryKey: [...KEY, 'settings'], queryFn: () => client.get<{ wpsEmployerId: string | null; wpsBankRoutingCode: string | null }>('/payroll/settings') });
  const [v, setV] = React.useState<{ wpsEmployerId: string; wpsBankRoutingCode: string } | null>(null);
  const current = v ?? { wpsEmployerId: settings.data?.wpsEmployerId ?? '', wpsBankRoutingCode: settings.data?.wpsBankRoutingCode ?? '' };
  const save = useMutation({
    mutationFn: () => client.put('/payroll/settings', { wpsEmployerId: current.wpsEmployerId || null, wpsBankRoutingCode: current.wpsBankRoutingCode || null }),
    onSuccess: () => {
      toasts.success(t('form.saved'));
      void queryClient.invalidateQueries({ queryKey: [...KEY, 'settings'] });
    },
  });
  if (!settings.data) return <Skeleton className="h-32 w-full" />;
  return (
    <Card className="max-w-xl space-y-4 p-5">
      <h2 className="flex items-center gap-2 font-semibold">
        <Settings2 aria-hidden="true" className="size-4" />
        {t('payroll.wpsSettings')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('payroll.wpsSettingsText')}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="wps-employer">{t('payroll.fields.wpsEmployerId')}</Label>
          <Input id="wps-employer" dir="ltr" inputMode="numeric" value={current.wpsEmployerId} onChange={(e) => setV({ ...current, wpsEmployerId: e.target.value.replace(/\D/g, '').slice(0, 13) })} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="wps-bank">{t('payroll.fields.wpsBankRoutingCode')}</Label>
          <Input id="wps-bank" dir="ltr" inputMode="numeric" value={current.wpsBankRoutingCode} onChange={(e) => setV({ ...current, wpsBankRoutingCode: e.target.value.replace(/\D/g, '').slice(0, 9) })} />
        </div>
      </div>
      {save.error ? <Alert tone="danger">{describe(save.error)}</Alert> : null}
      <Button onClick={() => save.mutate()} loading={save.isPending}>
        {t('common.save')}
      </Button>
    </Card>
  );
}
