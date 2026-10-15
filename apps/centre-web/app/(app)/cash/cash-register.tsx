'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Banknote, CheckCircle2, CreditCard, Lock, Printer, Receipt, Unlock, Wallet } from 'lucide-react';
import type { Page } from '@typease/types';
import {
  Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, DatePicker, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader,
  DialogTitle, EmptyState, Input, Label, MoneyInput, PageHeader, Select, Skeleton, StatCard, Switch, Tabs, TabsContent, TabsList, TabsTrigger, Textarea, cn, useApiClient,
  useErrorMessage, useI18n, useSession, useToast,
} from '@typease/ui';
import { useBranch, useBranches } from '@/components/branch';

// ---------------------------------------------------------------- types (GET /cash/...)
interface Tally {
  byMethod: Record<string, string>;
  paymentCount: number;
  cashIn: string;
  cashRefunds: string;
  cashExpenses: string;
  expectedCash: string;
  expectedCard: string;
}
interface Shift {
  id: string;
  shiftNo: string;
  status: 'OPEN' | 'CLOSED' | 'REVIEWED';
  currency: string;
  branch: { id: string; name: string; nameAr: string | null };
  openedById: string;
  openedByName: string;
  openedAt: string;
  openingFloat: string;
  closedAt: string | null;
  tally: Tally | null;
  countedCash: string | null;
  countedCard: string | null;
  cashVariance: string | null;
  cardVariance: string | null;
  closingNote: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  version: number;
  flagged?: boolean;
}
interface ShiftDetail extends Shift {
  payments: Array<{ id: string; paymentNo: string; receiptNo: string | null; method: string; amount: string; receivedAt: string; customer: { fullName: string } | null }>;
  refunds: Array<{ id: string; refundNo: string; amount: string; processedAt: string | null }>;
  expenses: Array<{ id: string; description: string; amount: string; createdAt: string }>;
}
interface DayEnd {
  date: string;
  currency: string;
  collections: { byMethod: Record<string, string>; total: string; count: number };
  refunds: { total: string; cash: string; count: number };
  expenses: { total: string; cash: string; count: number };
  outsideShifts: { total: string; counter: string; online: string; count: number };
  shifts: Shift[];
  variance: { cash: string; card: string; openShifts: number; unreviewed: number };
}
interface CashSettings {
  requireShiftForCash: boolean;
  cashVarianceTolerance: string;
}

const DENOMINATIONS = ['1000', '500', '200', '100', '50', '20', '10', '5', '1', '0.5', '0.25'] as const;
const METHODS = ['CASH', 'CARD_POS', 'BANK_TRANSFER', 'CHEQUE', 'ONLINE_GATEWAY'] as const;
const KEYS = { current: ['cash', 'current'] as const, shifts: ['cash', 'shifts'] as const, dayEnd: ['cash', 'day-end'] as const, settings: ['cash', 'settings'] as const };

/** Money with two decimals, exact for the amounts a till holds (fils are integers). */
const cents = (v: string | number | null | undefined) => Math.round(Number(v ?? 0) * 100);
const asMoney = (c: number) => (c / 100).toFixed(2);

function VarianceBadge({ value, currency }: { value: string | null; currency: string }) {
  const { t, formatMoney } = useI18n();
  if (value === null) return <span className="text-muted-foreground">-</span>;
  const c = cents(value);
  if (c === 0) return <Badge tone="success">{t('cash.balanced')}</Badge>;
  return <Badge tone={c < 0 ? 'danger' : 'warning'}>{`${c > 0 ? '+' : ''}${formatMoney(value, currency)} ${c < 0 ? t('cash.short') : t('cash.over')}`}</Badge>;
}

function StatusBadge({ status }: { status: Shift['status'] }) {
  const { t } = useI18n();
  return <Badge tone={status === 'OPEN' ? 'info' : status === 'CLOSED' ? 'warning' : 'success'} dot>{t(`cash.status.${status}`)}</Badge>;
}

export function CashRegister() {
  const { t } = useI18n();
  const session = useSession();
  const manage = session.hasPermission('cash.manage');
  const [tab, setTab] = React.useState('mine');
  return (
    <>
      <PageHeader title={t('cash.title')} description={t('cash.description')} />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-5">
          <TabsTrigger value="mine">{t('cash.tabs.mine')}</TabsTrigger>
          {manage ? <TabsTrigger value="shifts">{t('cash.tabs.shifts')}</TabsTrigger> : null}
          {manage ? <TabsTrigger value="day-end">{t('cash.tabs.dayEnd')}</TabsTrigger> : null}
        </TabsList>
        <TabsContent value="mine">
          <MyShift />
        </TabsContent>
        {manage ? (
          <TabsContent value="shifts">
            <ShiftList />
          </TabsContent>
        ) : null}
        {manage ? (
          <TabsContent value="day-end">
            <DayEndReport />
          </TabsContent>
        ) : null}
      </Tabs>
    </>
  );
}

// ---------------------------------------------------------------- my shift
function MyShift() {
  const { t, formatMoney, formatDateTime, pick } = useI18n();
  const client = useApiClient();
  // No open shift comes back as an empty body: keep it as null (React Query refuses undefined).
  const current = useQuery({ queryKey: KEYS.current, queryFn: async () => (await client.get<Shift | null>('/cash/shifts/current')) ?? null, refetchInterval: 30_000 });
  const [closing, setClosing] = React.useState(false);
  const [result, setResult] = React.useState<Shift | null>(null);

  if (current.isLoading) return <Skeleton className="h-48 w-full" />;
  const shift = current.data && 'id' in current.data ? current.data : null;

  if (!shift) {
    return (
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <OpenShiftCard />
        {result ? <ClosedResult shift={result} onDismiss={() => setResult(null)} /> : null}
      </div>
    );
  }
  const tally = shift.tally;
  const cur = shift.currency;
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Unlock aria-hidden="true" className="size-5 text-success-text" />
              {t('cash.openShiftTitle', { number: shift.shiftNo })}
            </CardTitle>
            <CardDescription>{t('cash.openedAt', { branch: pick(shift.branch.name, shift.branch.nameAr), time: formatDateTime(shift.openedAt) })}</CardDescription>
          </div>
          <Button variant="accent" onClick={() => setClosing(true)}>
            <Lock aria-hidden="true" />
            {t('cash.closeShift')}
          </Button>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard tone="success" icon={<Wallet />} label={t('cash.expectedCash')} value={formatMoney(tally?.expectedCash, cur)} hint={t('cash.expectedHint')} />
            <StatCard tone="info" icon={<Banknote />} label={t('cash.cashTaken')} value={formatMoney(tally?.cashIn, cur)} hint={t('cash.floatHint', { amount: formatMoney(shift.openingFloat, cur) })} />
            <StatCard tone="info" icon={<CreditCard />} label={t('cash.cardTaken')} value={formatMoney(tally?.expectedCard, cur)} />
            <StatCard tone="neutral" icon={<Receipt />} label={t('cash.payments')} value={String(tally?.paymentCount ?? 0)} />
          </div>
          {tally && (cents(tally.cashRefunds) > 0 || cents(tally.cashExpenses) > 0) ? (
            <p className="mt-3 text-sm text-muted-foreground">{t('cash.outflows', { refunds: formatMoney(tally.cashRefunds, cur), expenses: formatMoney(tally.cashExpenses, cur) })}</p>
          ) : null}
        </CardContent>
      </Card>
      {closing ? (
        <CloseShiftDialog
          shift={shift}
          onClose={() => setClosing(false)}
          onClosed={(closed) => {
            setClosing(false);
            setResult(closed);
          }}
        />
      ) : null}
    </div>
  );
}

function OpenShiftCard() {
  const { t, pick } = useI18n();
  const client = useApiClient();
  const queryClient = useQueryClient();
  const toasts = useToast();
  const describe = useErrorMessage();
  const branches = useBranches();
  const { branchId: preferred } = useBranch();
  const [branchId, setBranchId] = React.useState<string | undefined>(preferred);
  const [float, setFloat] = React.useState('0.00');
  const [note, setNote] = React.useState('');
  const chosen = branchId ?? preferred ?? branches.data?.[0]?.id;
  const open = useMutation({
    mutationFn: () => client.post<Shift>('/cash/shifts', { branchId: chosen, openingFloat: float || '0', note: note || undefined }),
    onSuccess: (shift) => {
      toasts.success(t('cash.opened', { number: shift.shiftNo }));
      void queryClient.invalidateQueries({ queryKey: ['cash'] });
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Wallet aria-hidden="true" className="size-5 text-secondary-text" />
          {t('cash.noShiftTitle')}
        </CardTitle>
        <CardDescription>{t('cash.noShiftText')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {branches.data && branches.data.length > 1 ? (
          <div className="space-y-1.5">
            <Label htmlFor="cash-branch">{t('cash.branch')}</Label>
            <Select id="cash-branch" value={chosen} onValueChange={setBranchId} options={branches.data.map((b) => ({ value: b.id, label: pick(b.name, b.nameAr) }))} />
          </div>
        ) : null}
        <div className="space-y-1.5">
          <Label htmlFor="cash-float">{t('cash.openingFloat')}</Label>
          <MoneyInput id="cash-float" value={float} onChange={setFloat} className="max-w-[12rem]" />
          <p className="text-sm text-muted-foreground">{t('cash.openingFloatHint')}</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cash-note">{t('cash.note')}</Label>
          <Input id="cash-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
        </div>
        {open.error ? <Alert tone="danger">{describe(open.error)}</Alert> : null}
        <Button onClick={() => open.mutate()} loading={open.isPending} disabled={!chosen}>
          <Unlock aria-hidden="true" />
          {t('cash.openShift')}
        </Button>
      </CardContent>
    </Card>
  );
}

function ClosedResult({ shift, onDismiss }: { shift: Shift; onDismiss: () => void }) {
  const { t, formatMoney } = useI18n();
  const short = cents(shift.cashVariance) !== 0;
  return (
    <Card className={cn(short ? 'border-warning/50' : 'border-success/50')}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {short ? <AlertTriangle aria-hidden="true" className="size-5 text-warning-text" /> : <CheckCircle2 aria-hidden="true" className="size-5 text-success-text" />}
          {t('cash.closedTitle', { number: shift.shiftNo })}
        </CardTitle>
        <CardDescription>{shift.flagged ? t('cash.flaggedText') : t('cash.closedText')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <Row label={t('cash.expectedCash')} value={formatMoney(shift.tally?.expectedCash, shift.currency)} />
        <Row label={t('cash.countedCash')} value={formatMoney(shift.countedCash, shift.currency)} />
        <Row label={t('cash.difference')} value={<VarianceBadge value={shift.cashVariance} currency={shift.currency} />} />
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          {t('common.close')}
        </Button>
      </CardContent>
    </Card>
  );
}

function Row({ label, value, strong }: { label: string; value: React.ReactNode; strong?: boolean }) {
  return (
    <div className={cn('flex items-center justify-between gap-4', strong && 'font-semibold')}>
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular">{value}</span>
    </div>
  );
}

/** The count: notes and coins, card slip, and the difference shown live before anything is sent. */
function CloseShiftDialog({ shift, onClose, onClosed }: { shift: Shift; onClose: () => void; onClosed: (shift: Shift) => void }) {
  const { t, formatMoney } = useI18n();
  const client = useApiClient();
  const queryClient = useQueryClient();
  const describe = useErrorMessage();
  const [counts, setCounts] = React.useState<Record<string, string>>({});
  const [card, setCard] = React.useState('');
  const [note, setNote] = React.useState('');
  const total = DENOMINATIONS.reduce((acc, face) => acc + cents(face) * (Number.parseInt(counts[face] ?? '', 10) || 0), 0);
  const expected = cents(shift.tally?.expectedCash);
  const diff = total - expected;
  const close = useMutation({
    mutationFn: () => {
      const denominations = Object.fromEntries(DENOMINATIONS.filter((d) => (Number.parseInt(counts[d] ?? '', 10) || 0) > 0).map((d) => [d, Number.parseInt(counts[d]!, 10)]));
      return client.post<Shift>(`/cash/shifts/${shift.id}/close`, {
        countedCash: asMoney(total),
        countedCard: card ? card : undefined,
        denominations,
        note: note || undefined,
        version: shift.version,
      });
    },
    onSuccess: (closed) => {
      void queryClient.invalidateQueries({ queryKey: ['cash'] });
      onClosed(closed);
    },
  });
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{t('cash.closeTitle', { number: shift.shiftNo })}</DialogTitle>
          <DialogDescription>{t('cash.closeText')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-5">
          <fieldset>
            <legend className="mb-2 text-sm font-medium">{t('cash.countNotes', { currency: shift.currency })}</legend>
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
              {DENOMINATIONS.map((face) => (
                <div key={face} className="flex items-center gap-2">
                  <Label htmlFor={`d-${face}`} className="w-14 shrink-0 text-end tabular">
                    {face}
                  </Label>
                  <span aria-hidden="true" className="text-muted-foreground">×</span>
                  <Input
                    id={`d-${face}`}
                    inputMode="numeric"
                    className="tabular"
                    value={counts[face] ?? ''}
                    onChange={(e) => setCounts((c) => ({ ...c, [face]: e.target.value.replace(/\D/g, '').slice(0, 6) }))}
                    aria-label={t('cash.countOf', { face })}
                  />
                </div>
              ))}
            </div>
          </fieldset>
          <div className="space-y-1.5">
            <Label htmlFor="card-slip">{t('cash.cardSlip')}</Label>
            <MoneyInput id="card-slip" value={card} onChange={setCard} className="max-w-[12rem]" />
            <p className="text-sm text-muted-foreground">{t('cash.cardSlipHint', { amount: formatMoney(shift.tally?.expectedCard, shift.currency) })}</p>
          </div>
          <div className="rounded-lg border bg-muted/40 p-4 text-sm">
            <Row label={t('cash.expectedCash')} value={formatMoney(asMoney(expected), shift.currency)} />
            <Row label={t('cash.countedCash')} value={formatMoney(asMoney(total), shift.currency)} />
            <div className="my-2 border-t" />
            <Row strong label={t('cash.difference')} value={<VarianceBadge value={asMoney(diff)} currency={shift.currency} />} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="close-note">{t('cash.closingNote')}</Label>
            <Textarea id="close-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder={diff !== 0 ? t('cash.closingNoteHint') : undefined} />
          </div>
          {close.error ? <Alert tone="danger">{describe(close.error)}</Alert> : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="accent" onClick={() => close.mutate()} loading={close.isPending}>
            <Lock aria-hidden="true" />
            {t('cash.confirmClose')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- all shifts (managers)
function ShiftList() {
  const { t, formatMoney, formatDateTime, pick } = useI18n();
  const client = useApiClient();
  const [status, setStatus] = React.useState<string>('');
  const [selected, setSelected] = React.useState<string | null>(null);
  const shifts = useQuery({
    queryKey: [...KEYS.shifts, status],
    queryFn: () => client.get<Page<Shift>>('/cash/shifts', { query: { pageSize: 50, ...(status ? { status } : {}) } }),
  });
  const rows = shifts.data?.data ?? [];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Label htmlFor="shift-status" className="sr-only">
          {t('cash.filterStatus')}
        </Label>
        <Select
          id="shift-status"
          value={status || 'ALL'}
          onValueChange={(v) => setStatus(v === 'ALL' ? '' : v)}
          className="w-48"
          options={[{ value: 'ALL', label: t('cash.allShifts') }, ...(['OPEN', 'CLOSED', 'REVIEWED'] as const).map((s) => ({ value: s, label: t(`cash.status.${s}`) }))]}
        />
      </div>
      {shifts.isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : rows.length === 0 ? (
        <EmptyState icon={<Wallet />} title={t('cash.noShifts')} description={t('cash.noShiftsText')} />
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full text-sm">
            <caption className="sr-only">{t('cash.tabs.shifts')}</caption>
            <thead className="bg-muted/50 text-start text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                {['shift', 'cashier', 'branch', 'opened', 'expected', 'counted', 'difference', 'status'].map((c) => (
                  <th key={c} scope="col" className="px-3 py-2.5 text-start font-medium">
                    {t(`cash.columns.${c}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((s) => (
                <tr key={s.id} className="cursor-pointer hover:bg-muted/40" onClick={() => setSelected(s.id)}>
                  <td className="px-3 py-2.5 font-medium tabular">
                    <button type="button" className="hover:underline" onClick={() => setSelected(s.id)}>
                      {s.shiftNo}
                    </button>
                  </td>
                  <td className="px-3 py-2.5">{s.openedByName}</td>
                  <td className="px-3 py-2.5">{pick(s.branch.name, s.branch.nameAr)}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 tabular">{formatDateTime(s.openedAt)}</td>
                  <td className="px-3 py-2.5 tabular">{formatMoney(s.tally?.expectedCash, s.currency)}</td>
                  <td className="px-3 py-2.5 tabular">{s.countedCash === null ? '-' : formatMoney(s.countedCash, s.currency)}</td>
                  <td className="px-3 py-2.5">
                    <VarianceBadge value={s.cashVariance} currency={s.currency} />
                  </td>
                  <td className="px-3 py-2.5">
                    <StatusBadge status={s.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {selected ? <ShiftDetailDialog id={selected} onClose={() => setSelected(null)} /> : null}
    </div>
  );
}

function ShiftDetailDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { t, formatMoney, formatDateTime, pick } = useI18n();
  const client = useApiClient();
  const session = useSession();
  const queryClient = useQueryClient();
  const toasts = useToast();
  const describe = useErrorMessage();
  const [note, setNote] = React.useState('');
  const detail = useQuery({ queryKey: [...KEYS.shifts, 'detail', id], queryFn: () => client.get<ShiftDetail>(`/cash/shifts/${id}`) });
  const review = useMutation({
    mutationFn: () => client.post<Shift>(`/cash/shifts/${id}/review`, { note: note || undefined }),
    onSuccess: (s) => {
      toasts.success(t('cash.reviewed', { number: s.shiftNo }));
      void queryClient.invalidateQueries({ queryKey: ['cash'] });
      onClose();
    },
  });
  const s = detail.data;
  const canReview = s?.status === 'CLOSED' && (s.openedById !== session.user?.id || session.membership?.roleKey === 'owner');
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{s ? t('cash.detailTitle', { number: s.shiftNo, name: s.openedByName }) : t('common.loading')}</DialogTitle>
          {s ? <DialogDescription>{`${pick(s.branch.name, s.branch.nameAr)} · ${formatDateTime(s.openedAt)}${s.closedAt ? ` → ${formatDateTime(s.closedAt)}` : ''}`}</DialogDescription> : null}
        </DialogHeader>
        <DialogBody className="space-y-5">
          {!s ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <>
              <div className="grid gap-x-8 gap-y-1.5 text-sm sm:grid-cols-2">
                <Row label={t('cash.openingFloat')} value={formatMoney(s.openingFloat, s.currency)} />
                <Row label={t('cash.cashTaken')} value={formatMoney(s.tally?.cashIn, s.currency)} />
                <Row label={t('cash.cashRefunds')} value={formatMoney(s.tally?.cashRefunds, s.currency)} />
                <Row label={t('cash.cashExpenses')} value={formatMoney(s.tally?.cashExpenses, s.currency)} />
                <Row strong label={t('cash.expectedCash')} value={formatMoney(s.tally?.expectedCash, s.currency)} />
                <Row strong label={t('cash.countedCash')} value={s.countedCash === null ? '-' : formatMoney(s.countedCash, s.currency)} />
                <Row label={t('cash.difference')} value={<VarianceBadge value={s.cashVariance} currency={s.currency} />} />
                <Row label={t('cash.cardDifference')} value={<VarianceBadge value={s.cardVariance} currency={s.currency} />} />
              </div>
              {s.closingNote ? <Alert tone="info" title={t('cash.closingNote')}>{s.closingNote}</Alert> : null}
              {s.reviewNote ? <Alert tone="success" title={t('cash.reviewNote')}>{s.reviewNote}</Alert> : null}
              <div>
                <h3 className="mb-2 text-sm font-semibold">{t('cash.paymentsIn', { count: s.payments.length })}</h3>
                <ul className="divide-y rounded-lg border text-sm">
                  {s.payments.map((p) => (
                    <li key={p.id} className="flex items-center justify-between gap-3 px-3 py-2">
                      <span className="min-w-0 truncate">
                        <span className="font-medium tabular">{p.receiptNo ?? p.paymentNo}</span>
                        <span className="text-muted-foreground"> · {p.customer?.fullName ?? '-'} · {t(`cash.methods.${p.method}`)}</span>
                      </span>
                      <span className="tabular">{formatMoney(p.amount, s.currency)}</span>
                    </li>
                  ))}
                  {s.payments.length === 0 ? <li className="px-3 py-2 text-muted-foreground">{t('cash.nothing')}</li> : null}
                </ul>
              </div>
              {canReview ? (
                <div className="space-y-1.5">
                  <Label htmlFor="review-note">{t('cash.reviewNote')}</Label>
                  <Textarea id="review-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
                </div>
              ) : null}
              {review.error ? <Alert tone="danger">{describe(review.error)}</Alert> : null}
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('common.close')}
          </Button>
          {canReview ? (
            <Button onClick={() => review.mutate()} loading={review.isPending}>
              <CheckCircle2 aria-hidden="true" />
              {t('cash.markReviewed')}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- day-end (managers)
function DayEndReport() {
  const { t, formatMoney, pick, today } = useI18n();
  const client = useApiClient();
  const session = useSession();
  const branches = useBranches();
  const { branchId: preferred } = useBranch();
  const [date, setDate] = React.useState(today());
  const [branchId, setBranchId] = React.useState<string>(preferred ?? 'ALL');
  const report = useQuery({
    queryKey: [...KEYS.dayEnd, date, branchId],
    queryFn: () => client.get<DayEnd>('/cash/day-end', { query: { date, ...(branchId !== 'ALL' ? { branchId } : {}) } }),
    enabled: !!date,
  });
  const r = report.data;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-3 print:hidden">
        <div className="space-y-1.5">
          <Label htmlFor="day-end-date">{t('cash.date')}</Label>
          <DatePicker id="day-end-date" value={date} onChange={setDate} max={today()} />
        </div>
        {branches.data && branches.data.length > 1 ? (
          <div className="space-y-1.5">
            <Label htmlFor="day-end-branch">{t('cash.branch')}</Label>
            <Select id="day-end-branch" value={branchId} onValueChange={setBranchId} className="w-56" options={[{ value: 'ALL', label: t('cash.allBranches') }, ...branches.data.map((b) => ({ value: b.id, label: pick(b.name, b.nameAr) }))]} />
          </div>
        ) : null}
        <Button variant="outline" onClick={() => window.print()} disabled={!r}>
          <Printer aria-hidden="true" />
          {t('cash.print')}
        </Button>
      </div>
      {!r ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <>
          <h2 className="hidden text-lg font-semibold print:block">{t('cash.dayEndPrintTitle', { date: r.date })}</h2>
          {r.variance.openShifts > 0 || r.variance.unreviewed > 0 ? (
            <Alert tone="warning" title={t('cash.attention')}>
              {t('cash.attentionText', { open: r.variance.openShifts, unreviewed: r.variance.unreviewed })}
            </Alert>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard tone="success" icon={<Wallet />} label={t('cash.collected')} value={formatMoney(r.collections.total, r.currency)} hint={t('cash.paymentsCount', { count: r.collections.count })} />
            <StatCard tone="danger" icon={<Banknote />} label={t('cash.refundsOut')} value={formatMoney(r.refunds.total, r.currency)} hint={t('cash.ofWhichCash', { amount: formatMoney(r.refunds.cash, r.currency) })} />
            <StatCard tone="warning" icon={<Receipt />} label={t('cash.expensesOut')} value={formatMoney(r.expenses.total, r.currency)} hint={t('cash.ofWhichCash', { amount: formatMoney(r.expenses.cash, r.currency) })} />
            <StatCard tone={cents(r.variance.cash) === 0 ? 'success' : 'danger'} icon={<AlertTriangle />} label={t('cash.totalDifference')} value={formatMoney(r.variance.cash, r.currency)} />
          </div>
          <div className="grid gap-5 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>{t('cash.byMethod')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {METHODS.map((m) => (
                  <Row key={m} label={t(`cash.methods.${m}`)} value={formatMoney(r.collections.byMethod[m], r.currency)} />
                ))}
                <div className="border-t pt-2">
                  <Row strong label={t('cash.total')} value={formatMoney(r.collections.total, r.currency)} />
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>{t('cash.outsideShifts')}</CardTitle>
                <CardDescription>{t('cash.outsideShiftsText')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <Row label={t('cash.counterOutside')} value={formatMoney(r.outsideShifts.counter, r.currency)} />
                <Row label={t('cash.methods.ONLINE_GATEWAY')} value={formatMoney(r.outsideShifts.online, r.currency)} />
              </CardContent>
            </Card>
          </div>
          <Card>
            <CardHeader>
              <CardTitle>{t('cash.tabs.shifts')}</CardTitle>
            </CardHeader>
            <CardContent>
              {r.shifts.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('cash.noShiftsDay')}</p>
              ) : (
                <ul className="divide-y text-sm">
                  {r.shifts.map((s) => (
                    <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                      <span>
                        <span className="font-medium tabular">{s.shiftNo}</span> <span className="text-muted-foreground">· {s.openedByName}</span>
                      </span>
                      <span className="flex items-center gap-3">
                        <span className="tabular text-muted-foreground">
                          {formatMoney(s.tally?.expectedCash, s.currency)} → {s.countedCash === null ? '…' : formatMoney(s.countedCash, s.currency)}
                        </span>
                        <VarianceBadge value={s.cashVariance} currency={s.currency} />
                        <StatusBadge status={s.status} />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
          {session.hasPermission('finance.settings') ? <CashSettingsCard /> : null}
        </>
      )}
    </div>
  );
}

function CashSettingsCard() {
  const { t } = useI18n();
  const client = useApiClient();
  const queryClient = useQueryClient();
  const toasts = useToast();
  const describe = useErrorMessage();
  const settings = useQuery({ queryKey: KEYS.settings, queryFn: () => client.get<CashSettings>('/cash/settings') });
  const [tolerance, setTolerance] = React.useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: Partial<CashSettings>) => client.put<CashSettings>('/cash/settings', body),
    onSuccess: (next) => {
      queryClient.setQueryData(KEYS.settings, next);
      setTolerance(null);
      toasts.success(t('form.saved'));
    },
  });
  if (!settings.data) return null;
  return (
    <Card className="print:hidden">
      <CardHeader>
        <CardTitle>{t('cash.settingsTitle')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <Label htmlFor="require-shift">{t('cash.requireShift')}</Label>
            <p className="text-sm text-muted-foreground">{t('cash.requireShiftHint')}</p>
          </div>
          <Switch id="require-shift" checked={settings.data.requireShiftForCash} onCheckedChange={(v) => save.mutate({ requireShiftForCash: v })} />
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="tolerance">{t('cash.tolerance')}</Label>
            <MoneyInput id="tolerance" value={tolerance ?? settings.data.cashVarianceTolerance} onChange={setTolerance} className="w-40" />
          </div>
          <Button variant="outline" disabled={tolerance === null} loading={save.isPending} onClick={() => tolerance !== null && save.mutate({ cashVarianceTolerance: tolerance })}>
            {t('common.save')}
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">{t('cash.toleranceHint')}</p>
        {save.error ? <Alert tone="danger">{describe(save.error)}</Alert> : null}
      </CardContent>
    </Card>
  );
}
