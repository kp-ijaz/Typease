'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, History, Landmark, Plus, Scale, TrendingDown, TrendingUp, Undo2, X } from 'lucide-react';
import type { Page } from '@typease/types';
import {
  Alert, Badge, Button, DatePicker, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, EmptyState, Input, Label,
  MoneyInput, PageHeader, Select, Skeleton, StatCard, Tabs, TabsContent, TabsList, TabsTrigger, useApiClient, useErrorMessage, useI18n, useSession, useToast,
} from '@typease/ui';

type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';
const TYPES: AccountType[] = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'];
interface Account {
  id: string;
  code: string;
  name: string;
  nameAr: string | null;
  type: AccountType;
  systemKey: string | null;
  isActive: boolean;
  debit: string;
  credit: string;
  balance: string;
}
interface Row {
  id: string;
  code: string;
  name: string;
  nameAr: string | null;
  amount: string;
}
interface JournalEntry {
  id: string;
  entryNo: string;
  date: string;
  memo: string;
  sourceType: string;
  reversalOfId: string | null;
  lines: Array<{ accountId: string; code: string; name: string; nameAr: string | null; debit: string; credit: string; memo: string | null }>;
}

const KEY = ['accounting'] as const;
const firstOfYear = (ymd: string) => `${ymd.slice(0, 4)}-01-01`;
const nonZero = (v: string) => Number(v) !== 0;

export function Accounting() {
  const { t } = useI18n();
  const session = useSession();
  const manage = session.hasPermission('accounting.manage');
  const [tab, setTab] = React.useState('pl');
  return (
    <>
      <PageHeader title={t('fin.accounting.title')} description={t('fin.accounting.description')} action={manage ? <RebuildButton /> : undefined} />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-5 flex-wrap">
          <TabsTrigger value="pl">{t('fin.accounting.tabs.pl')}</TabsTrigger>
          <TabsTrigger value="bs">{t('fin.accounting.tabs.bs')}</TabsTrigger>
          <TabsTrigger value="tb">{t('fin.accounting.tabs.tb')}</TabsTrigger>
          <TabsTrigger value="vat">{t('fin.accounting.tabs.vat')}</TabsTrigger>
          <TabsTrigger value="journal">{t('fin.accounting.tabs.journal')}</TabsTrigger>
          <TabsTrigger value="accounts">{t('fin.accounting.tabs.accounts')}</TabsTrigger>
        </TabsList>
        <TabsContent value="pl">
          <ProfitAndLoss />
        </TabsContent>
        <TabsContent value="bs">
          <BalanceSheet />
        </TabsContent>
        <TabsContent value="tb">
          <TrialBalance />
        </TabsContent>
        <TabsContent value="vat">
          <VatReport />
        </TabsContent>
        <TabsContent value="journal">
          <Journal manage={manage} />
        </TabsContent>
        <TabsContent value="accounts">
          <Accounts manage={manage} />
        </TabsContent>
      </Tabs>
    </>
  );
}

function RebuildButton() {
  const { t } = useI18n();
  const client = useApiClient();
  const queryClient = useQueryClient();
  const toasts = useToast();
  const rebuild = useMutation({
    mutationFn: () => client.post<{ posted: Record<string, number> }>('/accounting/rebuild'),
    onSuccess: (r) => {
      const n = Object.values(r.posted).reduce((a, b) => a + b, 0);
      toasts.success(n ? t('fin.accounting.rebuilt', { count: n }) : t('fin.accounting.rebuiltNothing'));
      void queryClient.invalidateQueries({ queryKey: KEY });
    },
    onError: (e) => toasts.error(e),
  });
  return (
    <Button variant="outline" onClick={() => rebuild.mutate()} loading={rebuild.isPending} title={t('fin.accounting.rebuildHint')}>
      <History aria-hidden="true" />
      {t('fin.accounting.rebuild')}
    </Button>
  );
}

// ---------------------------------------------------------------- shared bits
function Period({ from, to, setFrom, setTo }: { from: string; to: string; setFrom: (v: string) => void; setTo: (v: string) => void }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="space-y-1.5">
        <Label htmlFor="a-from">{t('fin.accounting.from')}</Label>
        <DatePicker id="a-from" value={from} onChange={setFrom} max={to} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="a-to">{t('fin.accounting.to')}</Label>
        <DatePicker id="a-to" value={to} onChange={setTo} min={from} />
      </div>
    </div>
  );
}
function usePeriod() {
  const { today } = useI18n();
  const [from, setFrom] = React.useState(firstOfYear(today()));
  const [to, setTo] = React.useState(today());
  return { from, to, setFrom, setTo };
}
function AsOf({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useI18n();
  return (
    <div className="space-y-1.5">
      <Label htmlFor="a-asof">{t('fin.accounting.asOf')}</Label>
      <DatePicker id="a-asof" value={value} onChange={onChange} />
    </div>
  );
}

/** A statement section: heading, account lines and its total. */
function Statement({ title, rows, total, totalLabel }: { title: string; rows: Row[]; total: string; totalLabel: string }) {
  const { t, pick, formatMoney } = useI18n();
  return (
    <section className="overflow-hidden rounded-lg border bg-card">
      <h3 className="border-b bg-muted/50 px-4 py-2.5 text-sm font-semibold">{title}</h3>
      {rows.length ? (
        <ul className="divide-y text-sm">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-2">
              <span className="min-w-0">
                <span className="me-2 text-xs text-muted-foreground tabular">{r.code}</span>
                {pick(r.name, r.nameAr)}
              </span>
              <span className="tabular">{formatMoney(r.amount)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-4 py-3 text-sm text-muted-foreground">{t('fin.accounting.nothing')}</p>
      )}
      <div className="flex items-center justify-between border-t bg-muted/30 px-4 py-2.5 text-sm font-semibold">
        <span>{totalLabel}</span>
        <span className="tabular">{formatMoney(total)}</span>
      </div>
    </section>
  );
}

function Balanced({ ok }: { ok: boolean }) {
  const { t } = useI18n();
  return ok ? <Badge tone="success" dot>{t('fin.accounting.balanced')}</Badge> : <Badge tone="danger" dot>{t('fin.accounting.notBalanced')}</Badge>;
}

// ---------------------------------------------------------------- statements
function ProfitAndLoss() {
  const { t, formatMoney } = useI18n();
  const client = useApiClient();
  const p = usePeriod();
  const pl = useQuery({
    queryKey: [...KEY, 'pl', p.from, p.to],
    queryFn: () => client.get<{ revenue: Row[]; expenses: Row[]; totalRevenue: string; totalExpenses: string; netProfit: string }>('/accounting/reports/profit-and-loss', { query: { from: p.from, to: p.to } }),
    enabled: !!p.from && !!p.to,
    refetchOnMount: 'always',
  });
  const d = pl.data;
  return (
    <div className="space-y-5">
      <Period {...p} />
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard tone="success" icon={<TrendingUp />} label={t('fin.accounting.revenue')} value={formatMoney(d?.totalRevenue)} loading={!d} />
        <StatCard tone="warning" icon={<TrendingDown />} label={t('fin.accounting.expenses')} value={formatMoney(d?.totalExpenses)} loading={!d} />
        <StatCard tone={d && Number(d.netProfit) < 0 ? 'danger' : 'brand'} icon={<Scale />} label={d && Number(d.netProfit) < 0 ? t('fin.accounting.netLoss') : t('fin.accounting.netProfit')} value={formatMoney(d?.netProfit.replace('-', ''))} loading={!d} />
      </div>
      {!d ? (
        <Skeleton className="h-48 w-full" />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Statement title={t('fin.accounting.revenue')} rows={d.revenue} total={d.totalRevenue} totalLabel={t('fin.accounting.totalRevenue')} />
          <Statement title={t('fin.accounting.expenses')} rows={d.expenses} total={d.totalExpenses} totalLabel={t('fin.accounting.totalExpenses')} />
        </div>
      )}
      <p className="text-xs text-muted-foreground">{t('fin.accounting.plNote')}</p>
    </div>
  );
}

function BalanceSheet() {
  const { t, today } = useI18n();
  const client = useApiClient();
  const [asOf, setAsOf] = React.useState(today());
  const bs = useQuery({
    queryKey: [...KEY, 'bs', asOf],
    queryFn: () =>
      client.get<{ assets: Row[]; liabilities: Row[]; equity: Row[]; currentEarnings: string; totalAssets: string; totalLiabilities: string; totalEquity: string; balanced: boolean }>('/accounting/reports/balance-sheet', { query: { asOf } }),
    enabled: !!asOf,
    refetchOnMount: 'always',
  });
  const d = bs.data;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <AsOf value={asOf} onChange={setAsOf} />
        {d ? <Balanced ok={d.balanced} /> : null}
      </div>
      {!d ? (
        <Skeleton className="h-48 w-full" />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Statement title={t('fin.accounting.types.ASSET')} rows={d.assets} total={d.totalAssets} totalLabel={t('fin.accounting.totalAssets')} />
          <div className="space-y-4">
            <Statement title={t('fin.accounting.types.LIABILITY')} rows={d.liabilities} total={d.totalLiabilities} totalLabel={t('fin.accounting.totalLiabilities')} />
            <Statement
              title={t('fin.accounting.types.EQUITY')}
              rows={nonZero(d.currentEarnings) ? [...d.equity, { id: 'earnings', code: '', name: t('fin.accounting.currentEarnings'), nameAr: null, amount: d.currentEarnings }] : d.equity}
              total={d.totalEquity}
              totalLabel={t('fin.accounting.totalEquity')}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function TrialBalance() {
  const { t, pick, formatMoney, today } = useI18n();
  const client = useApiClient();
  const [asOf, setAsOf] = React.useState(today());
  const tb = useQuery({
    queryKey: [...KEY, 'tb', asOf],
    queryFn: () => client.get<{ rows: Account[]; totals: { debit: string; credit: string }; balanced: boolean }>('/accounting/reports/trial-balance', { query: { asOf } }),
    enabled: !!asOf,
    refetchOnMount: 'always',
  });
  const d = tb.data;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <AsOf value={asOf} onChange={setAsOf} />
        {d ? <Balanced ok={d.balanced} /> : null}
      </div>
      {!d ? (
        <Skeleton className="h-48 w-full" />
      ) : d.rows.length === 0 ? (
        <EmptyState icon={<BookOpen />} title={t('fin.accounting.empty')} description={t('fin.accounting.emptyText')} />
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full text-sm">
            <caption className="sr-only">{t('fin.accounting.tabs.tb')}</caption>
            <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2.5 text-start font-medium">{t('fin.accounting.columns.account')}</th>
                <th scope="col" className="px-3 py-2.5 text-end font-medium">{t('fin.accounting.columns.debit')}</th>
                <th scope="col" className="px-3 py-2.5 text-end font-medium">{t('fin.accounting.columns.credit')}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {d.rows.map((a) => (
                <tr key={a.id}>
                  <td className="px-3 py-2">
                    <span className="me-2 text-xs text-muted-foreground tabular">{a.code}</span>
                    {pick(a.name, a.nameAr)}
                  </td>
                  <td className="px-3 py-2 text-end tabular">{nonZero(a.debit) ? formatMoney(a.debit) : ''}</td>
                  <td className="px-3 py-2 text-end tabular">{nonZero(a.credit) ? formatMoney(a.credit) : ''}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t bg-muted/30 font-semibold">
              <tr>
                <td className="px-3 py-2.5">{t('fin.accounting.total')}</td>
                <td className="px-3 py-2.5 text-end tabular">{formatMoney(d.totals.debit)}</td>
                <td className="px-3 py-2.5 text-end tabular">{formatMoney(d.totals.credit)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

function VatReport() {
  const { t, tn, formatMoney } = useI18n();
  const client = useApiClient();
  const p = usePeriod();
  const vat = useQuery({
    queryKey: [...KEY, 'vat', p.from, p.to],
    queryFn: () => client.get<{ outputVat: string; reversed: string; netOutputVat: string; invoices: number; invoicedTotal: string }>('/accounting/reports/vat', { query: { from: p.from, to: p.to } }),
    enabled: !!p.from && !!p.to,
    refetchOnMount: 'always',
  });
  const d = vat.data;
  return (
    <div className="space-y-5">
      <Period {...p} />
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard tone="info" icon={<Landmark />} label={t('fin.accounting.outputVat')} value={formatMoney(d?.outputVat)} loading={!d} />
        <StatCard tone="neutral" icon={<Undo2 />} label={t('fin.accounting.vatReversed')} value={formatMoney(d?.reversed)} loading={!d} />
        <StatCard tone="brand" icon={<Scale />} label={t('fin.accounting.netVat')} value={formatMoney(d?.netOutputVat)} loading={!d} />
      </div>
      {d ? <p className="text-sm text-muted-foreground">{tn('fin.accounting.vatInvoices', d.invoices, { total: formatMoney(d.invoicedTotal) })}</p> : null}
      <Alert tone="info">{t('fin.accounting.vatNote')}</Alert>
    </div>
  );
}

// ---------------------------------------------------------------- journal
function Journal({ manage }: { manage: boolean }) {
  const { t, pick, formatMoney, formatDate } = useI18n();
  const client = useApiClient();
  const p = usePeriod();
  const [source, setSource] = React.useState('ALL');
  const [writing, setWriting] = React.useState(false);
  const [reversing, setReversing] = React.useState<JournalEntry | null>(null);
  const journal = useQuery({
    queryKey: [...KEY, 'journal', p.from, p.to, source],
    queryFn: () => client.get<Page<JournalEntry>>('/accounting/journal', { query: { from: p.from, to: p.to, pageSize: 100, ...(source !== 'ALL' ? { sourceType: source } : {}) } }),
    enabled: !!p.from && !!p.to,
    refetchOnMount: 'always',
  });
  const sources = ['INVOICE_ISSUED', 'INVOICE_VOIDED', 'PAYMENT', 'REFUND', 'CREDIT_NOTE', 'EXPENSE', 'COMMISSION_ACCRUED', 'COMMISSION_PAID', 'CASH_VARIANCE', 'MANUAL'];
  const reversed = new Set((journal.data?.data ?? []).map((e) => e.reversalOfId).filter(Boolean));
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <Period {...p} />
          <Select
            value={source}
            onValueChange={setSource}
            className="w-56"
            aria-label={t('fin.accounting.source')}
            options={[{ value: 'ALL', label: t('fin.accounting.allSources') }, ...sources.map((s) => ({ value: s, label: t(`fin.accounting.sources.${s}`) }))]}
          />
        </div>
        {manage ? (
          <Button onClick={() => setWriting(true)}>
            <Plus aria-hidden="true" />
            {t('fin.accounting.newJournal')}
          </Button>
        ) : null}
      </div>
      {!journal.data ? (
        <Skeleton className="h-48 w-full" />
      ) : journal.data.data.length === 0 ? (
        <EmptyState icon={<BookOpen />} title={t('fin.accounting.noJournal')} description={t('fin.accounting.emptyText')} />
      ) : (
        <ul className="space-y-3">
          {journal.data.data.map((e) => (
            <li key={e.id} className="overflow-hidden rounded-lg border bg-card">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/40 px-4 py-2 text-sm">
                <span className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="font-semibold tabular">{e.entryNo}</span>
                  <span className="text-muted-foreground tabular">{formatDate(e.date)}</span>
                  <Badge tone={e.sourceType.startsWith('MANUAL') ? 'brand' : 'neutral'}>{t(`fin.accounting.sources.${e.sourceType}`)}</Badge>
                  <span className="min-w-0 truncate">{e.memo}</span>
                </span>
                {manage && e.sourceType === 'MANUAL' && !reversed.has(e.id) ? (
                  <Button size="sm" variant="ghost" onClick={() => setReversing(e)}>
                    <Undo2 aria-hidden="true" />
                    {t('fin.accounting.reverse')}
                  </Button>
                ) : null}
              </div>
              <table className="w-full text-sm">
                <caption className="sr-only">{e.entryNo}</caption>
                <tbody className="divide-y">
                  {e.lines.map((l, i) => (
                    <tr key={i}>
                      <td className={`px-4 py-1.5 ${nonZero(l.credit) ? 'ps-10' : ''}`}>
                        <span className="me-2 text-xs text-muted-foreground tabular">{l.code}</span>
                        {pick(l.name, l.nameAr)}
                        {l.memo ? <span className="ms-2 text-xs text-muted-foreground">{l.memo}</span> : null}
                      </td>
                      <td className="w-32 px-4 py-1.5 text-end tabular">{nonZero(l.debit) ? formatMoney(l.debit) : ''}</td>
                      <td className="w-32 px-4 py-1.5 text-end tabular">{nonZero(l.credit) ? formatMoney(l.credit) : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </li>
          ))}
        </ul>
      )}
      {writing ? <ManualJournalDialog onClose={() => setWriting(false)} /> : null}
      {reversing ? <ReverseDialog entry={reversing} onClose={() => setReversing(null)} /> : null}
    </div>
  );
}

function useAccounts() {
  const client = useApiClient();
  return useQuery({ queryKey: [...KEY, 'accounts'], queryFn: () => client.get<Account[]>('/accounting/accounts'), refetchOnMount: 'always' });
}

function ManualJournalDialog({ onClose }: { onClose: () => void }) {
  const { t, pick, formatMoney, today } = useI18n();
  const client = useApiClient();
  const queryClient = useQueryClient();
  const toasts = useToast();
  const describe = useErrorMessage();
  const accounts = useAccounts();
  const [date, setDate] = React.useState(today());
  const [memo, setMemo] = React.useState('');
  const blank = () => ({ accountId: '', debit: '', credit: '' });
  const [lines, setLines] = React.useState([blank(), blank()]);
  const set = (i: number, patch: Partial<ReturnType<typeof blank>>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const debit = lines.reduce((s, l) => s + Math.round(Number(l.debit || 0) * 100), 0);
  const credit = lines.reduce((s, l) => s + Math.round(Number(l.credit || 0) * 100), 0);
  const ready = memo.trim() && lines.every((l) => l.accountId && (Number(l.debit || 0) > 0) !== (Number(l.credit || 0) > 0)) && debit === credit && debit > 0;
  const post = useMutation({
    mutationFn: () =>
      client.post('/accounting/journal', { date, memo, lines: lines.map((l) => ({ accountId: l.accountId, ...(Number(l.debit) > 0 ? { debit: l.debit } : { credit: l.credit }) })) }),
    onSuccess: () => {
      toasts.success(t('fin.accounting.journalPosted'));
      void queryClient.invalidateQueries({ queryKey: KEY });
      onClose();
    },
  });
  const options = (accounts.data ?? []).filter((a) => a.isActive).map((a) => ({ value: a.id, label: `${a.code} · ${pick(a.name, a.nameAr)}` }));
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{t('fin.accounting.newJournal')}</DialogTitle>
          <DialogDescription>{t('fin.accounting.newJournalText')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
            <div className="space-y-1.5">
              <Label htmlFor="j-date">{t('fin.accounting.date')}</Label>
              <DatePicker id="j-date" value={date} onChange={setDate} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="j-memo">{t('fin.accounting.memo')}</Label>
              <Input id="j-memo" value={memo} onChange={(e) => setMemo(e.target.value)} maxLength={500} placeholder={t('fin.accounting.memoHint')} />
            </div>
          </div>
          <fieldset className="space-y-2">
            <legend className="sr-only">{t('fin.accounting.lines')}</legend>
            <div className="hidden grid-cols-[1fr_8rem_8rem_2.25rem] gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground sm:grid">
              <span>{t('fin.accounting.columns.account')}</span>
              <span>{t('fin.accounting.columns.debit')}</span>
              <span>{t('fin.accounting.columns.credit')}</span>
            </div>
            {lines.map((l, i) => (
              <div key={i} className="grid grid-cols-2 gap-2 sm:grid-cols-[1fr_8rem_8rem_2.25rem]">
                <Select className="col-span-2 sm:col-span-1" aria-label={t('fin.accounting.columns.account')} value={l.accountId} onValueChange={(v) => set(i, { accountId: v })} placeholder={t('fin.accounting.pickAccount')} options={options} />
                <MoneyInput aria-label={t('fin.accounting.columns.debit')} value={l.debit} onChange={(v) => set(i, { debit: v, ...(Number(v) > 0 ? { credit: '' } : {}) })} />
                <MoneyInput aria-label={t('fin.accounting.columns.credit')} value={l.credit} onChange={(v) => set(i, { credit: v, ...(Number(v) > 0 ? { debit: '' } : {}) })} />
                <Button variant="ghost" size="icon" aria-label={t('fin.accounting.removeLine')} disabled={lines.length <= 2} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                  <X aria-hidden="true" />
                </Button>
              </div>
            ))}
            <Button variant="outline" size="sm" onClick={() => setLines((ls) => [...ls, blank()])} disabled={lines.length >= 50}>
              <Plus aria-hidden="true" />
              {t('fin.accounting.addLine')}
            </Button>
          </fieldset>
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm">
            <span className="tabular">
              {t('fin.accounting.columns.debit')} {formatMoney(debit / 100)} · {t('fin.accounting.columns.credit')} {formatMoney(credit / 100)}
            </span>
            {debit === credit && debit > 0 ? <Balanced ok /> : <Badge tone="warning">{t('fin.accounting.difference', { amount: formatMoney(Math.abs(debit - credit) / 100) })}</Badge>}
          </div>
          {post.error ? <Alert tone="danger">{describe(post.error)}</Alert> : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => post.mutate()} loading={post.isPending} disabled={!ready}>
            {t('fin.accounting.post')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReverseDialog({ entry, onClose }: { entry: JournalEntry; onClose: () => void }) {
  const { t } = useI18n();
  const client = useApiClient();
  const queryClient = useQueryClient();
  const describe = useErrorMessage();
  const [reason, setReason] = React.useState('');
  const reverse = useMutation({
    mutationFn: () => client.post(`/accounting/journal/${entry.id}/reverse`, { reason }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: KEY });
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{t('fin.accounting.reverseTitle', { no: entry.entryNo })}</DialogTitle>
          <DialogDescription>{t('fin.accounting.reverseText')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <Label htmlFor="r-reason">{t('fin.accounting.reason')}</Label>
          <Input id="r-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
          {reverse.error ? <Alert tone="danger">{describe(reverse.error)}</Alert> : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="destructive" onClick={() => reverse.mutate()} loading={reverse.isPending} disabled={!reason.trim()}>
            {t('fin.accounting.reverse')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- chart of accounts
function Accounts({ manage }: { manage: boolean }) {
  const { t, pick, formatMoney } = useI18n();
  const accounts = useAccounts();
  const [adding, setAdding] = React.useState(false);
  const [open, setOpen] = React.useState<Account | null>(null);
  return (
    <div className="space-y-4">
      {manage ? (
        <Button onClick={() => setAdding(true)}>
          <Plus aria-hidden="true" />
          {t('fin.accounting.addAccount')}
        </Button>
      ) : null}
      {!accounts.data ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        TYPES.map((type) => (
          <section key={type} className="overflow-hidden rounded-lg border bg-card">
            <h3 className="border-b bg-muted/50 px-4 py-2.5 text-sm font-semibold">{t(`fin.accounting.types.${type}`)}</h3>
            <ul className="divide-y text-sm">
              {accounts.data
                .filter((a) => a.type === type)
                .map((a) => (
                  <li key={a.id}>
                    <button type="button" onClick={() => setOpen(a)} className={`flex w-full items-center justify-between gap-3 px-4 py-2 text-start hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none ${a.isActive ? '' : 'opacity-60'}`}>
                      <span className="min-w-0">
                        <span className="me-2 text-xs text-muted-foreground tabular">{a.code}</span>
                        {pick(a.name, a.nameAr)}
                        {a.systemKey ? null : <Badge tone="neutral" className="ms-2">{t('fin.accounting.custom')}</Badge>}
                      </span>
                      <span className="tabular">{formatMoney(a.balance)}</span>
                    </button>
                  </li>
                ))}
            </ul>
          </section>
        ))
      )}
      {adding ? <AccountDialog onClose={() => setAdding(false)} /> : null}
      {open ? <AccountLedgerDialog account={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

function AccountDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const client = useApiClient();
  const queryClient = useQueryClient();
  const describe = useErrorMessage();
  const [code, setCode] = React.useState('');
  const [name, setName] = React.useState('');
  const [nameAr, setNameAr] = React.useState('');
  const [type, setType] = React.useState<AccountType>('EXPENSE');
  const create = useMutation({
    mutationFn: () => client.post('/accounting/accounts', { code, name, nameAr: nameAr || null, type }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: KEY });
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{t('fin.accounting.addAccount')}</DialogTitle>
          <DialogDescription>{t('fin.accounting.addAccountText')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <div className="grid grid-cols-[7rem_1fr] gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="ac-code">{t('fin.accounting.code')}</Label>
              <Input id="ac-code" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="5100" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ac-type">{t('fin.accounting.type')}</Label>
              <Select id="ac-type" value={type} onValueChange={(v) => setType(v as AccountType)} options={TYPES.map((x) => ({ value: x, label: t(`fin.accounting.types.${x}`) }))} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ac-name">{t('fin.accounting.name')}</Label>
            <Input id="ac-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ac-name-ar">{t('fin.accounting.nameAr')}</Label>
            <Input id="ac-name-ar" dir="rtl" value={nameAr} onChange={(e) => setNameAr(e.target.value)} maxLength={120} />
          </div>
          {create.error ? <Alert tone="danger">{describe(create.error)}</Alert> : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => create.mutate()} loading={create.isPending} disabled={code.length < 3 || !name.trim()}>
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AccountLedgerDialog({ account, onClose }: { account: Account; onClose: () => void }) {
  const { t, pick, formatMoney, formatDate } = useI18n();
  const client = useApiClient();
  const p = usePeriod();
  const ledger = useQuery({
    queryKey: [...KEY, 'ledger', account.id, p.from, p.to],
    queryFn: () =>
      client.get<{ openingBalance: string; closingBalance: string; lines: Array<{ entryNo: string; date: string; memo: string; debit: string; credit: string; balance: string }> }>('/accounting/reports/ledger', {
        query: { accountId: account.id, from: p.from, to: p.to },
      }),
    enabled: !!p.from && !!p.to,
  });
  const d = ledger.data;
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>
            {account.code} · {pick(account.name, account.nameAr)}
          </DialogTitle>
          <DialogDescription>{t(`fin.accounting.types.${account.type}`)}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <Period {...p} />
          {!d ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <caption className="sr-only">{t('fin.accounting.accountLedger')}</caption>
                <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    {['date', 'entry', 'memo', 'debit', 'credit', 'balance'].map((c) => (
                      <th key={c} scope="col" className={`px-3 py-2 font-medium ${['debit', 'credit', 'balance'].includes(c) ? 'text-end' : 'text-start'}`}>
                        {t(`fin.accounting.columns.${c}`)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y">
                  <tr className="text-muted-foreground">
                    <td className="px-3 py-2" colSpan={5}>{t('fin.accounting.opening')}</td>
                    <td className="px-3 py-2 text-end tabular">{formatMoney(d.openingBalance)}</td>
                  </tr>
                  {d.lines.map((l, i) => (
                    <tr key={i}>
                      <td className="whitespace-nowrap px-3 py-2 tabular">{formatDate(l.date)}</td>
                      <td className="px-3 py-2 tabular">{l.entryNo}</td>
                      <td className="px-3 py-2">{l.memo}</td>
                      <td className="px-3 py-2 text-end tabular">{nonZero(l.debit) ? formatMoney(l.debit) : ''}</td>
                      <td className="px-3 py-2 text-end tabular">{nonZero(l.credit) ? formatMoney(l.credit) : ''}</td>
                      <td className="px-3 py-2 text-end tabular">{formatMoney(l.balance)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t bg-muted/30 font-semibold">
                  <tr>
                    <td className="px-3 py-2" colSpan={5}>{t('fin.accounting.closing')}</td>
                    <td className="px-3 py-2 text-end tabular">{formatMoney(d.closingBalance)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
