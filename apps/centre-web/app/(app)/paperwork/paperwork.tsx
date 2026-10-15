'use client';

import * as React from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Copy, FileSignature, FileText, Handshake, PenLine, Plus, Printer, Send, Trash2 } from 'lucide-react';
import type { Page } from '@typease/types';
import {
  Alert, Badge, Button, Card, Checkbox, DatePicker, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, EmptyState, Input, Label, MoneyInput,
  PageHeader, SearchInput, Select, SignaturePad, Skeleton, Tabs, TabsContent, TabsList, TabsTrigger, Textarea, useApiClient, useErrorMessage, useI18n, useSession, useToast,
} from '@typease/ui';
import { CustomerPicker } from '@/components/pickers';
import { PdfDialog } from '@/components/fin/shared';

type Status = 'DRAFT' | 'ISSUED' | 'SIGNED' | 'HANDED_OVER' | 'VOID';
interface Field {
  key: string;
  label: string;
  labelAr: string | null;
  type: 'text' | 'textarea' | 'date' | 'money' | 'number';
  required: boolean;
}
interface Template {
  id: string;
  key: string;
  kind: string;
  name: string;
  nameAr: string | null;
  titleEn: string;
  titleAr: string | null;
  bodyEn: string;
  bodyAr: string | null;
  fields: Field[];
  requiresSignature: boolean;
  isBuiltIn: boolean;
  isActive: boolean;
  version: number;
}
interface Doc {
  id: string;
  documentNo: string;
  status: Status;
  titleEn: string;
  titleAr: string | null;
  bodyEn: string;
  bodyAr: string | null;
  values: Record<string, string>;
  requiresSignature: boolean;
  customerId: string;
  customer: { fullName: string; customerNo: string } | null;
  template: { name: string; nameAr: string | null; kind: string; fields?: Field[] } | null;
  signerName: string | null;
  signedAt: string | null;
  signedVia: string | null;
  handedOverAt: string | null;
  handedOverTo: string | null;
  voidReason: string | null;
  contentHash: string | null;
  createdAt: string;
  issuedAt: string | null;
}
const KEY = ['paperwork'] as const;
const TONE: Record<Status, 'neutral' | 'info' | 'brand' | 'success' | 'danger'> = { DRAFT: 'neutral', ISSUED: 'info', SIGNED: 'brand', HANDED_OVER: 'success', VOID: 'danger' };
const ALL = '__all__';

export function Paperwork() {
  const { t } = useI18n();
  const session = useSession();
  const [tab, setTab] = React.useState('documents');
  const [creating, setCreating] = React.useState(false);
  const [open, setOpen] = React.useState<string | null>(null);
  return (
    <>
      <PageHeader
        title={t('paperwork.title')}
        description={t('paperwork.description')}
        action={
          session.hasPermission('paperwork.manage') ? (
            <Button variant="accent" onClick={() => setCreating(true)}>
              <Plus aria-hidden="true" />
              {t('paperwork.new')}
            </Button>
          ) : undefined
        }
      />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-4">
          <TabsTrigger value="documents">{t('paperwork.tabs.documents')}</TabsTrigger>
          {session.hasPermission('paperwork.templates') ? <TabsTrigger value="templates">{t('paperwork.tabs.templates')}</TabsTrigger> : null}
        </TabsList>
        <TabsContent value="documents">
          <DocumentList onOpen={setOpen} onCreate={() => setCreating(true)} />
        </TabsContent>
        <TabsContent value="templates">{tab === 'templates' ? <TemplateList /> : null}</TabsContent>
      </Tabs>
      {creating ? (
        <NewDocumentDialog
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            setOpen(id);
          }}
        />
      ) : null}
      {open ? <DocumentDialog id={open} onClose={() => setOpen(null)} /> : null}
    </>
  );
}

function useTemplates(includeInactive = false) {
  const client = useApiClient();
  return useQuery({ queryKey: [...KEY, 'templates', includeInactive], queryFn: () => client.get<Template[]>('/paperwork/templates', { query: includeInactive ? { includeInactive: true } : {} }) });
}

function StatusBadge({ status }: { status: Status }) {
  const { t } = useI18n();
  return (
    <Badge tone={TONE[status]} dot>
      {t(`paperwork.status.${status}`)}
    </Badge>
  );
}

// ---------------------------------------------------------------- list
function DocumentList({ onOpen, onCreate }: { onOpen: (id: string) => void; onCreate: () => void }) {
  const { t, pick, formatDate } = useI18n();
  const client = useApiClient();
  const [status, setStatus] = React.useState(ALL);
  const [q, setQ] = React.useState('');
  const docs = useQuery({
    queryKey: [...KEY, 'documents', status, q],
    queryFn: () => client.get<Page<Doc>>('/paperwork/documents', { query: { pageSize: 100, ...(status !== ALL ? { status } : {}), ...(q.trim() ? { q: q.trim() } : {}) } }),
  });
  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center gap-3 p-4">
        <div className="w-full sm:w-72">
          <SearchInput value={q} onChange={setQ} placeholder={t('paperwork.search')} aria-label={t('paperwork.search')} />
        </div>
        <Select
          className="w-full sm:w-52"
          aria-label={t('paperwork.columns.status')}
          value={status}
          onValueChange={setStatus}
          options={[{ value: ALL, label: t('paperwork.allStatuses') }, ...(['DRAFT', 'ISSUED', 'SIGNED', 'HANDED_OVER', 'VOID'] as const).map((s) => ({ value: s, label: t(`paperwork.status.${s}`) }))]}
        />
      </Card>
      {!docs.data ? (
        <Skeleton className="h-64 w-full" />
      ) : docs.data.data.length === 0 ? (
        <EmptyState
          icon={<FileSignature />}
          title={t('paperwork.empty')}
          description={t('paperwork.emptyText')}
          action={
            <Button onClick={onCreate}>
              <Plus aria-hidden="true" />
              {t('paperwork.new')}
            </Button>
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full text-sm">
            <caption className="sr-only">{t('paperwork.title')}</caption>
            <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                {['document', 'customer', 'status', 'created'].map((c) => (
                  <th key={c} scope="col" className="px-3 py-2.5 text-start font-medium">
                    {t(`paperwork.columns.${c}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {docs.data.data.map((d) => (
                <tr key={d.id} className="cursor-pointer hover:bg-muted/30" onClick={() => onOpen(d.id)}>
                  <td className="px-3 py-2.5">
                    <button type="button" className="text-start font-medium hover:underline" onClick={() => onOpen(d.id)}>
                      {pick(d.titleEn, d.titleAr)}
                    </button>
                    <span className="block text-xs text-muted-foreground tabular">{d.documentNo}</span>
                  </td>
                  <td className="px-3 py-2.5">
                    <Link href={`/customers/${d.customerId}`} onClick={(e) => e.stopPropagation()} className="hover:underline">
                      {d.customer?.fullName}
                    </Link>
                  </td>
                  <td className="px-3 py-2.5">
                    <StatusBadge status={d.status} />
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 tabular">{formatDate(d.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- fields form (shared by new and draft edit)
function FieldsForm({ fields, values, onChange }: { fields: Field[]; values: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  const { pick } = useI18n();
  const set = (key: string, value: string) => onChange({ ...values, [key]: value });
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {fields.map((f) => (
        <div key={f.key} className={f.type === 'textarea' ? 'space-y-1.5 sm:col-span-2' : 'space-y-1.5'}>
          <Label htmlFor={`pf-${f.key}`}>
            {pick(f.label, f.labelAr)}
            {f.required ? <span className="text-destructive"> *</span> : null}
          </Label>
          {f.type === 'textarea' ? (
            <Textarea id={`pf-${f.key}`} rows={2} value={values[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)} maxLength={2000} />
          ) : f.type === 'date' ? (
            <DatePicker id={`pf-${f.key}`} value={values[f.key] ?? ''} onChange={(v) => set(f.key, v)} />
          ) : f.type === 'money' ? (
            <MoneyInput id={`pf-${f.key}`} value={values[f.key] ?? ''} onChange={(v) => set(f.key, v)} />
          ) : (
            <Input id={`pf-${f.key}`} inputMode={f.type === 'number' ? 'numeric' : undefined} value={values[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)} maxLength={300} />
          )}
        </div>
      ))}
    </div>
  );
}

function NewDocumentDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { t, pick } = useI18n();
  const client = useApiClient();
  const queryClient = useQueryClient();
  const describe = useErrorMessage();
  const templates = useTemplates();
  const [templateId, setTemplateId] = React.useState<string | null>(null);
  const [customerId, setCustomerId] = React.useState<string | null>(null);
  const [customerLabel, setCustomerLabel] = React.useState<string | null>(null);
  const [values, setValues] = React.useState<Record<string, string>>({});
  const template = templates.data?.find((x) => x.id === templateId) ?? null;
  const create = useMutation({
    mutationFn: () => client.post<Doc>('/paperwork/documents', { templateId, customerId, values }),
    onSuccess: (d) => {
      void queryClient.invalidateQueries({ queryKey: KEY });
      onCreated(d.id);
    },
  });
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{t('paperwork.new')}</DialogTitle>
          <DialogDescription>{t('paperwork.newText')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-5">
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t('paperwork.chooseTemplate')}</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {(templates.data ?? []).map((x) => (
                <button
                  key={x.id}
                  type="button"
                  aria-pressed={templateId === x.id}
                  onClick={() => {
                    setTemplateId(x.id);
                    setValues({});
                  }}
                  className={`flex items-start gap-3 rounded-lg border p-3 text-start transition hover:border-secondary/60 ${templateId === x.id ? 'border-secondary bg-secondary-soft/40 ring-1 ring-secondary' : ''}`}
                >
                  <FileText aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-secondary-text" />
                  <span className="min-w-0">
                    <span className="block font-medium">{pick(x.name, x.nameAr)}</span>
                    <span className="block text-xs text-muted-foreground">{x.requiresSignature ? t('paperwork.needsSignature') : t('paperwork.noSignature')}</span>
                  </span>
                </button>
              ))}
            </div>
          </fieldset>
          <div className="space-y-1.5">
            <Label htmlFor="pw-customer">{t('paperwork.customer')}</Label>
            <CustomerPicker
              id="pw-customer"
              value={customerId}
              selectedLabel={customerLabel}
              onChange={(id, c) => {
                setCustomerId(id || null);
                setCustomerLabel(c?.fullName ?? null);
              }}
            />
            <p className="text-xs text-muted-foreground">{t('paperwork.fromRecord')}</p>
          </div>
          {template ? <FieldsForm fields={template.fields} values={values} onChange={setValues} /> : null}
          {create.error ? <Alert tone="danger">{describe(create.error)}</Alert> : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => create.mutate()} loading={create.isPending} disabled={!templateId || !customerId}>
            {t('paperwork.createDraft')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- one document
function DocumentDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { t, pick, formatDateTime } = useI18n();
  const client = useApiClient();
  const queryClient = useQueryClient();
  const toasts = useToast();
  const describe = useErrorMessage();
  const session = useSession();
  const manage = session.hasPermission('paperwork.manage');
  const doc = useQuery({ queryKey: [...KEY, 'document', id], queryFn: () => client.get<Doc>(`/paperwork/documents/${id}`) });
  const [lang, setLang] = React.useState<'en' | 'ar'>('en');
  const [values, setValues] = React.useState<Record<string, string> | null>(null);
  const [panel, setPanel] = React.useState<'sign' | 'handover' | 'void' | null>(null);
  const [pdf, setPdf] = React.useState(false);
  const [signer, setSigner] = React.useState('');
  const [signature, setSignature] = React.useState<string | null>(null);
  const [agree, setAgree] = React.useState(false);
  const [to, setTo] = React.useState('');
  const [note, setNote] = React.useState('');
  const refresh = (d?: Doc) => {
    if (d) queryClient.setQueryData([...KEY, 'document', id], d);
    void queryClient.invalidateQueries({ queryKey: [...KEY, 'documents'] });
    setPanel(null);
  };
  const act = useMutation({
    mutationFn: ({ path, body, method = 'post' }: { path: string; body?: unknown; method?: 'post' | 'patch' | 'delete' }) =>
      method === 'patch' ? client.patch<Doc>(`/paperwork/documents/${id}${path}`, body) : method === 'delete' ? client.delete<Doc>(`/paperwork/documents/${id}`) : client.post<Doc>(`/paperwork/documents/${id}${path}`, body),
    onSuccess: (d, v) => {
      if (v.method === 'delete') {
        void queryClient.invalidateQueries({ queryKey: KEY });
        onClose();
        return;
      }
      setValues(null);
      refresh(d);
    },
  });
  const copyLink = async () => {
    const { link } = await client.get<{ link: string }>(`/paperwork/documents/${id}/sign-link`);
    await navigator.clipboard.writeText(link).catch(() => undefined);
    toasts.success(t('paperwork.linkCopied'));
  };
  const d = doc.data;
  const editing = d?.status === 'DRAFT' && manage;
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {d ? pick(d.titleEn, d.titleAr) : t('common.loading')}
            {d ? <StatusBadge status={d.status} /> : null}
          </DialogTitle>
          <DialogDescription>{d ? `${d.documentNo} · ${d.customer?.fullName ?? ''}` : ''}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {!d ? (
            <Skeleton className="h-80 w-full" />
          ) : (
            <>
              {editing && d.template?.fields?.length ? (
                <details className="rounded-lg border p-3" open={values !== null}>
                  <summary className="cursor-pointer text-sm font-medium">{t('paperwork.editFields')}</summary>
                  <div className="mt-3 space-y-3">
                    <FieldsForm fields={d.template.fields} values={values ?? d.values} onChange={setValues} />
                    <Button size="sm" variant="outline" disabled={!values} loading={act.isPending} onClick={() => act.mutate({ path: '', body: { values }, method: 'patch' })}>
                      {t('paperwork.updatePreview')}
                    </Button>
                  </div>
                </details>
              ) : null}
              <div className="flex items-center justify-between gap-2">
                <Tabs value={lang} onValueChange={(v) => setLang(v as 'en' | 'ar')}>
                  <TabsList>
                    <TabsTrigger value="en">English</TabsTrigger>
                    <TabsTrigger value="ar" disabled={!d.bodyAr}>
                      العربية
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
                <Button variant="outline" size="sm" onClick={() => setPdf(true)}>
                  <Printer aria-hidden="true" />
                  {t('paperwork.pdf')}
                </Button>
              </div>
              <article dir={lang === 'ar' ? 'rtl' : 'ltr'} lang={lang} className="max-h-[22rem] overflow-y-auto whitespace-pre-wrap rounded-lg border bg-white p-6 text-[0.95rem] leading-relaxed text-gray-900 shadow-inner">
                <h3 className="mb-4 text-center text-lg font-semibold">{lang === 'ar' ? d.titleAr : d.titleEn}</h3>
                {lang === 'ar' ? d.bodyAr : d.bodyEn}
              </article>
              {d.status === 'DRAFT' && /_{6,}/.test(d.bodyEn) ? <Alert tone="warning">{t('paperwork.blanks')}</Alert> : null}

              <Timeline doc={d} formatDateTime={formatDateTime} />

              {panel === 'sign' ? (
                <Card className="space-y-3 p-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="pw-signer">{t('paperwork.signerName')}</Label>
                    <Input id="pw-signer" value={signer} onChange={(e) => setSigner(e.target.value)} placeholder={d.customer?.fullName} maxLength={120} />
                  </div>
                  <SignaturePad label={t('paperwork.signHere')} clearLabel={t('paperwork.clear')} onChange={setSignature} hint={t('paperwork.signHint')} />
                  <label className="flex items-start gap-2 text-sm">
                    <Checkbox checked={agree} onCheckedChange={(v) => setAgree(v === true)} />
                    {t('paperwork.agree')}
                  </label>
                  <Button disabled={!signer.trim() || !signature || !agree} loading={act.isPending} onClick={() => act.mutate({ path: '/sign', body: { signerName: signer, signatureImage: signature, agree: true } })}>
                    <PenLine aria-hidden="true" />
                    {t('paperwork.confirmSign')}
                  </Button>
                </Card>
              ) : null}
              {panel === 'handover' ? (
                <Card className="space-y-3 p-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="pw-to">{t('paperwork.handedOverTo')}</Label>
                    <Input id="pw-to" value={to} onChange={(e) => setTo(e.target.value)} placeholder={d.customer?.fullName} maxLength={120} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="pw-note">{t('paperwork.note')}</Label>
                    <Input id="pw-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('paperwork.noteHint')} maxLength={500} />
                  </div>
                  <Button disabled={to.trim().length < 2} loading={act.isPending} onClick={() => act.mutate({ path: '/hand-over', body: { handedOverTo: to, note: note || null } })}>
                    <Handshake aria-hidden="true" />
                    {t('paperwork.confirmHandover')}
                  </Button>
                </Card>
              ) : null}
              {panel === 'void' ? (
                <Card className="space-y-3 p-4">
                  <Label htmlFor="pw-void">{t('paperwork.voidReason')}</Label>
                  <Input id="pw-void" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
                  <Button variant="destructive" disabled={note.trim().length < 2} loading={act.isPending} onClick={() => act.mutate({ path: '/void', body: { reason: note } })}>
                    {t('paperwork.void')}
                  </Button>
                </Card>
              ) : null}
              {act.error ? <Alert tone="danger">{describe(act.error)}</Alert> : null}
            </>
          )}
        </DialogBody>
        {d && manage ? (
          <DialogFooter className="flex-wrap gap-2">
            {d.status === 'DRAFT' ? (
              <>
                <Button variant="ghost" onClick={() => act.mutate({ path: '', method: 'delete' })}>
                  <Trash2 aria-hidden="true" />
                  {t('paperwork.deleteDraft')}
                </Button>
                <Button onClick={() => act.mutate({ path: '/issue' })} loading={act.isPending}>
                  <Send aria-hidden="true" />
                  {d.requiresSignature ? t('paperwork.issueAndSend') : t('paperwork.issue')}
                </Button>
              </>
            ) : null}
            {d.status === 'ISSUED' && d.requiresSignature ? (
              <>
                <Button variant="outline" onClick={() => void copyLink()}>
                  <Copy aria-hidden="true" />
                  {t('paperwork.copyLink')}
                </Button>
                <Button onClick={() => setPanel(panel === 'sign' ? null : 'sign')}>
                  <PenLine aria-hidden="true" />
                  {t('paperwork.signCounter')}
                </Button>
              </>
            ) : null}
            {d.status === 'SIGNED' || (d.status === 'ISSUED' && !d.requiresSignature) ? (
              <Button onClick={() => setPanel(panel === 'handover' ? null : 'handover')}>
                <Handshake aria-hidden="true" />
                {t('paperwork.handOver')}
              </Button>
            ) : null}
            {d.status !== 'DRAFT' && d.status !== 'VOID' ? (
              <Button variant="ghost" onClick={() => setPanel(panel === 'void' ? null : 'void')}>
                <Ban aria-hidden="true" />
                {t('paperwork.void')}
              </Button>
            ) : null}
          </DialogFooter>
        ) : null}
        {d ? <PdfDialog open={pdf} onOpenChange={setPdf} path={`/paperwork/documents/${id}/pdf`} title={d.documentNo} fallbackFilename={`${d.documentNo}.pdf`} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function Timeline({ doc, formatDateTime }: { doc: Doc; formatDateTime: (v: string) => string }) {
  const { t } = useI18n();
  const steps = [
    { done: true, label: t('paperwork.steps.drafted'), at: doc.createdAt },
    { done: !!doc.issuedAt, label: t('paperwork.steps.issued'), at: doc.issuedAt },
    ...(doc.requiresSignature ? [{ done: !!doc.signedAt, label: doc.signerName ? t('paperwork.steps.signedBy', { name: doc.signerName, via: t(`paperwork.via.${doc.signedVia ?? 'COUNTER'}`) }) : t('paperwork.steps.signed'), at: doc.signedAt }] : []),
    { done: !!doc.handedOverAt, label: doc.handedOverTo ? t('paperwork.steps.handedTo', { name: doc.handedOverTo }) : t('paperwork.steps.handedOver'), at: doc.handedOverAt },
  ];
  return (
    <ol className="grid gap-2 sm:grid-cols-4">
      {steps.map((s, i) => (
        <li key={i} className={`rounded-lg border px-3 py-2 text-sm ${s.done ? 'border-success/40 bg-success-soft/40' : 'text-muted-foreground'}`}>
          <span className="block font-medium">{s.label}</span>
          <span className="block text-xs">{s.at ? formatDateTime(s.at) : '—'}</span>
        </li>
      ))}
      {doc.status === 'VOID' ? <li className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm sm:col-span-4">{t('paperwork.voided', { reason: doc.voidReason ?? '' })}</li> : null}
    </ol>
  );
}

// ---------------------------------------------------------------- templates
function TemplateList() {
  const { t, pick } = useI18n();
  const templates = useTemplates(true);
  const [editing, setEditing] = React.useState<Template | null>(null);
  return (
    <div className="space-y-3">
      <Alert tone="info">{t('paperwork.templatesHelp')}</Alert>
      {!templates.data ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {templates.data.map((x) => (
            <Card key={x.id} className={`space-y-2 p-4 ${x.isActive ? '' : 'opacity-60'}`}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-semibold">{pick(x.name, x.nameAr)}</p>
                  <p className="text-xs text-muted-foreground">
                    {t(`paperwork.kinds.${x.kind}`)} · v{x.version} · {x.fields.length} {t('paperwork.fieldsCount')}
                  </p>
                </div>
                <Button size="sm" variant="outline" onClick={() => setEditing(x)}>
                  {t('paperwork.editWording')}
                </Button>
              </div>
              <p className="line-clamp-3 whitespace-pre-wrap text-sm text-muted-foreground">{x.bodyEn}</p>
            </Card>
          ))}
        </div>
      )}
      {editing ? <TemplateDialog template={editing} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

function TemplateDialog({ template, onClose }: { template: Template; onClose: () => void }) {
  const { t } = useI18n();
  const client = useApiClient();
  const queryClient = useQueryClient();
  const describe = useErrorMessage();
  const [v, setV] = React.useState({ titleEn: template.titleEn, titleAr: template.titleAr ?? '', bodyEn: template.bodyEn, bodyAr: template.bodyAr ?? '', isActive: template.isActive, requiresSignature: template.requiresSignature });
  const save = useMutation({
    mutationFn: () => client.patch(`/paperwork/templates/${template.id}`, { ...v, titleAr: v.titleAr || null, bodyAr: v.bodyAr || null, version: template.version }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: KEY });
      onClose();
    },
  });
  const placeholders = ['customer.fullName', 'customer.fullNameAr', 'customer.nationality', 'customer.passportNo', 'customer.emiratesId', 'customer.dateOfBirth', 'today', 'centre.name', ...template.fields.map((f) => f.key)];
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>{template.name}</DialogTitle>
          <DialogDescription>{t('paperwork.placeholders')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <div className="flex flex-wrap gap-1.5">
            {placeholders.map((p) => (
              <code key={p} className="rounded bg-muted px-1.5 py-0.5 text-xs">{`{{${p}}}`}</code>
            ))}
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="tpl-title-en">{t('paperwork.titleEn')}</Label>
              <Input id="tpl-title-en" value={v.titleEn} onChange={(e) => setV({ ...v, titleEn: e.target.value })} />
              <Label htmlFor="tpl-body-en">{t('paperwork.bodyEn')}</Label>
              <Textarea id="tpl-body-en" rows={14} value={v.bodyEn} onChange={(e) => setV({ ...v, bodyEn: e.target.value })} />
            </div>
            <div className="space-y-2" dir="rtl">
              <Label htmlFor="tpl-title-ar">{t('paperwork.titleAr')}</Label>
              <Input id="tpl-title-ar" value={v.titleAr} onChange={(e) => setV({ ...v, titleAr: e.target.value })} />
              <Label htmlFor="tpl-body-ar">{t('paperwork.bodyAr')}</Label>
              <Textarea id="tpl-body-ar" rows={14} value={v.bodyAr} onChange={(e) => setV({ ...v, bodyAr: e.target.value })} />
            </div>
          </div>
          <div className="flex flex-wrap gap-6 text-sm">
            <label className="flex items-center gap-2">
              <Checkbox checked={v.requiresSignature} onCheckedChange={(x) => setV({ ...v, requiresSignature: x === true })} />
              {t('paperwork.needsSignature')}
            </label>
            <label className="flex items-center gap-2">
              <Checkbox checked={v.isActive} onCheckedChange={(x) => setV({ ...v, isActive: x === true })} />
              {t('paperwork.active')}
            </label>
          </div>
          {save.error ? <Alert tone="danger">{describe(save.error)}</Alert> : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending}>
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
