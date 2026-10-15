'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, Pencil, Plus, Trash2 } from 'lucide-react';
import { RETENTION_ACTIONS, RETENTION_ENTITIES } from '@typease/validation';
import {
  Alert, Badge, Button, Card, ConfirmDialog, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, EmptyState, Input, Select, Skeleton, Table,
  TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow, Textarea, useApi, useI18n, useToast,
} from '@typease/ui';
import { DocumentTypePicker, useDocumentTypes } from '@/components/pickers';
import { ActionError, Field, LoadError, SettingSwitch } from '@/components/adm/shared';
import type { RetentionPolicyRow } from '@/components/adm/types';
import { admKeys } from '@/lib/keys/adm';
import { usePrivacyLabels } from './labels';

/** How long records are kept. Only active document policies are applied automatically today; the API says so per policy. */
export function RetentionTab() {
  const { t, tn, pick } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const labels = usePrivacyLabels();
  const types = useDocumentTypes();
  const policies = useQuery({ queryKey: admKeys.privacy.retention, queryFn: () => api.client.get<RetentionPolicyRow[]>('/privacy/retention-policies') });
  const [editing, setEditing] = React.useState<{ policy: RetentionPolicyRow | null } | null>(null);
  const [deleting, setDeleting] = React.useState<RetentionPolicyRow | null>(null);
  const [deleteError, setDeleteError] = React.useState<unknown>(null);

  const typeName = (key: string | null) => {
    if (!key) return t('adm.privacy.retention.allDocuments');
    const type = types.data?.find((d) => d.key === key);
    return type ? pick(type.name, type.nameAr) : key;
  };
  /** A period that is a whole number of years is also said in years. */
  const wholeYears = (p: RetentionPolicyRow) => (p.retainDays >= 365 && p.retainDays % 365 === 0 ? p.retainDays / 365 : 0);
  const state = (p: RetentionPolicyRow) => (
    <>
      <Badge tone={p.isActive ? 'success' : 'neutral'}>{p.isActive ? t('adm.privacy.retention.active') : t('adm.privacy.retention.inactive')}</Badge>
      <Badge tone={p.enforced ? 'info' : 'warning'}>{p.enforced ? t('adm.privacy.retention.enforced') : t('adm.privacy.retention.notEnforced')}</Badge>
    </>
  );
  const actions = (p: RetentionPolicyRow) => (
    <>
      <Button variant="ghost" size="icon-sm" aria-label={t('adm.privacy.retention.editLabel', { name: labels.entity(p.entity) })} onClick={() => setEditing({ policy: p })}>
        <Pencil aria-hidden="true" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t('adm.privacy.retention.deleteLabel', { name: labels.entity(p.entity) })}
        onClick={() => {
          setDeleteError(null);
          setDeleting(p);
        }}
      >
        <Trash2 aria-hidden="true" />
      </Button>
    </>
  );
  const add = (
    <Button variant="accent" onClick={() => setEditing({ policy: null })}>
      <Plus aria-hidden="true" />
      {t('adm.privacy.retention.add')}
    </Button>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-base text-muted-foreground">{t('adm.privacy.retention.intro')}</p>
        {add}
      </div>
      <Card>
        {policies.isPending ? (
          <div className="space-y-3 p-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : policies.isError ? (
          <LoadError error={policies.error} onRetry={() => void policies.refetch()} className="m-4" />
        ) : policies.data.length === 0 ? (
          <EmptyState icon={<Archive />} title={t('adm.privacy.retention.emptyTitle')} description={t('adm.privacy.retention.emptyText')} action={add} />
        ) : (
          <>
            {/* Phones: one block per policy (six columns do not fit); wider screens: the table. */}
            <ul className="divide-y md:hidden">
              {policies.data.map((p) => (
                <li key={p.id} data-policy={p.entity} className="space-y-2 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium">{labels.entity(p.entity)}</p>
                      {p.entity === 'DOCUMENT' ? <p className="text-sm text-muted-foreground">{typeName(p.documentTypeKey)}</p> : null}
                    </div>
                    <span className="flex shrink-0">{actions(p)}</span>
                  </div>
                  <p className="text-base">
                    <span className="tabular">{tn('adm.privacy.retention.days', p.retainDays)}</span>
                    {wholeYears(p) ? <span className="text-muted-foreground"> ({tn('adm.privacy.retention.years', wholeYears(p))})</span> : null}
                    <span className="text-muted-foreground"> · {t('adm.privacy.retention.then')}: </span>
                    {labels.action(p.action)}
                  </p>
                  <div className="flex flex-wrap gap-1.5">{state(p)}</div>
                  {p.legalBasisNote ? (
                    <p className="text-sm text-muted-foreground" dir="auto">
                      {p.legalBasisNote}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
            <div className="hidden md:block">
              <Table>
                <TableCaption>{t('adm.privacy.tabs.retention')}</TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('adm.privacy.retention.what')}</TableHead>
                    <TableHead>{t('adm.privacy.retention.keepFor')}</TableHead>
                    <TableHead>{t('adm.privacy.retention.then')}</TableHead>
                    <TableHead>{t('adm.privacy.retention.state')}</TableHead>
                    <TableHead className="min-w-64">{t('adm.privacy.retention.note')}</TableHead>
                    <TableHead>
                      <span className="sr-only">{t('common.actions')}</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {policies.data.map((p) => (
                    <TableRow key={p.id} data-policy={p.entity}>
                      <TableCell>
                        <span className="block font-medium">{labels.entity(p.entity)}</span>
                        {p.entity === 'DOCUMENT' ? <span className="block text-sm text-muted-foreground">{typeName(p.documentTypeKey)}</span> : null}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <span className="tabular block">{tn('adm.privacy.retention.days', p.retainDays)}</span>
                        {wholeYears(p) ? <span className="block text-sm text-muted-foreground">{tn('adm.privacy.retention.years', wholeYears(p))}</span> : null}
                      </TableCell>
                      <TableCell>{labels.action(p.action)}</TableCell>
                      <TableCell>
                        <span className="flex flex-col items-start gap-1">{state(p)}</span>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        <span className="line-clamp-3" dir="auto" title={p.legalBasisNote ?? undefined}>
                          {p.legalBasisNote ?? '–'}
                        </span>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-end">{actions(p)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </Card>
      <Alert tone="info" title={t('adm.privacy.retention.enforcedTitle')}>
        {t('adm.privacy.retention.enforcedText')}
      </Alert>

      <PolicyDialog target={editing} onClose={() => setEditing(null)} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t('adm.privacy.retention.deleteTitle')}
        description={t('adm.privacy.retention.deleteText')}
        confirmLabel={t('adm.privacy.retention.deleteConfirm')}
        onConfirm={async () => {
          if (!deleting) return;
          setDeleteError(null);
          try {
            await api.client.delete(`/privacy/retention-policies/${deleting.id}`);
            toasts.success(t('adm.privacy.retention.deleted'));
            await queryClient.invalidateQueries({ queryKey: admKeys.privacy.all });
          } catch (e) {
            setDeleteError(e);
            throw e;
          }
        }}
      >
        {deleteError ? <ActionError error={deleteError} /> : null}
      </ConfirmDialog>
    </div>
  );
}

function PolicyDialog({ target, onClose }: { target: { policy: RetentionPolicyRow | null } | null; onClose: () => void }) {
  const { t } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const labels = usePrivacyLabels();
  const id = React.useId();
  const policy = target?.policy ?? null;
  const [entity, setEntity] = React.useState<string>('DOCUMENT');
  const [documentTypeKey, setDocumentTypeKey] = React.useState('');
  const [days, setDays] = React.useState('');
  const [action, setAction] = React.useState<string>('DELETE');
  const [isActive, setIsActive] = React.useState(true);
  const [note, setNote] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  const [touched, setTouched] = React.useState(false);

  React.useEffect(() => {
    if (!target) return;
    setEntity(policy?.entity ?? 'DOCUMENT');
    setDocumentTypeKey(policy?.documentTypeKey ?? '');
    setDays(policy ? String(policy.retainDays) : '');
    setAction(policy?.action ?? 'DELETE');
    setIsActive(policy?.isActive ?? true);
    setNote(policy?.legalBasisNote ?? '');
    setError(null);
    setTouched(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  const retainDays = Number(days);
  const daysOk = /^\d+$/.test(days) && retainDays >= 1 && retainDays <= 36500;
  const effectiveAction = entity === 'DOCUMENT' ? 'DELETE' : action;

  const save = async () => {
    setTouched(true);
    if (!daysOk) return;
    setBusy(true);
    setError(null);
    try {
      if (policy) await api.client.patch(`/privacy/retention-policies/${policy.id}`, { retainDays, action: effectiveAction, legalBasisNote: note.trim() || null, isActive });
      else await api.client.post('/privacy/retention-policies', { entity, documentTypeKey: entity === 'DOCUMENT' && documentTypeKey ? documentTypeKey : undefined, retainDays, action: effectiveAction, legalBasisNote: note.trim() || undefined, isActive });
      toasts.success(t('adm.privacy.retention.saved'));
      await queryClient.invalidateQueries({ queryKey: admKeys.privacy.all });
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!target} onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{policy ? t('adm.privacy.retention.editTitle') : t('adm.privacy.retention.addTitle')}</DialogTitle>
          <DialogDescription>{t('adm.privacy.retention.dialogText')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-5">
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label={t('adm.privacy.retention.what')} htmlFor={`${id}-entity`}>
              <Select id={`${id}-entity`} value={entity} disabled={!!policy} onValueChange={setEntity} options={RETENTION_ENTITIES.map((e) => ({ value: e, label: labels.entity(e) }))} />
            </Field>
            {entity === 'DOCUMENT' ? (
              <Field label={t('adm.privacy.retention.documentType')} htmlFor={`${id}-type`} hint={t('adm.privacy.retention.documentTypeHint')}>
                <DocumentTypePicker id={`${id}-type`} value={documentTypeKey || null} disabled={!!policy} clearable placeholder={t('adm.privacy.retention.allDocuments')} onChange={(key) => setDocumentTypeKey(key)} />
              </Field>
            ) : (
              <Field label={t('adm.privacy.retention.then')} htmlFor={`${id}-action`}>
                <Select id={`${id}-action`} value={action} onValueChange={setAction} options={RETENTION_ACTIONS.map((a) => ({ value: a, label: labels.action(a) }))} />
              </Field>
            )}
            <Field label={t('adm.privacy.retention.keepForDays')} htmlFor={`${id}-days`} hint={t('adm.privacy.retention.daysHint')} error={touched && !daysOk ? t('adm.privacy.retention.daysInvalid') : undefined}>
              <Input id={`${id}-days`} value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, '').slice(0, 5))} inputMode="numeric" dir="ltr" className="tabular sm:max-w-40" aria-invalid={touched && !daysOk} autoComplete="off" />
            </Field>
          </div>
          <Field label={t('adm.privacy.retention.note')} htmlFor={`${id}-note`} hint={t('adm.privacy.retention.noteHint')}>
            <Textarea id={`${id}-note`} value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={500} dir="auto" />
          </Field>
          <div className="rounded-lg border p-4">
            <SettingSwitch id={`${id}-active`} label={t('adm.privacy.retention.activeLabel')} description={entity === 'DOCUMENT' ? t('adm.privacy.retention.activeDocument') : t('adm.privacy.retention.activeOther')} checked={isActive} onCheckedChange={setIsActive} />
          </div>
          <ActionError error={error} />
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void save()} loading={busy} loadingText={t('common.saving')}>
            {policy ? t('common.saveChanges') : t('adm.privacy.retention.add')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
