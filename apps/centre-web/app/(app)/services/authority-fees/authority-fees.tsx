'use client';

import * as React from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Download, Landmark, Link2, RefreshCw } from 'lucide-react';
import {
  Alert, Badge, Button, Card, Checkbox, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, EmptyState, Input, Label, MoneyInput, PageHeader,
  SearchInput, Select, Skeleton, Tabs, TabsList, TabsTrigger, useApi, useErrorMessage, useI18n, useSession, useToast,
} from '@typease/ui';
import { useServiceOptions } from '@/components/pickers';

interface Fee {
  id: string;
  authority: string;
  code: string;
  name: string;
  nameAr: string | null;
  category: string | null;
  governmentFee: string;
  thirdPartyFee: string;
  notes: string | null;
  verifiedAt: string | null;
  isSample: boolean;
  version: number;
  services: Array<{ id: string; code: string; name: string; nameAr: string | null; upToDate: boolean }>;
}
interface Update {
  serviceId: string;
  code: string;
  name: string;
  nameAr: string | null;
  fee: { code: string; name: string; nameAr: string | null; version: number; isSample: boolean };
  current: { serviceFee: string; governmentFee: string; thirdPartyFee: string } | null;
  proposed: { governmentFee: string; thirdPartyFee: string };
}
const KEY = ['authority-fees'] as const;
const AUTHORITIES = ['AMER', 'TASHEEL', 'ICP', 'MOHRE', 'GDRFA', 'DED', 'MOFA', 'DHA', 'MOHAP', 'POLICE', 'COURTS', 'OTHER'];
const ALL = '__all__';

export function AuthorityFeeCatalogue() {
  const { t, pick, formatMoney, formatDate } = useI18n();
  const api = useApi();
  const session = useSession();
  const manage = session.hasPermission('service.manage');
  const [authority, setAuthority] = React.useState(ALL);
  const [q, setQ] = React.useState('');
  const [adding, setAdding] = React.useState<Fee | null>(null);
  const fees = useQuery({ queryKey: [...KEY, authority, q], queryFn: () => api.client.get<Fee[]>('/authority-fees', { query: { ...(authority !== ALL ? { authority } : {}), ...(q.trim() ? { q: q.trim() } : {}) } }) });
  return (
    <>
      <PageHeader
        title={t('ops.services.fees.title')}
        description={t('ops.services.fees.description')}
        secondary={
          <Button variant="outline" asChild>
            <Link href="/services">
              <ArrowLeft aria-hidden="true" className="rtl:rotate-180" />
              {t('ops.services.title')}
            </Link>
          </Button>
        }
      />
      <Updates manage={manage} />
      <Alert tone="info" className="mb-4">
        {t('ops.services.fees.disclaimer')}
      </Alert>
      <Card className="mb-4 flex flex-wrap items-center gap-3 p-4">
        <div className="w-full sm:w-72">
          <SearchInput value={q} onChange={setQ} placeholder={t('ops.services.fees.search')} aria-label={t('ops.services.fees.search')} />
        </div>
        <Select
          aria-label={t('ops.services.fees.authority')}
          className="w-full sm:w-64"
          value={authority}
          onValueChange={setAuthority}
          options={[{ value: ALL, label: t('ops.services.fees.all') }, ...AUTHORITIES.map((a) => ({ value: a, label: t(`ops.services.fees.authorities.${a}`) }))]}
        />
      </Card>
      {!fees.data ? (
        <Skeleton className="h-72 w-full" />
      ) : fees.data.length === 0 ? (
        <EmptyState icon={<Landmark />} title={t('ops.services.fees.empty')} description={t('ops.services.fees.emptyText')} />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {fees.data.map((f) => (
            <Card key={f.id} className="flex flex-col gap-3 p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold leading-snug">{pick(f.name, f.nameAr)}</p>
                  <p className="text-xs text-muted-foreground tabular">
                    {t(`ops.services.fees.authorities.${f.authority}`)} · {f.code}
                  </p>
                </div>
                {f.isSample ? <Badge tone="warning">{t('ops.services.fees.sample')}</Badge> : <Badge tone="success">{f.verifiedAt ? t('ops.services.fees.verifiedOn', { date: formatDate(f.verifiedAt) }) : t('ops.services.fees.verified')}</Badge>}
              </div>
              <dl className="grid grid-cols-2 gap-2 text-sm">
                <div className="rounded-md bg-muted/50 px-3 py-2">
                  <dt className="text-xs text-muted-foreground">{t('ops.services.fees.government')}</dt>
                  <dd className="font-semibold tabular">{formatMoney(f.governmentFee)}</dd>
                </div>
                <div className="rounded-md bg-muted/50 px-3 py-2">
                  <dt className="text-xs text-muted-foreground">{t('ops.services.fees.channel')}</dt>
                  <dd className="font-semibold tabular">{formatMoney(f.thirdPartyFee)}</dd>
                </div>
              </dl>
              <div className="mt-auto flex flex-wrap items-center justify-between gap-2">
                {f.services.length ? (
                  <span className="flex min-w-0 flex-wrap gap-1">
                    {f.services.map((s) => (
                      <Link key={s.id} href={`/services/${s.id}`}>
                        <Badge tone={s.upToDate ? 'brand' : 'warning'}>
                          <Link2 aria-hidden="true" className="size-3" />
                          {s.code}
                        </Badge>
                      </Link>
                    ))}
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">{t('ops.services.fees.notUsed')}</span>
                )}
                {manage ? (
                  <Button size="sm" variant="outline" onClick={() => setAdding(f)}>
                    <Download aria-hidden="true" />
                    {t('ops.services.fees.use')}
                  </Button>
                ) : null}
              </div>
            </Card>
          ))}
        </div>
      )}
      {adding ? <UseFeeDialog fee={adding} onClose={() => setAdding(null)} /> : null}
    </>
  );
}

/** TypEase changed amounts of entries this centre follows: compare and apply. */
function Updates({ manage }: { manage: boolean }) {
  const { t, tn, pick, formatMoney } = useI18n();
  const api = useApi();
  const queryClient = useQueryClient();
  const toasts = useToast();
  const updates = useQuery({ queryKey: [...KEY, 'updates'], queryFn: () => api.client.get<Update[]>('/authority-fees/updates') });
  const [chosen, setChosen] = React.useState<Set<string> | null>(null);
  const apply = useMutation({
    mutationFn: (serviceIds: string[]) => api.client.post<{ services: number; prices: number }>('/authority-fees/updates/apply', { serviceIds }),
    onSuccess: (r) => {
      toasts.success(tn('ops.services.fees.applied', r.services));
      setChosen(null);
      void queryClient.invalidateQueries({ queryKey: KEY });
      void queryClient.invalidateQueries({ queryKey: ['services'] });
    },
    onError: (e) => toasts.error(e),
  });
  const list = updates.data ?? [];
  if (!list.length) return null;
  const selected = chosen ?? new Set(list.map((u) => u.serviceId));
  const toggle = (id: string) => setChosen(new Set(selected.has(id) ? [...selected].filter((x) => x !== id) : [...selected, id]));
  return (
    <Card className="mb-4 space-y-3 border-warning/50 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 font-semibold">
          <RefreshCw aria-hidden="true" className="size-4 text-warning-text" />
          {tn('ops.services.fees.updatesTitle', list.length)}
        </h2>
        {manage ? (
          <Button size="sm" disabled={!selected.size} loading={apply.isPending} onClick={() => apply.mutate([...selected])}>
            {tn('ops.services.fees.apply', selected.size)}
          </Button>
        ) : null}
      </div>
      <p className="text-sm text-muted-foreground">{t('ops.services.fees.updatesText')}</p>
      <ul className="divide-y rounded-md border text-sm">
        {list.map((u) => (
          <li key={u.serviceId} className="flex flex-wrap items-center gap-3 px-3 py-2">
            {manage ? <Checkbox checked={selected.has(u.serviceId)} onCheckedChange={() => toggle(u.serviceId)} aria-label={u.name} /> : null}
            <span className="min-w-0 flex-1">
              <span className="block font-medium">{pick(u.name, u.nameAr)}</span>
              <span className="block text-xs text-muted-foreground">
                {u.fee.code} · v{u.fee.version}
                {u.fee.isSample ? ` · ${t('ops.services.fees.sample')}` : ''}
              </span>
            </span>
            <span className="flex items-center gap-2 tabular">
              <span className="text-muted-foreground line-through decoration-muted-foreground/50">{u.current ? formatMoney(Number(u.current.governmentFee) + Number(u.current.thirdPartyFee)) : '—'}</span>
              <ArrowRight aria-hidden="true" className="size-3.5 rtl:rotate-180" />
              <span className="font-semibold">{formatMoney(Number(u.proposed.governmentFee) + Number(u.proposed.thirdPartyFee))}</span>
              <span className="text-xs text-muted-foreground">{t('ops.services.fees.passThrough')}</span>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Use an entry: as a new service with the centre's own fee, or by linking a service the centre already has. */
function UseFeeDialog({ fee, onClose }: { fee: Fee; onClose: () => void }) {
  const { t, pick, formatMoney } = useI18n();
  const api = useApi();
  const queryClient = useQueryClient();
  const toasts = useToast();
  const describe = useErrorMessage();
  const services = useServiceOptions();
  const categories = useQuery({ queryKey: ['service-categories', 'fees'], queryFn: () => api.client.get<Array<{ id: string; name: string; nameAr: string | null; isActive: boolean }>>('/service-categories') });
  const [mode, setMode] = React.useState<'new' | 'link'>('new');
  const [categoryId, setCategoryId] = React.useState('');
  const [code, setCode] = React.useState(fee.code.slice(0, 30));
  const [serviceFee, setServiceFee] = React.useState('');
  const [serviceId, setServiceId] = React.useState('');
  const done = () => {
    void queryClient.invalidateQueries({ queryKey: KEY });
    void queryClient.invalidateQueries({ queryKey: ['services'] });
    onClose();
  };
  const create = useMutation({
    mutationFn: () => api.client.post<{ id: string; code: string }>(`/authority-fees/${fee.id}/import`, { categoryId, code, serviceFee }),
    onSuccess: (s) => {
      toasts.success(t('ops.services.fees.imported', { code: s.code }));
      done();
    },
  });
  const link = useMutation({
    mutationFn: () => api.client.put(`/services/${serviceId}/authority-fee`, { authorityFeeId: fee.id }),
    onSuccess: () => {
      toasts.success(t('ops.services.fees.linked'));
      done();
    },
  });
  const error = create.error ?? link.error;
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{pick(fee.name, fee.nameAr)}</DialogTitle>
          <DialogDescription>
            {t('ops.services.fees.government')} {formatMoney(fee.governmentFee)} · {t('ops.services.fees.channel')} {formatMoney(fee.thirdPartyFee)}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <Tabs value={mode} onValueChange={(v) => setMode(v as 'new' | 'link')}>
            <TabsList>
              <TabsTrigger value="new">{t('ops.services.fees.asNew')}</TabsTrigger>
              <TabsTrigger value="link">{t('ops.services.fees.linkExisting')}</TabsTrigger>
            </TabsList>
          </Tabs>
          {mode === 'new' ? (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="fee-category">{t('ops.services.fees.category')}</Label>
                <Select id="fee-category" value={categoryId} onValueChange={setCategoryId} placeholder={t('ops.services.fees.chooseCategory')} options={(categories.data ?? []).filter((c) => c.isActive).map((c) => ({ value: c.id, label: pick(c.name, c.nameAr) }))} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="fee-code">{t('ops.services.fees.code')}</Label>
                  <Input id="fee-code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} dir="ltr" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="fee-own">{t('ops.services.fees.yourFee')}</Label>
                  <MoneyInput id="fee-own" value={serviceFee} onChange={setServiceFee} />
                </div>
              </div>
              {serviceFee ? (
                <p className="rounded-md bg-muted/50 px-3 py-2 text-sm">
                  {t('ops.services.fees.customerPays', { amount: formatMoney(Number(serviceFee) + Number(fee.governmentFee) + Number(fee.thirdPartyFee)) })}
                </p>
              ) : null}
            </>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="fee-service">{t('ops.services.fees.yourService')}</Label>
              <Select id="fee-service" value={serviceId} onValueChange={setServiceId} placeholder={t('ops.services.fees.chooseService')} options={(services.data ?? []).map((s) => ({ value: s.id, label: `${s.code} · ${pick(s.name, s.nameAr)}` }))} />
              <p className="text-xs text-muted-foreground">{t('ops.services.fees.linkHint')}</p>
            </div>
          )}
          {error ? <Alert tone="danger">{describe(error)}</Alert> : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          {mode === 'new' ? (
            <Button onClick={() => create.mutate()} loading={create.isPending} disabled={!categoryId || code.length < 2 || !serviceFee}>
              {t('ops.services.fees.create')}
            </Button>
          ) : (
            <Button onClick={() => link.mutate()} loading={link.isPending} disabled={!serviceId}>
              {t('ops.services.fees.link')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
