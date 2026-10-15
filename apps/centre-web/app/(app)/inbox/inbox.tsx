'use client';

import * as React from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, CheckCheck, Clock, FileText, Image as ImageIcon, Lock, MessageCircle, Plus, Send, StickyNote, TriangleAlert, UserPlus, Zap } from 'lucide-react';
import {
  Alert, Avatar, Badge, Button, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuTrigger, EmptyState, Input, Label, PageHeader, SearchInput, Select, Skeleton, Tabs, TabsList, TabsTrigger, Textarea, cn, useApiClient, useErrorMessage, useI18n,
  useSession, useToast,
} from '@typease/ui';
import { CustomerPicker, DocumentTypePicker, ServicePicker, useStaffOptions } from '@/components/pickers';
import { useRouter } from 'next/navigation';
import { LeadDialog } from '../leads/leads';

type Status = 'OPEN' | 'PENDING' | 'CLOSED';
interface Conversation {
  id: string;
  phone: string;
  contactName: string | null;
  customer: { id: string; fullName: string; customerNo: string } | null;
  status: Status;
  assignedToId: string | null;
  assigneeName: string | null;
  unreadCount: number;
  lastMessageAt: string | null;
  lastPreview: string | null;
  windowOpen: boolean;
}
interface Message {
  id: string;
  direction: 'IN' | 'OUT' | 'NOTE';
  kind: string;
  body: string | null;
  status: string;
  error: string | null;
  documentId: string | null;
  mediaName: string | null;
  authorName: string | null;
  createdAt: string;
}
interface Detail extends Conversation {
  windowClosesAt: string | null;
  lead: { id: string; leadNo: string; status: string } | null;
  messages: Message[];
  requests: Array<{ id: string; requestNo: string; status: string; serviceName: string | null }>;
}
const KEY = ['inbox'] as const;
type Filter = 'open' | 'mine' | 'unassigned' | 'closed';

export function Inbox() {
  const { t } = useI18n();
  const client = useApiClient();
  const [filter, setFilter] = React.useState<Filter>('open');
  const [q, setQ] = React.useState('');
  const [selected, setSelected] = React.useState<string | null>(null);
  const [simulating, setSimulating] = React.useState(false);
  const list = useQuery({
    queryKey: [...KEY, 'list', filter, q],
    queryFn: () =>
      client.get<{ data: Conversation[]; unreadTotal: number; sandbox: boolean }>('/inbox/conversations', {
        query: { pageSize: 100, ...(filter === 'closed' ? { status: 'CLOSED' } : {}), ...(filter === 'mine' ? { mine: true } : {}), ...(filter === 'unassigned' ? { unassigned: true } : {}), ...(q.trim() ? { q: q.trim() } : {}) },
      }),
    refetchInterval: 5_000,
  });
  const rows = (list.data?.data ?? []).filter((c) => filter === 'closed' || c.status !== 'CLOSED');
  React.useEffect(() => {
    if (!selected && rows[0]) setSelected(rows[0].id);
  }, [rows, selected]);
  return (
    <>
      <PageHeader
        title={t('inbox.title')}
        description={t('inbox.description')}
        action={
          list.data?.sandbox ? (
            <Button variant="outline" onClick={() => setSimulating(true)}>
              <Zap aria-hidden="true" />
              {t('inbox.simulate')}
            </Button>
          ) : undefined
        }
      />
      <div className="grid h-[calc(100dvh-13rem)] min-h-[32rem] overflow-hidden rounded-xl border bg-card lg:grid-cols-[22rem_1fr]">
        <aside className={cn('flex min-h-0 flex-col border-e', selected && 'hidden lg:flex')}>
          <div className="space-y-2 border-b p-3">
            <SearchInput value={q} onChange={setQ} placeholder={t('inbox.search')} aria-label={t('inbox.search')} />
            <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)}>
              <TabsList className="w-full">
                {(['open', 'mine', 'unassigned', 'closed'] as const).map((f) => (
                  <TabsTrigger key={f} value={f} className="flex-1 text-xs">
                    {t(`inbox.filters.${f}`)}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>
          <ul className="min-h-0 flex-1 divide-y overflow-y-auto" aria-label={t('inbox.title')}>
            {!list.data ? (
              <li className="p-3">
                <Skeleton className="h-40 w-full" />
              </li>
            ) : rows.length === 0 ? (
              <li className="p-6 text-center text-sm text-muted-foreground">{t('inbox.emptyList')}</li>
            ) : (
              rows.map((c) => <ConversationRow key={c.id} c={c} active={c.id === selected} onSelect={() => setSelected(c.id)} />)
            )}
          </ul>
        </aside>
        <section className={cn('min-h-0', !selected && 'hidden lg:block')}>
          {selected ? <Thread key={selected} id={selected} onBack={() => setSelected(null)} /> : <EmptyState icon={<MessageCircle />} title={t('inbox.pick')} description={t('inbox.pickText')} />}
        </section>
      </div>
      {simulating ? <SimulateDialog onClose={() => setSimulating(false)} /> : null}
    </>
  );
}

function ConversationRow({ c, active, onSelect }: { c: Conversation; active: boolean; onSelect: () => void }) {
  const { formatRelative } = useI18n();
  const name = c.customer?.fullName ?? c.contactName ?? c.phone;
  return (
    <li>
      <button type="button" onClick={onSelect} aria-current={active ? 'true' : undefined} className={cn('flex w-full items-start gap-3 px-3 py-3 text-start hover:bg-muted/50', active && 'bg-secondary-soft/50')}>
        <Avatar name={name} size="sm" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center justify-between gap-2">
            <span className={cn('truncate text-sm', c.unreadCount ? 'font-semibold' : 'font-medium')}>{name}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{c.lastMessageAt ? formatRelative(c.lastMessageAt) : ''}</span>
          </span>
          <span className="flex items-center justify-between gap-2">
            <span className="truncate text-xs text-muted-foreground">{c.lastPreview}</span>
            {c.unreadCount ? (
              <Badge tone="success" className="h-5 min-w-5 justify-center px-1.5">
                {c.unreadCount}
              </Badge>
            ) : null}
          </span>
          {c.assigneeName ? <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">→ {c.assigneeName}</span> : null}
        </span>
      </button>
    </li>
  );
}

function Thread({ id, onBack }: { id: string; onBack: () => void }) {
  const { t, formatDateTime, formatTime } = useI18n();
  const client = useApiClient();
  const queryClient = useQueryClient();
  const toasts = useToast();
  const describe = useErrorMessage();
  const session = useSession();
  const staff = useStaffOptions();
  const detail = useQuery({ queryKey: [...KEY, 'thread', id], queryFn: () => client.get<Detail>(`/inbox/conversations/${id}`), refetchInterval: 5_000 });
  const quick = useQuery({ queryKey: [...KEY, 'quick'], queryFn: () => client.get<{ replies: Array<{ title: string; body: string }> }>('/inbox/quick-replies') });
  const [text, setText] = React.useState('');
  const [mode, setMode] = React.useState<'reply' | 'note'>('reply');
  const [linking, setLinking] = React.useState(false);
  const [intake, setIntake] = React.useState<Message | null>(null);
  const [leading, setLeading] = React.useState(false);
  const end = React.useRef<HTMLDivElement>(null);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: KEY });
  const send = useMutation({
    mutationFn: () => client.post<Message>(`/inbox/conversations/${id}/${mode === 'reply' ? 'reply' : 'notes'}`, { text }),
    onSuccess: (m) => {
      setText('');
      if (m.status === 'FAILED') toasts.error(m.error ?? t('inbox.failed'));
      refresh();
    },
  });
  const put = useMutation({ mutationFn: ({ path, body }: { path: string; body: unknown }) => client.put(`/inbox/conversations/${id}/${path}`, body), onSuccess: refresh, onError: (e) => toasts.error(e) });
  const openFile = async (documentId: string) => {
    try {
      const link = await client.post<{ url: string }>(`/documents/${documentId}/preview-link`);
      window.open(link.url, '_blank', 'noopener');
    } catch (e) {
      toasts.error(e);
    }
  };
  const d = detail.data;
  React.useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [d?.messages.length]);
  if (!d) return <Skeleton className="m-4 h-96" />;
  const name = d.customer?.fullName ?? d.contactName ?? d.phone;
  const canReply = session.hasAnyPermission(['inbox.reply', 'inbox.manage']);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
        <Button variant="ghost" size="sm" className="lg:hidden" onClick={onBack}>
          ←
        </Button>
        <Avatar name={name} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{name}</p>
          <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="tabular" dir="ltr">
              {d.phone}
            </span>
            {d.customer ? (
              <Link href={`/customers/${d.customer.id}`} className="text-secondary-text hover:underline">
                {d.customer.customerNo}
              </Link>
            ) : canReply ? (
              <button type="button" className="inline-flex items-center gap-1 text-secondary-text hover:underline" onClick={() => setLinking(true)}>
                <UserPlus aria-hidden="true" className="size-3.5" />
                {t('inbox.linkCustomer')}
              </button>
            ) : null}
          </p>
        </div>
        {canReply ? (
          <>
            <Select
              size="sm"
              className="w-44"
              aria-label={t('inbox.assignee')}
              value={d.assignedToId ?? '__none__'}
              onValueChange={(v) => put.mutate({ path: 'assignee', body: { membershipId: v === '__none__' ? null : v } })}
              options={[{ value: '__none__', label: t('inbox.unassigned') }, ...(staff.data ?? []).map((s) => ({ value: s.id, label: s.user.fullName }))]}
            />
            <Select
              size="sm"
              className="w-32"
              aria-label={t('inbox.status')}
              value={d.status}
              onValueChange={(v) => put.mutate({ path: 'status', body: { status: v } })}
              options={(['OPEN', 'PENDING', 'CLOSED'] as const).map((s) => ({ value: s, label: t(`inbox.statuses.${s}`) }))}
            />
          </>
        ) : null}
      </header>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 flex-1 flex-col bg-[linear-gradient(0deg,rgba(0,0,0,0.015),rgba(0,0,0,0.015))]">
          <ol className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-4">
            {d.messages.map((m) => (
              <li key={m.id} className={cn('flex', m.direction === 'IN' ? 'justify-start' : 'justify-end')}>
                <div
                  className={cn(
                    'max-w-[78%] rounded-2xl px-3.5 py-2 text-sm shadow-xs',
                    m.direction === 'IN' && 'rounded-ss-sm border bg-card',
                    m.direction === 'OUT' && 'rounded-se-sm bg-[#D9FDD3] text-gray-900 dark:bg-emerald-900/60 dark:text-emerald-50',
                    m.direction === 'NOTE' && 'rounded-se-sm border border-warning/40 bg-warning-soft/60',
                  )}
                >
                  {m.direction === 'NOTE' ? (
                    <span className="mb-0.5 flex items-center gap-1 text-[11px] font-semibold text-warning-text">
                      <Lock aria-hidden="true" className="size-3" />
                      {t('inbox.note')} · {m.authorName}
                    </span>
                  ) : m.direction === 'OUT' && m.authorName ? (
                    <span className="mb-0.5 block text-[11px] font-semibold text-emerald-800 dark:text-emerald-200">{m.authorName}</span>
                  ) : null}
                  {m.documentId ? (
                    <button type="button" onClick={() => void openFile(m.documentId!)} className="mb-1 flex items-center gap-2 rounded-lg border bg-background/70 px-2.5 py-2 text-start hover:bg-background">
                      {m.kind === 'IMAGE' ? <ImageIcon aria-hidden="true" className="size-5 text-secondary-text" /> : <FileText aria-hidden="true" className="size-5 text-secondary-text" />}
                      <span className="min-w-0">
                        <span className="block truncate text-xs font-medium">{m.mediaName ?? t(`inbox.kinds.${m.kind}`)}</span>
                        <span className="block text-[11px] text-muted-foreground">{t('inbox.savedToVault')}</span>
                      </span>
                    </button>
                  ) : null}
                  {m.documentId && m.direction === 'IN' && d.customer && session.hasPermission('request.create') ? (
                    <button type="button" onClick={() => setIntake(m)} className="mb-1 flex items-center gap-1 text-xs font-medium text-secondary-text hover:underline">
                      <Plus aria-hidden="true" className="size-3.5" />
                      {t('inbox.startRequest')}
                    </button>
                  ) : m.kind !== 'TEXT' && m.direction === 'IN' && !m.documentId ? (
                    <span className="mb-1 block text-xs italic text-muted-foreground">[{t(`inbox.kinds.${m.kind}`)}]</span>
                  ) : null}
                  {m.body ? <p className="whitespace-pre-wrap break-words">{m.body}</p> : null}
                  {m.error ? (
                    <p className="mt-1 flex items-center gap-1 text-[11px] text-destructive">
                      <TriangleAlert aria-hidden="true" className="size-3" />
                      {m.error}
                    </p>
                  ) : null}
                  <span className="mt-0.5 flex items-center justify-end gap-1 text-[10px] text-muted-foreground" title={formatDateTime(m.createdAt)}>
                    {formatTime(m.createdAt)}
                    {m.direction === 'OUT' ? <Tick status={m.status} /> : null}
                  </span>
                </div>
              </li>
            ))}
            <div ref={end} />
          </ol>
          {canReply ? (
            <div className="space-y-2 border-t bg-card p-3">
              {!d.windowOpen && mode === 'reply' ? <Alert tone="warning">{t('inbox.windowClosed')}</Alert> : null}
              <div className="flex items-center gap-2">
                <Tabs value={mode} onValueChange={(v) => setMode(v as 'reply' | 'note')}>
                  <TabsList>
                    <TabsTrigger value="reply">{t('inbox.reply')}</TabsTrigger>
                    <TabsTrigger value="note">
                      <StickyNote aria-hidden="true" className="size-3.5" />
                      {t('inbox.note')}
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
                {d.windowOpen && d.windowClosesAt && mode === 'reply' ? (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock aria-hidden="true" className="size-3.5" />
                    {t('inbox.windowUntil', { time: formatDateTime(d.windowClosesAt) })}
                  </span>
                ) : null}
                <span className="flex-1" />
                {quick.data?.replies.length ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="sm">
                        <Zap aria-hidden="true" />
                        {t('inbox.quick')}
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="max-w-xs">
                      <DropdownMenuLabel>{t('inbox.quick')}</DropdownMenuLabel>
                      {quick.data.replies.map((r) => (
                        <DropdownMenuItem key={r.title} onSelect={() => setText((x) => (x ? `${x}\n${r.body}` : r.body))}>
                          {r.title}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
              </div>
              <div className="flex items-end gap-2">
                <Textarea
                  rows={2}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && text.trim()) {
                      e.preventDefault();
                      send.mutate();
                    }
                  }}
                  placeholder={mode === 'reply' ? t('inbox.replyPlaceholder') : t('inbox.notePlaceholder')}
                  aria-label={mode === 'reply' ? t('inbox.reply') : t('inbox.note')}
                  className={cn('min-h-[2.75rem] flex-1 resize-none', mode === 'note' && 'border-warning/50 bg-warning-soft/30')}
                  disabled={mode === 'reply' && !d.windowOpen}
                />
                <Button size="icon" aria-label={t('inbox.send')} disabled={!text.trim() || (mode === 'reply' && !d.windowOpen)} loading={send.isPending} onClick={() => send.mutate()}>
                  {mode === 'reply' ? <Send aria-hidden="true" /> : <StickyNote aria-hidden="true" />}
                </Button>
              </div>
              {send.error ? <Alert tone="danger">{describe(send.error)}</Alert> : null}
            </div>
          ) : null}
        </div>
        <aside className="hidden w-64 shrink-0 space-y-4 overflow-y-auto border-s p-4 xl:block">
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('inbox.customer')}</h3>
            {d.customer ? (
              <Link href={`/customers/${d.customer.id}`} className="mt-1 block font-medium hover:underline">
                {d.customer.fullName}
              </Link>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">{t('inbox.unknown')}</p>
            )}
          </div>
          <div className="space-y-1.5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('inbox.lead')}</h3>
            {d.lead ? (
              <Link href="/leads" className="block text-sm text-secondary-text hover:underline">
                {d.lead.leadNo} · {t(`leads.statuses.${d.lead.status}`)}
              </Link>
            ) : session.hasPermission('lead.manage') ? (
              <Button variant="outline" size="sm" className="w-full" onClick={() => setLeading(true)}>
                <Plus aria-hidden="true" />
                {t('inbox.createLead')}
              </Button>
            ) : (
              <p className="text-sm text-muted-foreground">—</p>
            )}
          </div>
          {d.customer ? (
            <div className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('inbox.requests')}</h3>
              {d.requests.length ? (
                <ul className="space-y-1.5 text-sm">
                  {d.requests.map((r) => (
                    <li key={r.id}>
                      <Link href={`/requests/${r.id}`} className="block rounded-md border px-2.5 py-1.5 hover:bg-muted/50">
                        <span className="block font-medium tabular">{r.requestNo}</span>
                        <span className="block truncate text-xs text-muted-foreground">{r.serviceName}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">{t('inbox.noRequests')}</p>
              )}
              <Button variant="outline" size="sm" className="w-full" asChild>
                <Link href={`/requests/new?customerId=${d.customer.id}`}>
                  <Plus aria-hidden="true" />
                  {t('inbox.newRequest')}
                </Link>
              </Button>
            </div>
          ) : null}
        </aside>
      </div>
      {linking ? <LinkCustomerDialog id={id} onClose={() => setLinking(false)} /> : null}
      {intake ? <IntakeDialog message={intake} onClose={() => setIntake(null)} /> : null}
      {leading ? <LeadDialog initial={{ name: d.customer?.fullName ?? d.contactName ?? '', phone: d.phone, conversationId: id, source: 'WHATSAPP' }} onClose={() => setLeading(false)} onCreated={() => setLeading(false)} /> : null}
    </div>
  );
}

function Tick({ status }: { status: string }) {
  if (status === 'READ') return <CheckCheck aria-label="read" className="size-3.5 text-sky-500" />;
  if (status === 'DELIVERED') return <CheckCheck aria-label="delivered" className="size-3.5" />;
  if (status === 'SENT') return <Check aria-label="sent" className="size-3.5" />;
  if (status === 'FAILED') return <TriangleAlert aria-label="failed" className="size-3.5 text-destructive" />;
  return <Clock aria-label="sending" className="size-3" />;
}

function LinkCustomerDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useI18n();
  const client = useApiClient();
  const queryClient = useQueryClient();
  const [customerId, setCustomerId] = React.useState<string | null>(null);
  const link = useMutation({
    mutationFn: () => client.put(`/inbox/conversations/${id}/customer`, { customerId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: KEY });
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{t('inbox.linkCustomer')}</DialogTitle>
          <DialogDescription>{t('inbox.linkText')}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <CustomerPicker value={customerId} onChange={(v) => setCustomerId(v || null)} />
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button disabled={!customerId} loading={link.isPending} onClick={() => link.mutate()}>
            {t('inbox.link')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Development sandbox: write as the customer would on WhatsApp. */
function SimulateDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const client = useApiClient();
  const queryClient = useQueryClient();
  const describe = useErrorMessage();
  const [phone, setPhone] = React.useState('+9715');
  const [name, setName] = React.useState('');
  const [text, setText] = React.useState('');
  const [media, setMedia] = React.useState<{ data: string; name: string } | null>(null);
  const sim = useMutation({
    mutationFn: () => client.post('/inbox/simulate', { phone, name: name || undefined, text: text || undefined, ...(media ? { media: media.data, mediaName: media.name } : {}) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: KEY });
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{t('inbox.simulate')}</DialogTitle>
          <DialogDescription>{t('inbox.simulateText')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="sim-phone">{t('inbox.phone')}</Label>
              <Input id="sim-phone" dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sim-name">{t('inbox.name')}</Label>
              <Input id="sim-name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sim-text">{t('inbox.message')}</Label>
            <Textarea id="sim-text" rows={3} value={text} onChange={(e) => setText(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sim-file">{t('inbox.attach')}</Label>
            <Input
              id="sim-file"
              type="file"
              accept="image/png,image/jpeg,application/pdf"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return setMedia(null);
                const reader = new FileReader();
                reader.onload = () => setMedia({ data: String(reader.result), name: file.name });
                reader.readAsDataURL(file);
              }}
            />
          </div>
          {sim.error ? <Alert tone="danger">{describe(sim.error)}</Alert> : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button disabled={!(text.trim() || media)} loading={sim.isPending} onClick={() => sim.mutate()}>
            {t('inbox.send')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const KNOWN_WARNINGS = ['NO_MATCHING_CHECKLIST_LINE', 'DOCUMENT_NOT_AVAILABLE', 'INTEGRATION_NOT_CONFIGURED', 'AI_CONSENT_WITHDRAWN', 'OCR_UNSUPPORTED_FILE'];

/** WhatsApp intake: the photo or PDF becomes a draft request, filed on its checklist line and read by OCR. */
function IntakeDialog({ message, onClose }: { message: Message; onClose: () => void }) {
  const { t } = useI18n();
  const client = useApiClient();
  const queryClient = useQueryClient();
  const toasts = useToast();
  const describe = useErrorMessage();
  const router = useRouter();
  const [serviceId, setServiceId] = React.useState<string | null>(null);
  const [typeKey, setTypeKey] = React.useState<string | null>(message.kind === 'IMAGE' ? 'passport' : null);
  const [runOcr, setRunOcr] = React.useState(true);
  const start = useMutation({
    mutationFn: () => client.post<{ requestId: string; requestNo: string; linked: boolean; warnings: string[] }>(`/inbox/messages/${message.id}/intake`, { serviceId, documentTypeKey: typeKey, runOcr }),
    onSuccess: (r) => {
      void queryClient.invalidateQueries({ queryKey: KEY });
      toasts.success(t('inbox.intakeDone', { no: r.requestNo }), r.warnings.length ? r.warnings.map((w) => (KNOWN_WARNINGS.includes(w) ? t(`inbox.intakeWarnings.${w}`) : w)).join(' ') : undefined);
      router.push(`/requests/${r.requestId}`);
    },
  });
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{t('inbox.startRequest')}</DialogTitle>
          <DialogDescription>{t('inbox.intakeText')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="intake-service">{t('inbox.service')}</Label>
            <ServicePicker id="intake-service" value={serviceId} onChange={(v) => setServiceId(v || null)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="intake-type">{t('inbox.fileIs')}</Label>
            <DocumentTypePicker id="intake-type" value={typeKey} onChange={(v) => setTypeKey(v || null)} />
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={runOcr} onChange={(e) => setRunOcr(e.target.checked)} />
            <span>
              {t('inbox.runOcr')}
              <span className="block text-xs text-muted-foreground">{t('inbox.ocrCaveat')}</span>
            </span>
          </label>
          {start.error ? <Alert tone="danger">{describe(start.error)}</Alert> : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button disabled={!serviceId || !typeKey} loading={start.isPending} onClick={() => start.mutate()}>
            {t('inbox.createDraft')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
