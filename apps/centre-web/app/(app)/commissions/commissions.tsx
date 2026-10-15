'use client';

import * as React from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BadgePercent, Coins, HandCoins, Plus, Wallet } from 'lucide-react';
import type { Page } from '@typease/types';
import {
  Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, DatePicker, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
  EmptyState, Input, Label, MoneyInput, PageHeader, Select, Skeleton, StatCard, Switch, Tabs, TabsContent, TabsList, TabsTrigger, useApiClient, useErrorMessage, useI18n,
  useSession, useToast,
} from '@typease/ui';

type Beneficiary = 'OPERATOR' | 'REVIEWER' | 'CREATOR';
interface Rule {
  id: string;
  serviceId: string | null;
  service: { id: string; name: string; nameAr: string | null } | null;
  beneficiary: Beneficiary;
  kind: 'PERCENT' | 'FIXED';
  value: string;
  isActive: boolean;
}
interface Entry {
  id: string;
  request: { id: string; requestNo: string; serviceName: string; serviceNameAr: string | null };
  staffName: string;
  beneficiary: Beneficiary;
  basis: string;
  kind: 'PERCENT' | 'FIXED';
  value: string;
  amount: string;
  currency: string;
  status: 'ACCRUED' | 'PAID' | 'VOID';
  earnedAt: string;
  paidAt: string | null;
  payoutRef: string | null;
}
interface Summary {
  currency: string;
  staff: Array<{ membershipId: string; name: string; role: string | null; requests: number; earned: string; accrued: string; paid: string; owedTotal: string }>;
}

const firstOfMonth = (ymd: string) => `${ymd.slice(0, 7)}-01`;

export function Commissions() {
  const { t } = useI18n();
  const session = useSession();
  const manage = session.hasPermission('commission.manage');
  const [tab, setTab] = React.useState(manage ? 'staff' : 'mine');
  return (
    <>
      <PageHeader title={t('commission.title')} description={manage ? t('commission.descriptionManage') : t('commission.description')} />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-5">
          {manage ? <TabsTrigger value="staff">{t('commission.tabs.staff')}</TabsTrigger> : null}
          <TabsTrigger value="mine">{t('commission.tabs.mine')}</TabsTrigger>
          {manage ? <TabsTrigger value="rules">{t('commission.tabs.rules')}</TabsTrigger> : null}
        </TabsList>
        {manage ? (
          <TabsContent value="staff">
            <StaffSummary />
          </TabsContent>
        ) : null}
        <TabsContent value="mine">
          <EntryList own />
        </TabsContent>
        {manage ? (
          <TabsContent value="rules">
            <RuleList />
          </TabsContent>
        ) : null}
      </Tabs>
    </>
  );
}

function StatusBadge({ status }: { status: Entry['status'] }) {
  const { t } = useI18n();
  return <Badge tone={status === 'PAID' ? 'success' : status === 'ACCRUED' ? 'info' : 'neutral'} dot>{t(`commission.status.${status}`)}</Badge>;
}

function useRuleText() {
  const { formatMoney } = useI18n();
  return (kind: 'PERCENT' | 'FIXED', value: string, currency?: string) => (kind === 'PERCENT' ? `${Number(value)}%` : formatMoney(value, currency));
}

// ---------------------------------------------------------------- entries (own or all)
function EntryList({ own }: { own?: boolean }) {
  const { t, pick, formatMoney, formatDate } = useI18n();
  const client = useApiClient();
  const ruleText = useRuleText();
  const [status, setStatus] = React.useState('ALL');
  const entries = useQuery({
    queryKey: ['commission', 'entries', own ? 'own' : 'all', status],
    queryFn: () => client.get<Page<Entry> & { totals: Record<string, string> }>('/commissions/entries', { query: { pageSize: 100, ...(status !== 'ALL' ? { status } : {}) } }),
    // Commission is earned elsewhere (when requests are completed): always show the current figures.
    refetchOnMount: 'always',
  });
  const data = entries.data;
  const currency = data?.data[0]?.currency;
  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <StatCard tone="info" icon={<Coins />} label={t('commission.toBePaid')} value={formatMoney(data?.totals.ACCRUED, currency)} loading={!data} />
        <StatCard tone="success" icon={<Wallet />} label={t('commission.paid')} value={formatMoney(data?.totals.PAID, currency)} loading={!data} />
      </div>
      <Select
        value={status}
        onValueChange={setStatus}
        className="w-48"
        aria-label={t('commission.columns.status')}
        options={[{ value: 'ALL', label: t('commission.allEntries') }, ...(['ACCRUED', 'PAID', 'VOID'] as const).map((s) => ({ value: s, label: t(`commission.status.${s}`) }))]}
      />
      {!data ? (
        <Skeleton className="h-40 w-full" />
      ) : data.data.length === 0 ? (
        <EmptyState icon={<HandCoins />} title={t('commission.noEntries')} description={t('commission.noEntriesText')} />
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full text-sm">
            <caption className="sr-only">{t('commission.tabs.mine')}</caption>
            <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                {['request', 'role', 'basis', 'rate', 'amount', 'earned', 'status'].map((c) => (
                  <th key={c} scope="col" className="px-3 py-2.5 text-start font-medium">
                    {t(`commission.columns.${c}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {data.data.map((e) => (
                <tr key={e.id}>
                  <td className="px-3 py-2.5">
                    <Link href={`/requests/${e.request.id}`} className="font-medium tabular hover:underline">
                      {e.request.requestNo}
                    </Link>
                    <span className="block text-xs text-muted-foreground">{pick(e.request.serviceName, e.request.serviceNameAr)}</span>
                  </td>
                  <td className="px-3 py-2.5">{t(`commission.beneficiary.${e.beneficiary}`)}</td>
                  <td className="px-3 py-2.5 tabular">{formatMoney(e.basis, e.currency)}</td>
                  <td className="px-3 py-2.5 tabular">{ruleText(e.kind, e.value, e.currency)}</td>
                  <td className="px-3 py-2.5 font-semibold tabular">{formatMoney(e.amount, e.currency)}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 tabular">{formatDate(e.earnedAt)}</td>
                  <td className="px-3 py-2.5">
                    <StatusBadge status={e.status} />
                    {e.payoutRef ? <span className="block text-xs text-muted-foreground">{e.payoutRef}</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- per staff member (managers)
function StaffSummary() {
  const { t, formatMoney, today } = useI18n();
  const client = useApiClient();
  const [from, setFrom] = React.useState(firstOfMonth(today()));
  const [to, setTo] = React.useState(today());
  const [paying, setPaying] = React.useState<Summary['staff'][number] | null>(null);
  const summary = useQuery({ queryKey: ['commission', 'summary', from, to], queryFn: () => client.get<Summary>('/commissions/summary', { query: { from, to } }), enabled: !!from && !!to, refetchOnMount: 'always' });
  const s = summary.data;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="c-from">{t('commission.from')}</Label>
          <DatePicker id="c-from" value={from} onChange={setFrom} max={to} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="c-to">{t('commission.to')}</Label>
          <DatePicker id="c-to" value={to} onChange={setTo} min={from} />
        </div>
      </div>
      {!s ? (
        <Skeleton className="h-40 w-full" />
      ) : s.staff.length === 0 ? (
        <EmptyState icon={<HandCoins />} title={t('commission.noStaff')} description={t('commission.noStaffText')} />
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full text-sm">
            <caption className="sr-only">{t('commission.tabs.staff')}</caption>
            <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                {['staff', 'requests', 'earned', 'paidPeriod', 'owed', 'action'].map((c) => (
                  <th key={c} scope="col" className="px-3 py-2.5 text-start font-medium">
                    {t(`commission.columns.${c}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {s.staff.map((p) => (
                <tr key={p.membershipId}>
                  <td className="px-3 py-2.5">
                    <span className="font-medium">{p.name}</span>
                    {p.role ? <span className="block text-xs text-muted-foreground">{p.role}</span> : null}
                  </td>
                  <td className="px-3 py-2.5 tabular">{p.requests}</td>
                  <td className="px-3 py-2.5 font-semibold tabular">{formatMoney(p.earned, s.currency)}</td>
                  <td className="px-3 py-2.5 tabular">{formatMoney(p.paid, s.currency)}</td>
                  <td className="px-3 py-2.5 tabular">{Number(p.owedTotal) > 0 ? <Badge tone="info">{formatMoney(p.owedTotal, s.currency)}</Badge> : formatMoney('0', s.currency)}</td>
                  <td className="px-3 py-2.5">
                    <Button size="sm" variant="outline" disabled={Number(p.owedTotal) <= 0} onClick={() => setPaying(p)}>
                      <Wallet aria-hidden="true" />
                      {t('commission.payOut')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {paying && s ? <PayoutDialog person={paying} currency={s.currency} onClose={() => setPaying(null)} /> : null}
    </div>
  );
}

function PayoutDialog({ person, currency, onClose }: { person: Summary['staff'][number]; currency: string; onClose: () => void }) {
  const { t, formatMoney, today } = useI18n();
  const client = useApiClient();
  const queryClient = useQueryClient();
  const toasts = useToast();
  const describe = useErrorMessage();
  const [upTo, setUpTo] = React.useState(today());
  const [reference, setReference] = React.useState('');
  const pay = useMutation({
    mutationFn: () => client.post<{ total: string; entries: number }>('/commissions/payouts', { membershipId: person.membershipId, upTo, reference }),
    onSuccess: (r) => {
      toasts.success(t('commission.paidOut', { name: person.name, amount: formatMoney(r.total, currency) }));
      void queryClient.invalidateQueries({ queryKey: ['commission'] });
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{t('commission.payoutTitle', { name: person.name })}</DialogTitle>
          <DialogDescription>{t('commission.payoutText', { amount: formatMoney(person.owedTotal, currency) })}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="p-upto">{t('commission.upTo')}</Label>
            <DatePicker id="p-upto" value={upTo} onChange={setUpTo} max={today()} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="p-ref">{t('commission.reference')}</Label>
            <Input id="p-ref" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={120} placeholder={t('commission.referenceHint')} />
          </div>
          {pay.error ? <Alert tone="danger">{describe(pay.error)}</Alert> : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => pay.mutate()} loading={pay.isPending} disabled={!reference.trim() || !upTo}>
            {t('commission.confirmPayout')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- rules (managers)
function RuleList() {
  const { t, pick } = useI18n();
  const client = useApiClient();
  const queryClient = useQueryClient();
  const toasts = useToast();
  const ruleText = useRuleText();
  const [adding, setAdding] = React.useState(false);
  const rules = useQuery({ queryKey: ['commission', 'rules'], queryFn: () => client.get<Rule[]>('/commissions/rules') });
  const toggle = useMutation({
    mutationFn: (r: Rule) => client.patch<Rule>(`/commissions/rules/${r.id}`, { isActive: !r.isActive }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['commission', 'rules'] }),
    onError: (e) => toasts.error(e),
  });
  return (
    <div className="space-y-4">
      <Alert tone="info">{t('commission.rulesHelp')}</Alert>
      <Button onClick={() => setAdding(true)}>
        <Plus aria-hidden="true" />
        {t('commission.addRule')}
      </Button>
      {!rules.data ? (
        <Skeleton className="h-32 w-full" />
      ) : rules.data.length === 0 ? (
        <EmptyState icon={<BadgePercent />} title={t('commission.noRules')} description={t('commission.noRulesText')} />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {rules.data.map((r) => (
            <Card key={r.id} className={r.isActive ? '' : 'opacity-60'}>
              <CardHeader className="flex flex-row items-start justify-between gap-3 pb-2">
                <div>
                  <CardTitle className="text-base">{r.service ? pick(r.service.name, r.service.nameAr) : t('commission.allServices')}</CardTitle>
                  <p className="text-sm text-muted-foreground">{t(`commission.beneficiary.${r.beneficiary}`)}</p>
                </div>
                <Switch checked={r.isActive} onCheckedChange={() => toggle.mutate(r)} aria-label={t('commission.active')} />
              </CardHeader>
              <CardContent>
                <span className="text-2xl font-semibold tabular">{ruleText(r.kind, r.value)}</span>
                <span className="ms-2 text-sm text-muted-foreground">{r.kind === 'PERCENT' ? t('commission.ofServiceFee') : t('commission.perRequest')}</span>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      {adding ? <RuleDialog onClose={() => setAdding(false)} /> : null}
    </div>
  );
}

function RuleDialog({ onClose }: { onClose: () => void }) {
  const { t, pick } = useI18n();
  const client = useApiClient();
  const queryClient = useQueryClient();
  const describe = useErrorMessage();
  const services = useQuery({ queryKey: ['commission', 'services'], queryFn: () => client.get<Page<{ id: string; name: string; nameAr: string | null }>>('/services', { query: { pageSize: 100 } }) });
  const [serviceId, setServiceId] = React.useState('ALL');
  const [beneficiary, setBeneficiary] = React.useState<Beneficiary>('OPERATOR');
  const [kind, setKind] = React.useState<'PERCENT' | 'FIXED'>('PERCENT');
  const [value, setValue] = React.useState('');
  const create = useMutation({
    mutationFn: () => client.post<Rule>('/commissions/rules', { serviceId: serviceId === 'ALL' ? null : serviceId, beneficiary, kind, value }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['commission', 'rules'] });
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{t('commission.addRule')}</DialogTitle>
          <DialogDescription>{t('commission.addRuleText')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="r-service">{t('commission.service')}</Label>
            <Select id="r-service" value={serviceId} onValueChange={setServiceId} options={[{ value: 'ALL', label: t('commission.allServices') }, ...(services.data?.data ?? []).map((s) => ({ value: s.id, label: pick(s.name, s.nameAr) }))]} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="r-who">{t('commission.who')}</Label>
            <Select id="r-who" value={beneficiary} onValueChange={(v) => setBeneficiary(v as Beneficiary)} options={(['OPERATOR', 'REVIEWER', 'CREATOR'] as const).map((b) => ({ value: b, label: t(`commission.beneficiary.${b}`) }))} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="r-kind">{t('commission.kind')}</Label>
              <Select id="r-kind" value={kind} onValueChange={(v) => setKind(v as 'PERCENT' | 'FIXED')} options={[{ value: 'PERCENT', label: t('commission.percent') }, { value: 'FIXED', label: t('commission.fixed') }]} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="r-value">{kind === 'PERCENT' ? t('commission.percentValue') : t('commission.fixedValue')}</Label>
              {kind === 'PERCENT' ? <Input id="r-value" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value.replace(/[^\d.]/g, ''))} /> : <MoneyInput id="r-value" value={value} onChange={setValue} />}
            </div>
          </div>
          {create.error ? <Alert tone="danger">{describe(create.error)}</Alert> : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => create.mutate()} loading={create.isPending} disabled={!value}>
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
