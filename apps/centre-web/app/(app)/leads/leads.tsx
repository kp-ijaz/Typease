'use client';

import * as React from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlarmClock, CheckCircle2, Mail, MessageCircle, NotebookPen, Phone, Plus, Target, Trophy, Users, XCircle } from 'lucide-react';
import type { Page } from '@typease/types';
import {
  Alert, Badge, Button, Card, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label, MoneyInput, PageHeader, SearchInput, Select,
  Skeleton, StatCard, Tabs, TabsList, TabsTrigger, Textarea, cn, useApiClient, useErrorMessage, useI18n, useSession, useToast,
} from '@typease/ui';
import { CustomerPicker, ServicePicker } from '@/components/pickers';

type Status = 'NEW' | 'CONTACTED' | 'QUOTED' | 'WON' | 'LOST';
const STATUSES: Status[] = ['NEW', 'CONTACTED', 'QUOTED', 'WON', 'LOST'];
const SOURCES = ['WALK_IN', 'PHONE', 'WHATSAPP', 'WEBSITE', 'REFERRAL', 'CORPORATE', 'SOCIAL', 'OTHER'] as const;
interface Lead {
  id: string;
  leadNo: string;
  name: string;
  phone: string | null;
  email: string | null;
  source: (typeof SOURCES)[number];
  status: Status;
  interest: string | null;
  estimatedValue: string | null;
  ownerName: string | null;
  nextFollowUpAt: string | null;
  followUpDue?: boolean;
  service: { id: string; name: string; nameAr: string | null } | null;
  lostReason: string | null;
  createdAt: string;
}
interface Detail extends Lead {
  customer: { id: string; customerNo: string; fullName: string } | null;
  request: { id: string; requestNo: string; status: string } | null;
  activities: Array<{ id: string; kind: string; body: string; authorName: string | null; createdAt: string }>;
}
const KEY = ['leads'] as const;
const TONE: Record<Status, 'neutral' | 'info' | 'warning' | 'success' | 'danger'> = { NEW: 'info', CONTACTED: 'neutral', QUOTED: 'warning', WON: 'success', LOST: 'danger' };
const ICON: Record<string, React.ReactNode> = { CALL: <Phone className="size-3.5" />, WHATSAPP: <MessageCircle className="size-3.5" />, EMAIL: <Mail className="size-3.5" />, MEETING: <Users className="size-3.5" />, NOTE: <NotebookPen className="size-3.5" />, STATUS: <Target className="size-3.5" /> };

export function Leads() {
  const { t, formatMoney } = useI18n();
  const client = useApiClient();
  const session = useSession();
  const manage = session.hasPermission('lead.manage');
  const [view, setView] = React.useState<'all' | 'mine' | 'due'>('all');
  const [q, setQ] = React.useState('');
  const [creating, setCreating] = React.useState(false);
  const [open, setOpen] = React.useState<string | null>(null);
  const leads = useQuery({
    queryKey: [...KEY, view, q],
    queryFn: () => client.get<Page<Lead> & { counts: Partial<Record<Status, number>>; dueToday: number }>('/leads', { query: { pageSize: 100, sort: 'createdAt:desc', ...(view === 'mine' ? { mine: true } : {}), ...(view === 'due' ? { due: true } : {}), ...(q.trim() ? { q: q.trim() } : {}) } }),
    refetchInterval: 60_000,
  });
  const d = leads.data;
  const pipeline = (d?.data ?? []).filter((l) => ['NEW', 'CONTACTED', 'QUOTED'].includes(l.status)).reduce((s, l) => s + Number(l.estimatedValue ?? 0), 0);
  return (
    <>
      <PageHeader
        title={t('leads.title')}
        description={t('leads.description')}
        action={
          manage ? (
            <Button variant="accent" onClick={() => setCreating(true)}>
              <Plus aria-hidden="true" />
              {t('leads.new')}
            </Button>
          ) : undefined
        }
      />
      <div className="mb-4 grid gap-3 sm:grid-cols-2 2xl:grid-cols-4">
        <StatCard tone="info" icon={<Target />} label={t('leads.open')} value={String((d?.counts.NEW ?? 0) + (d?.counts.CONTACTED ?? 0) + (d?.counts.QUOTED ?? 0))} loading={!d} />
        <StatCard tone={d?.dueToday ? 'danger' : 'neutral'} icon={<AlarmClock />} label={t('leads.dueToday')} value={String(d?.dueToday ?? 0)} loading={!d} />
        <StatCard tone="brand" icon={<Trophy />} label={t('leads.won')} value={String(d?.counts.WON ?? 0)} loading={!d} />
        <StatCard tone="warning" icon={<CheckCircle2 />} label={t('leads.pipelineValue')} value={formatMoney(pipeline)} loading={!d} />
      </div>
      <Card className="mb-4 flex flex-wrap items-center gap-3 p-3">
        <div className="w-full sm:w-72">
          <SearchInput value={q} onChange={setQ} placeholder={t('leads.search')} aria-label={t('leads.search')} />
        </div>
        <Tabs value={view} onValueChange={(v) => setView(v as typeof view)}>
          <TabsList>
            <TabsTrigger value="all">{t('leads.views.all')}</TabsTrigger>
            <TabsTrigger value="mine">{t('leads.views.mine')}</TabsTrigger>
            <TabsTrigger value="due">
              {t('leads.views.due')}
              {d?.dueToday ? <Badge tone="danger" className="ms-1 h-5 px-1.5">{d.dueToday}</Badge> : null}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </Card>
      {!d ? (
        <Skeleton className="h-96 w-full" />
      ) : (
        <div className="-mx-4 overflow-x-auto px-4 pb-4 md:-mx-6 md:px-6">
          <div className="flex min-w-max gap-3">
            {STATUSES.map((s) => {
              const rows = d.data.filter((l) => l.status === s);
              return (
                <section key={s} aria-labelledby={`lead-col-${s}`} className="w-72 shrink-0 rounded-xl border bg-muted/30">
                  <h2 id={`lead-col-${s}`} className="flex items-center justify-between px-3 py-2.5 text-sm font-semibold">
                    {t(`leads.statuses.${s}`)}
                    <Badge tone={TONE[s]}>{rows.length}</Badge>
                  </h2>
                  <ul className="space-y-2 px-2 pb-2">
                    {rows.length === 0 ? <li className="px-2 py-6 text-center text-xs text-muted-foreground">{t('leads.emptyColumn')}</li> : null}
                    {rows.map((l) => (
                      <li key={l.id}>
                        <button type="button" onClick={() => setOpen(l.id)} className={cn('w-full rounded-lg border bg-card p-3 text-start shadow-xs transition hover:border-secondary/50 hover:shadow-sm', l.followUpDue && 'border-s-4 border-s-destructive')}>
                          <span className="flex items-start justify-between gap-2">
                            <span className="min-w-0">
                              <span className="block truncate font-medium">{l.name}</span>
                              <span className="block truncate text-xs text-muted-foreground">{l.service?.name ?? l.interest ?? t(`leads.sources.${l.source}`)}</span>
                            </span>
                            {l.estimatedValue ? <span className="shrink-0 text-xs font-semibold tabular">{formatMoney(l.estimatedValue)}</span> : null}
                          </span>
                          <span className="mt-2 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                            <span className="truncate">{l.ownerName ?? t('leads.noOwner')}</span>
                            {l.followUpDue ? (
                              <Badge tone="danger">
                                <AlarmClock aria-hidden="true" className="size-3" />
                                {t('leads.followUpDue')}
                              </Badge>
                            ) : (
                              <span>{t(`leads.sources.${l.source}`)}</span>
                            )}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        </div>
      )}
      {creating ? (
        <LeadDialog
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            setOpen(id);
          }}
        />
      ) : null}
      {open ? <LeadDetail id={open} manage={manage} onClose={() => setOpen(null)} /> : null}
    </>
  );
}

/** New lead. `initial` prefills it from a WhatsApp conversation. */
export function LeadDialog({ initial, onClose, onCreated }: { initial?: { name?: string; phone?: string; conversationId?: string; source?: (typeof SOURCES)[number] }; onClose: () => void; onCreated: (id: string) => void }) {
  const { t } = useI18n();
  const client = useApiClient();
  const queryClient = useQueryClient();
  const describe = useErrorMessage();
  const [v, setV] = React.useState({ name: initial?.name ?? '', phone: initial?.phone ?? '', email: '', source: initial?.source ?? ('WALK_IN' as (typeof SOURCES)[number]), serviceId: '', interest: '', estimatedValue: '', nextFollowUpAt: '' });
  const set = (patch: Partial<typeof v>) => setV((x) => ({ ...x, ...patch }));
  const create = useMutation({
    mutationFn: () =>
      client.post<{ id: string }>('/leads', {
        name: v.name,
        phone: v.phone || null,
        email: v.email || null,
        source: v.source,
        serviceId: v.serviceId || null,
        interest: v.interest || null,
        estimatedValue: v.estimatedValue || null,
        nextFollowUpAt: v.nextFollowUpAt ? new Date(v.nextFollowUpAt).toISOString() : null,
        conversationId: initial?.conversationId ?? null,
      }),
    onSuccess: (l) => {
      void queryClient.invalidateQueries({ queryKey: KEY });
      void queryClient.invalidateQueries({ queryKey: ['inbox'] });
      onCreated(l.id);
    },
  });
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{t('leads.new')}</DialogTitle>
          <DialogDescription>{t('leads.newText')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="ld-name">{t('leads.fields.name')}</Label>
            <Input id="ld-name" value={v.name} onChange={(e) => set({ name: e.target.value })} maxLength={160} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="ld-phone">{t('leads.fields.phone')}</Label>
              <Input id="ld-phone" dir="ltr" value={v.phone} onChange={(e) => set({ phone: e.target.value })} placeholder="+9715…" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ld-email">{t('leads.fields.email')}</Label>
              <Input id="ld-email" dir="ltr" type="email" value={v.email} onChange={(e) => set({ email: e.target.value })} />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="ld-source">{t('leads.fields.source')}</Label>
              <Select id="ld-source" value={v.source} onValueChange={(x) => set({ source: x as (typeof SOURCES)[number] })} options={SOURCES.map((s) => ({ value: s, label: t(`leads.sources.${s}`) }))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ld-value">{t('leads.fields.estimatedValue')}</Label>
              <MoneyInput id="ld-value" value={v.estimatedValue} onChange={(x) => set({ estimatedValue: x })} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ld-service">{t('leads.fields.service')}</Label>
            <ServicePicker id="ld-service" value={v.serviceId || null} onChange={(x) => set({ serviceId: x })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ld-interest">{t('leads.fields.interest')}</Label>
            <Textarea id="ld-interest" rows={2} value={v.interest} onChange={(e) => set({ interest: e.target.value })} maxLength={1000} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ld-follow">{t('leads.fields.nextFollowUpAt')}</Label>
            <Input id="ld-follow" type="datetime-local" value={v.nextFollowUpAt} onChange={(e) => set({ nextFollowUpAt: e.target.value })} />
          </div>
          {create.error ? <Alert tone="danger">{describe(create.error)}</Alert> : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => create.mutate()} loading={create.isPending} disabled={v.name.trim().length < 2 || !(v.phone.trim() || v.email.trim())}>
            {t('leads.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LeadDetail({ id, manage, onClose }: { id: string; manage: boolean; onClose: () => void }) {
  const { t, pick, formatDateTime, formatMoney } = useI18n();
  const client = useApiClient();
  const queryClient = useQueryClient();
  const toasts = useToast();
  const describe = useErrorMessage();
  const lead = useQuery({ queryKey: [...KEY, 'detail', id], queryFn: () => client.get<Detail>(`/leads/${id}`) });
  const [kind, setKind] = React.useState('CALL');
  const [body, setBody] = React.useState('');
  const [next, setNext] = React.useState('');
  const [panel, setPanel] = React.useState<'lost' | 'won' | null>(null);
  const [reason, setReason] = React.useState('');
  const [customerId, setCustomerId] = React.useState<string | null>(null);
  const [serviceId, setServiceId] = React.useState<string | null>(null);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: KEY });
  const log = useMutation({
    mutationFn: () => client.post(`/leads/${id}/activities`, { kind, body, nextFollowUpAt: next ? new Date(next).toISOString() : undefined }),
    onSuccess: () => {
      setBody('');
      setNext('');
      refresh();
    },
  });
  const status = useMutation({ mutationFn: (s: { status: Status; lostReason?: string }) => client.put(`/leads/${id}/status`, s), onSuccess: () => { setPanel(null); refresh(); } });
  const convert = useMutation({
    mutationFn: () => client.post<{ customerId: string; customer: string; requestId: string | null; requestNo: string | null }>(`/leads/${id}/convert`, { customerId, serviceId: serviceId ?? undefined }),
    onSuccess: (r) => {
      setPanel(null);
      refresh();
      toasts.success(t(`leads.converted.${r.customer}`), r.requestNo ? t('leads.requestOpened', { no: r.requestNo }) : undefined);
    },
  });
  const l = lead.data;
  const error = log.error ?? status.error ?? convert.error;
  const closed = l?.status === 'WON' || l?.status === 'LOST';
  return (
    <Dialog open onOpenChange={(n) => !n && onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {l?.name ?? t('common.loading')}
            {l ? <Badge tone={TONE[l.status]} dot>{t(`leads.statuses.${l.status}`)}</Badge> : null}
          </DialogTitle>
          <DialogDescription>{l ? `${l.leadNo} · ${t(`leads.sources.${l.source}`)}` : ''}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {!l ? (
            <Skeleton className="h-64 w-full" />
          ) : (
            <>
              <dl className="grid gap-3 text-sm sm:grid-cols-3">
                <div>
                  <dt className="text-xs text-muted-foreground">{t('leads.fields.contact')}</dt>
                  <dd className="tabular" dir="ltr">{[l.phone, l.email].filter(Boolean).join(' · ')}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{t('leads.fields.service')}</dt>
                  <dd>{l.service ? pick(l.service.name, l.service.nameAr) : '—'}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{t('leads.fields.estimatedValue')}</dt>
                  <dd className="tabular">{l.estimatedValue ? formatMoney(l.estimatedValue) : '—'}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{t('leads.fields.owner')}</dt>
                  <dd>{l.ownerName ?? '—'}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{t('leads.fields.nextFollowUpAt')}</dt>
                  <dd className={cn(l.followUpDue && 'font-semibold text-destructive')}>{l.nextFollowUpAt ? formatDateTime(l.nextFollowUpAt) : '—'}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{t('leads.result')}</dt>
                  <dd>
                    {l.customer ? (
                      <Link href={`/customers/${l.customer.id}`} className="text-secondary-text hover:underline">
                        {l.customer.fullName}
                      </Link>
                    ) : l.lostReason ? (
                      l.lostReason
                    ) : (
                      '—'
                    )}
                    {l.request ? (
                      <Link href={`/requests/${l.request.id}`} className="ms-2 text-secondary-text hover:underline">
                        {l.request.requestNo}
                      </Link>
                    ) : null}
                  </dd>
                </div>
              </dl>
              {l.interest ? <p className="rounded-md bg-muted/50 px-3 py-2 text-sm">{l.interest}</p> : null}
              {manage && !closed ? (
                <Card className="space-y-2 p-3">
                  <div className="flex flex-wrap gap-2">
                    {(['CALL', 'WHATSAPP', 'EMAIL', 'MEETING', 'NOTE'] as const).map((k) => (
                      <Button key={k} size="sm" variant={kind === k ? 'subtle' : 'ghost'} aria-pressed={kind === k} onClick={() => setKind(k)}>
                        {ICON[k]}
                        {t(`leads.kinds.${k}`)}
                      </Button>
                    ))}
                  </div>
                  <Textarea rows={2} value={body} onChange={(e) => setBody(e.target.value)} placeholder={t('leads.activityHint')} aria-label={t('leads.activity')} maxLength={2000} />
                  <div className="flex flex-wrap items-end gap-2">
                    <div className="space-y-1">
                      <Label htmlFor="ld-next" className="text-xs">
                        {t('leads.fields.nextFollowUpAt')}
                      </Label>
                      <Input id="ld-next" type="datetime-local" value={next} onChange={(e) => setNext(e.target.value)} className="h-9" />
                    </div>
                    <Button size="sm" disabled={!body.trim()} loading={log.isPending} onClick={() => log.mutate()}>
                      {t('leads.log')}
                    </Button>
                  </div>
                </Card>
              ) : null}
              {panel === 'lost' ? (
                <Card className="space-y-2 p-3">
                  <Label htmlFor="ld-lost">{t('leads.lostReason')}</Label>
                  <Input id="ld-lost" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
                  <Button size="sm" variant="destructive" disabled={!reason.trim()} loading={status.isPending} onClick={() => status.mutate({ status: 'LOST', lostReason: reason })}>
                    {t('leads.markLost')}
                  </Button>
                </Card>
              ) : null}
              {panel === 'won' ? (
                <Card className="space-y-3 p-3">
                  <p className="text-sm text-muted-foreground">{t('leads.convertText')}</p>
                  <div className="space-y-1.5">
                    <Label htmlFor="ld-cust">{t('leads.existingCustomer')}</Label>
                    <CustomerPicker id="ld-cust" value={customerId} onChange={(x) => setCustomerId(x || null)} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="ld-svc">{t('leads.firstRequest')}</Label>
                    <ServicePicker id="ld-svc" value={serviceId ?? l.service?.id ?? null} onChange={(x) => setServiceId(x || null)} />
                  </div>
                  <Button size="sm" loading={convert.isPending} onClick={() => convert.mutate()}>
                    <Trophy aria-hidden="true" />
                    {t('leads.confirmWon')}
                  </Button>
                </Card>
              ) : null}
              {error ? <Alert tone="danger">{describe(error)}</Alert> : null}
              <section aria-labelledby="ld-log" className="space-y-2">
                <h3 id="ld-log" className="text-sm font-semibold">
                  {t('leads.history')}
                </h3>
                <ol className="space-y-2">
                  {l.activities.map((a) => (
                    <li key={a.id} className="flex gap-3 text-sm">
                      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground" aria-hidden="true">
                        {ICON[a.kind]}
                      </span>
                      <span className="min-w-0">
                        <span className="block whitespace-pre-wrap">{a.body}</span>
                        <span className="block text-xs text-muted-foreground">
                          {t(`leads.kinds.${a.kind}`)} · {a.authorName ?? '—'} · {formatDateTime(a.createdAt)}
                        </span>
                      </span>
                    </li>
                  ))}
                </ol>
              </section>
            </>
          )}
        </DialogBody>
        {l && manage && !closed ? (
          <DialogFooter className="flex-wrap gap-2">
            {l.status === 'NEW' || l.status === 'CONTACTED' ? (
              <Button variant="outline" loading={status.isPending} onClick={() => status.mutate({ status: 'QUOTED' })}>
                {t('leads.markQuoted')}
              </Button>
            ) : null}
            <Button variant="ghost" onClick={() => setPanel(panel === 'lost' ? null : 'lost')}>
              <XCircle aria-hidden="true" />
              {t('leads.lost')}
            </Button>
            <Button onClick={() => setPanel(panel === 'won' ? null : 'won')}>
              <Trophy aria-hidden="true" />
              {t('leads.wonButton')}
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

