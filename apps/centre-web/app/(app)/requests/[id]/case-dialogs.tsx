'use client';

import * as React from 'react';
import { useFieldArray, type FieldValues, type Path, type UseFormReturn } from 'react-hook-form';
import { Plus, Trash2 } from 'lucide-react';
import { fieldErrorsOf, isApiError, type RequestPriority } from '@typease/api-client';
import { CAPABILITY_CHANNELS, STATUS_SOURCE_LABEL } from '@typease/types';
import {
  assignRequestSchema, decideRequestApprovalSchema, markRequestDuplicateSchema, recordExternalReferenceSchema, recordExternalResultSchema, requestInformationSchema,
  requestNoteSchema, requestReasonSchema, requestTransitionSchema, updateExternalReferenceSchema, z,
} from '@typease/validation';
import {
  Alert, Button, Checkbox, ChoiceLabel, Combobox, ConfirmDialog, DatePicker, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
  Form, FormError, FormField, Input, Label, RadioGroup, RadioGroupItem, STATUS_META, Select, Textarea, useI18n, useToast, useZodForm, type ComboboxOption,
} from '@typease/ui';
import { DocumentTypePicker, StaffPicker } from '@/components/pickers';
import { useCasesApi } from '@/components/cases/api';
import { SourceLabel, caseErrorText, dateInputToIso, isoToDateInput } from '@/components/cases/shared';
import type { CaseView, SubmissionChannel } from '@/components/cases/types';
import { useCaseContext, type CaseDialog, type ExternalOutcome } from './case-context';

const PRIORITIES: RequestPriority[] = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];

/**
 * Runs a case action from inside a <Form>. Field errors (VALIDATION_FAILED) go to
 * the fields through <Form>; a refusal of the state machine is put above the
 * buttons in our own wording (`cases.errors.<CODE>`), in the UI language.
 */
function useCaseSubmit<T extends FieldValues>(form: UseFormReturn<T, unknown, any>) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const i18n = useI18n();
  return React.useCallback(
    async (action: () => Promise<void>) => {
      try {
        await action();
      } catch (error) {
        if (isApiError(error) && Object.keys(fieldErrorsOf(error)).length > 0) throw error;
        form.setError('root.server' as Path<T>, { type: isApiError(error) ? error.code : 'error', message: caseErrorText(error, i18n) });
      }
    },
    [form, i18n],
  );
}

/** The frame of a form dialog: closes on Escape / outside click like every other dialog. */
function DialogShell({ size = 'md', onClose, children }: { size?: 'sm' | 'md' | 'lg'; onClose: () => void; children: React.ReactNode }) {
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent size={size}>{children}</DialogContent>
    </Dialog>
  );
}

function Footer({ onClose, submitting, label, destructive }: { onClose: () => void; submitting: boolean; label: string; destructive?: boolean }) {
  const { t } = useI18n();
  return (
    <DialogFooter>
      <Button variant="outline" onClick={onClose}>
        {t('common.cancel')}
      </Button>
      <Button type="submit" variant={destructive ? 'destructive' : 'default'} loading={submitting} loadingText={t('common.saving')}>
        {label}
      </Button>
    </DialogFooter>
  );
}

/** Renders the dialog that is open on the case page (or nothing). */
export function CaseDialogs({ dialog, onClose }: { dialog: CaseDialog | null; onClose: () => void }) {
  if (!dialog) return null;
  switch (dialog.type) {
    case 'reason':
      return <ReasonDialog to={dialog.to} label={dialog.label} requiresReason={dialog.requiresReason} onClose={onClose} />;
    case 'cancel':
      return <CancelDialog onClose={onClose} />;
    case 'reopen':
      return <ReopenDialog onClose={onClose} />;
    case 'complete':
      return <CompleteDialog onClose={onClose} />;
    case 'requestInfo':
      return <RequestInfoDialog label={dialog.label} onClose={onClose} />;
    case 'resubmit':
      return <NoteDialog kind="resubmit" onClose={onClose} />;
    case 'completeStep':
      return <NoteDialog kind="completeStep" onClose={onClose} />;
    case 'duplicate':
      return <DuplicateDialog onClose={onClose} />;
    case 'details':
      return <DetailsDialog onClose={onClose} />;
    case 'assign':
      return <AssignDialog role={dialog.role} onClose={onClose} />;
    case 'submission':
      return <SubmissionDialog onClose={onClose} />;
    case 'externalStatus':
      return <ExternalStatusDialog referenceId={dialog.reference.id} onClose={onClose} />;
    case 'externalResult':
      return <ExternalResultDialog outcome={dialog.outcome} onClose={onClose} />;
    case 'approval':
      return <ApprovalDialog approvalId={dialog.approval.id} decision={dialog.decision} onClose={onClose} />;
    case 'migrate':
      return <MigrateDialog onClose={onClose} />;
    default:
      return null;
  }
}

// ---------------------------------------------------------------- status changes

function ReasonDialog({ to, label, requiresReason, onClose }: { to: CaseView['status']; label: string; requiresReason: boolean; onClose: () => void }) {
  const i18n = useI18n();
  const { t, pick } = i18n;
  const { view, apply } = useCaseContext();
  const api = useCasesApi();
  const toasts = useToast();
  const schema = React.useMemo(() => {
    const base = requestTransitionSchema.pick({ reason: true, customerMessage: true });
    return requiresReason ? base.extend({ reason: requestReasonSchema.shape.reason }) : base;
  }, [requiresReason]);
  const form = useZodForm(schema, { defaultValues: { reason: '', customerMessage: '' } });
  const submit = useCaseSubmit(form);
  const target = STATUS_META.request[to];
  return (
    <DialogShell onClose={onClose}>
      <Form
        form={form}
        className="flex min-h-0 flex-1 flex-col space-y-0"
        onSubmit={(values) =>
          submit(async () => {
            apply(await api.transition(view.id, { to, ...(values.reason ? { reason: values.reason } : {}), ...(values.customerMessage ? { customerMessage: values.customerMessage } : {}) }));
            toasts.success(t('cases.actions.statusChanged'), pick(target.en, target.ar));
            onClose();
          })
        }
      >
        <DialogHeader>
          <DialogTitle>{label}</DialogTitle>
          <DialogDescription>{t('cases.actions.reasonText', { status: pick(target.en, target.ar) })}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-5">
          <FormField name="reason" label={t('cases.actions.reason')} required={requiresReason} optional={!requiresReason} hint={t('cases.actions.reasonHint')}>
            {(field) => <Textarea {...field} rows={3} dir="auto" autoFocus />}
          </FormField>
          <FormField name="customerMessage" label={t('cases.actions.customerMessage')} optional hint={t('cases.actions.customerMessageHint')}>
            {(field) => <Textarea {...field} rows={2} dir="auto" />}
          </FormField>
          <FormError />
        </DialogBody>
        <Footer onClose={onClose} submitting={form.formState.isSubmitting} label={label} />
      </Form>
    </DialogShell>
  );
}

/** Cancelling is final: a confirmation dialog that also collects the mandatory reason. */
function CancelDialog({ onClose }: { onClose: () => void }) {
  const i18n = useI18n();
  const { t, formatMoney } = i18n;
  const { view, apply } = useCaseContext();
  const api = useCasesApi();
  const toasts = useToast();
  const [reason, setReason] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const id = React.useId();
  // `totals.paid` is what the centre holds for this request (received less refunded), as computed by the API.
  const totals = view.finance?.totals ?? null;
  const currency = view.finance?.invoices[0]?.currency;
  return (
    <ConfirmDialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={t('cases.actions.cancelTitle', { number: view.requestNo })}
      description={t('cases.actions.cancelText')}
      confirmLabel={t('cases.actions.cancelConfirm')}
      cancelLabel={t('cases.actions.cancelKeep')}
      onConfirm={async () => {
        const parsed = requestReasonSchema.safeParse({ reason });
        if (!parsed.success) {
          setError(t('cases.actions.reasonTooShort'));
          throw new Error('invalid');
        }
        try {
          apply(await api.cancel(view.id, parsed.data.reason));
          toasts.success(t('cases.actions.cancelled'), view.requestNo);
        } catch (e) {
          setError(caseErrorText(e, i18n));
          throw e;
        }
      }}
    >
      <div className="space-y-3">
        {totals && Number(totals.paid) > 0 ? (
          <Alert tone="warning">
            {t('cases.actions.cancelMoney', { amount: formatMoney(totals.paid, currency) })}
          </Alert>
        ) : null}
        <div className="space-y-1.5">
          <Label htmlFor={id} required>
            {t('cases.actions.cancelReason')}
          </Label>
          <Textarea
            id={id}
            rows={3}
            dir="auto"
            value={reason}
            maxLength={500}
            aria-invalid={!!error}
            aria-describedby={`${id}-help`}
            onChange={(e) => {
              setReason(e.target.value);
              setError(null);
            }}
          />
          <p id={`${id}-help`} role={error ? 'alert' : undefined} className={error ? 'text-sm text-destructive-text' : 'text-sm text-muted-foreground'}>
            {error ?? t('cases.actions.cancelReasonHint')}
          </p>
        </div>
      </div>
    </ConfirmDialog>
  );
}

function ReopenDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const { view, apply } = useCaseContext();
  const api = useCasesApi();
  const toasts = useToast();
  const form = useZodForm(requestReasonSchema, { defaultValues: { reason: '' } });
  const submit = useCaseSubmit(form);
  return (
    <DialogShell onClose={onClose}>
      <Form
        form={form}
        className="flex min-h-0 flex-1 flex-col space-y-0"
        onSubmit={({ reason }) =>
          submit(async () => {
            apply(await api.reopen(view.id, reason));
            toasts.success(t('cases.actions.reopened'), view.requestNo);
            onClose();
          })
        }
      >
        <DialogHeader>
          <DialogTitle>{t('cases.actions.reopenTitle')}</DialogTitle>
          <DialogDescription>{t('cases.actions.reopenText')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-5">
          <FormField name="reason" label={t('cases.actions.reason')} required hint={t('cases.actions.reasonHint')}>
            {(field) => <Textarea {...field} rows={3} dir="auto" autoFocus />}
          </FormField>
          <FormError />
        </DialogBody>
        <Footer onClose={onClose} submitting={form.formState.isSubmitting} label={t('cases.actions.reopenSubmit')} />
      </Form>
    </DialogShell>
  );
}

function CompleteDialog({ onClose }: { onClose: () => void }) {
  const i18n = useI18n();
  const { t } = i18n;
  const { view, apply } = useCaseContext();
  const api = useCasesApi();
  const toasts = useToast();
  const [error, setError] = React.useState<string | null>(null);
  return (
    <ConfirmDialog
      open
      tone="default"
      onOpenChange={(next) => !next && onClose()}
      title={t('cases.actions.completeTitle', { number: view.requestNo })}
      description={t('cases.actions.completeText')}
      confirmLabel={t('cases.actions.completeConfirm')}
      onConfirm={async () => {
        try {
          apply(await api.complete(view.id));
          toasts.success(t('cases.actions.completed'), view.requestNo);
        } catch (e) {
          setError(caseErrorText(e, i18n));
          throw e;
        }
      }}
    >
      {error ? (
        <Alert tone="danger" live>
          {error}
        </Alert>
      ) : null}
    </ConfirmDialog>
  );
}

function MigrateDialog({ onClose }: { onClose: () => void }) {
  const i18n = useI18n();
  const { t, formatNumber } = i18n;
  const { view, apply } = useCaseContext();
  const api = useCasesApi();
  const toasts = useToast();
  const [error, setError] = React.useState<string | null>(null);
  return (
    <ConfirmDialog
      open
      tone="default"
      onOpenChange={(next) => !next && onClose()}
      title={t('cases.actions.migrateTitle')}
      description={t('cases.actions.migrateText', { version: formatNumber(view.workflow.version ?? 0) })}
      confirmLabel={t('cases.actions.migrateConfirm')}
      onConfirm={async () => {
        try {
          const next = await api.migrateWorkflow(view.id);
          apply(next);
          toasts.success(t('cases.actions.migrated'), next.migration ? t('cases.actions.migratedText', { from: formatNumber(next.migration.fromVersion), to: formatNumber(next.migration.toVersion) }) : undefined);
        } catch (e) {
          setError(caseErrorText(e, i18n));
          throw e;
        }
      }}
    >
      {error ? (
        <Alert tone="danger" live>
          {error}
        </Alert>
      ) : null}
    </ConfirmDialog>
  );
}

// ---------------------------------------------------------------- working with the customer

function RequestInfoDialog({ label, onClose }: { label: string; onClose: () => void }) {
  const { t, pick } = useI18n();
  const { view, apply } = useCaseContext();
  const api = useCasesApi();
  const toasts = useToast();
  const lines = view.checklist.filter((line) => line.kind === 'INPUT' && line.status !== 'WAIVED');
  const rejected = lines.filter((line) => line.status === 'REJECTED');
  // Rejected documents are ticked and named in the message already; the person only has to read it through.
  const draft = rejected.length
    ? t('cases.actions.infoRejectedMessage', { list: rejected.map((line) => (line.note ? `${pick(line.label, line.labelAr)} (${line.note})` : pick(line.label, line.labelAr))).join(t('cases.actions.infoListSeparator')) }).slice(0, 1000)
    : '';
  const form = useZodForm(requestInformationSchema, {
    defaultValues: { message: draft, checklistItemIds: rejected.map((line) => line.id), addItems: [] },
  });
  const extra = useFieldArray({ control: form.control, name: 'addItems' });
  const chosen = form.watch('checklistItemIds') ?? [];
  const submit = useCaseSubmit(form);
  return (
    <DialogShell size="lg" onClose={onClose}>
      <Form
        form={form}
        className="flex min-h-0 flex-1 flex-col space-y-0"
        onSubmit={(values) =>
          submit(async () => {
            apply(
              await api.requestInformation(view.id, {
                message: values.message,
                ...(values.checklistItemIds?.length ? { checklistItemIds: values.checklistItemIds } : {}),
                ...(values.addItems?.length ? { addItems: values.addItems } : {}),
              }),
            );
            toasts.success(t('cases.actions.infoRequested'), t('cases.actions.infoRequestedText'));
            onClose();
          })
        }
      >
        <DialogHeader>
          <DialogTitle>{label}</DialogTitle>
          <DialogDescription>{t('cases.actions.infoText')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-6">
          <FormField name="message" label={t('cases.actions.infoMessage')} required hint={t('cases.actions.infoMessageHint')}>
            {(field) => <Textarea {...field} rows={4} dir="auto" autoFocus />}
          </FormField>

          {lines.length ? (
            <fieldset className="space-y-2.5">
              <legend className="text-sm font-medium text-foreground">{t('cases.actions.infoDocuments')}</legend>
              <p className="!mt-1 text-sm text-muted-foreground">{t('cases.actions.infoDocumentsHint')}</p>
              <div className="grid gap-2.5 sm:grid-cols-2">
                {lines.map((line) => (
                  <ChoiceLabel
                    key={line.id}
                    htmlFor={`info-${line.id}`}
                    control={
                      <Checkbox
                        id={`info-${line.id}`}
                        checked={chosen.includes(line.id)}
                        onCheckedChange={(on) => form.setValue('checklistItemIds', on === true ? [...chosen, line.id] : chosen.filter((x) => x !== line.id), { shouldDirty: true })}
                      />
                    }
                    label={pick(line.label, line.labelAr)}
                    description={pick(STATUS_META.checklist[line.status].en, STATUS_META.checklist[line.status].ar)}
                  />
                ))}
              </div>
            </fieldset>
          ) : null}

          <fieldset className="space-y-3">
            <legend className="text-sm font-medium text-foreground">{t('cases.actions.infoNew')}</legend>
            {extra.fields.map((item, index) => (
              <div key={item.id} className="grid gap-3 rounded-md border p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-start">
                <FormField name={`addItems.${index}.documentTypeKey`} label={t('cases.docs.lineType')} required>
                  {(field) => (
                    <DocumentTypePicker
                      {...field}
                      onChange={(key, type) => {
                        field.onChange(key);
                        if (type && !form.getValues(`addItems.${index}.label`)) form.setValue(`addItems.${index}.label`, type.name, { shouldValidate: true });
                      }}
                    />
                  )}
                </FormField>
                <FormField name={`addItems.${index}.label`} label={t('cases.docs.lineLabel')} required>
                  {(field) => <Input {...field} autoComplete="off" dir="auto" />}
                </FormField>
                <Button variant="ghost" size="icon" className="sm:mt-6" aria-label={t('common.remove')} onClick={() => extra.remove(index)}>
                  <Trash2 aria-hidden="true" />
                </Button>
              </div>
            ))}
            {extra.fields.length < 10 ? (
              <Button variant="outline" size="sm" onClick={() => extra.append({ documentTypeKey: '', label: '', isMandatory: true })}>
                <Plus aria-hidden="true" />
                {t('cases.actions.infoAdd')}
              </Button>
            ) : null}
          </fieldset>
          <FormError />
        </DialogBody>
        <Footer onClose={onClose} submitting={form.formState.isSubmitting} label={t('cases.actions.infoSubmit')} />
      </Form>
    </DialogShell>
  );
}

/** "Customer has answered" (resubmit) and "Preparation done" (complete the staff task): one optional note each. */
function NoteDialog({ kind, onClose }: { kind: 'resubmit' | 'completeStep'; onClose: () => void }) {
  const { t } = useI18n();
  const { view, apply } = useCaseContext();
  const api = useCasesApi();
  const toasts = useToast();
  const form = useZodForm(requestNoteSchema, { defaultValues: { note: '' } });
  const submit = useCaseSubmit(form);
  return (
    <DialogShell onClose={onClose}>
      <Form
        form={form}
        className="flex min-h-0 flex-1 flex-col space-y-0"
        onSubmit={({ note }) =>
          submit(async () => {
            apply(kind === 'resubmit' ? await api.resubmit(view.id, note ?? undefined) : await api.completeStep(view.id, note ?? undefined));
            toasts.success(t(`cases.actions.${kind}.done`), view.requestNo);
            onClose();
          })
        }
      >
        <DialogHeader>
          <DialogTitle>{t(`cases.actions.${kind}.title`)}</DialogTitle>
          <DialogDescription>{t(`cases.actions.${kind}.text`)}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-5">
          <FormField name="note" label={t('cases.actions.note')} optional>
            {(field) => <Textarea {...field} rows={3} dir="auto" />}
          </FormField>
          <FormError />
        </DialogBody>
        <Footer onClose={onClose} submitting={form.formState.isSubmitting} label={t(`cases.actions.${kind}.submit`)} />
      </Form>
    </DialogShell>
  );
}

function DuplicateDialog({ onClose }: { onClose: () => void }) {
  const { t, formatDate } = useI18n();
  const { view, apply } = useCaseContext();
  const api = useCasesApi();
  const toasts = useToast();
  const form = useZodForm(markRequestDuplicateSchema, { defaultValues: { duplicateOfId: '' } });
  const submit = useCaseSubmit(form);
  const load = React.useCallback(
    async (q: string, signal: AbortSignal): Promise<ComboboxOption[]> => {
      // Without a search text: the other requests of the same customer, which is where duplicates come from.
      const page = await api.search(q ? { q, pageSize: 20 } : { customerId: view.customer.id, pageSize: 20, sort: 'createdAt:desc' }, signal);
      return page.data.filter((r) => r.id !== view.id).map((r) => ({ value: r.id, label: `${r.requestNo} · ${r.serviceName}`, description: `${r.customerName} · ${formatDate(r.createdAt)}` }));
    },
    [api, view.customer.id, view.id, formatDate],
  );
  return (
    <DialogShell onClose={onClose}>
      <Form
        form={form}
        className="flex min-h-0 flex-1 flex-col space-y-0"
        onSubmit={({ duplicateOfId }) =>
          submit(async () => {
            apply(await api.markDuplicate(view.id, duplicateOfId));
            toasts.success(t('cases.actions.duplicateDone'), view.requestNo);
            onClose();
          })
        }
      >
        <DialogHeader>
          <DialogTitle>{t('cases.actions.duplicateTitle')}</DialogTitle>
          <DialogDescription>{t('cases.actions.duplicateText', { number: view.requestNo })}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-5">
          <FormField name="duplicateOfId" label={t('cases.actions.duplicateOf')} required hint={t('cases.actions.duplicateHint')}>
            {(field) => (
              <Combobox
                {...field}
                onValueChange={(value) => field.onChange(value)}
                loadOptions={load}
                placeholder={t('cases.actions.duplicatePlaceholder')}
                searchPlaceholder={t('cases.actions.duplicateSearch')}
                emptyText={t('cases.actions.duplicateEmpty')}
              />
            )}
          </FormField>
          <FormError />
        </DialogBody>
        <Footer onClose={onClose} submitting={form.formState.isSubmitting} label={t('cases.actions.duplicateSubmit')} destructive />
      </Form>
    </DialogShell>
  );
}

const detailsSchema = z.object({
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']),
  targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').nullish(),
  instructions: z.string().trim().max(2000).nullish(),
});

function DetailsDialog({ onClose }: { onClose: () => void }) {
  const { t, pick, timeZone, today } = useI18n();
  const { view, apply } = useCaseContext();
  const api = useCasesApi();
  const toasts = useToast();
  const initial = { priority: view.priority, targetDate: isoToDateInput(view.targetDate, timeZone), instructions: view.customerInstructions ?? '' };
  const form = useZodForm(detailsSchema, { defaultValues: initial, emptyAs: 'null' });
  const submit = useCaseSubmit(form);
  return (
    <DialogShell onClose={onClose}>
      <Form
        form={form}
        className="flex min-h-0 flex-1 flex-col space-y-0"
        onSubmit={(values) =>
          submit(async () => {
            const body: Parameters<typeof api.update>[1] = { version: view.version };
            if (values.priority !== view.priority) body.priority = values.priority;
            if ((values.targetDate ?? '') !== initial.targetDate) body.targetDate = values.targetDate ? dateInputToIso(values.targetDate, timeZone) : null;
            if ((values.instructions ?? '') !== initial.instructions) body.instructions = values.instructions ?? '';
            if (Object.keys(body).length === 1) {
              onClose();
              return;
            }
            apply(await api.update(view.id, body));
            toasts.success(t('cases.actions.detailsSaved'), view.requestNo);
            onClose();
          })
        }
      >
        <DialogHeader>
          <DialogTitle>{t('cases.actions.detailsTitle')}</DialogTitle>
          <DialogDescription>{t('cases.actions.detailsText')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-5">
          <div className="grid gap-5 sm:grid-cols-2">
            <FormField name="priority" label={t('cases.fields.priority')}>
              {(field) => <Select {...field} onValueChange={field.onChange} options={PRIORITIES.map((p) => ({ value: p, label: pick(STATUS_META.priority[p].en, STATUS_META.priority[p].ar) }))} />}
            </FormField>
            <FormField name="targetDate" label={t('cases.fields.targetDate')} hint={view.status === 'DRAFT' ? t('cases.actions.targetHintDraft') : undefined}>
              {(field) => <DatePicker {...field} onChange={field.onChange} min={today()} />}
            </FormField>
          </div>
          <FormField name="instructions" label={t('cases.fields.instructions')} optional hint={t('cases.actions.instructionsHint')}>
            {(field) => <Textarea {...field} rows={3} dir="auto" />}
          </FormField>
          <FormError />
        </DialogBody>
        <Footer onClose={onClose} submitting={form.formState.isSubmitting} label={t('common.saveChanges')} />
      </Form>
    </DialogShell>
  );
}

// ---------------------------------------------------------------- assignment and review

function AssignDialog({ role, onClose }: { role: 'OPERATOR' | 'REVIEWER'; onClose: () => void }) {
  const { t } = useI18n();
  const { view, apply } = useCaseContext();
  const api = useCasesApi();
  const toasts = useToast();
  const current = role === 'OPERATOR' ? view.assignee : view.reviewer;
  const schema = React.useMemo(() => (current ? assignRequestSchema.extend({ reason: z.string().trim().min(3).max(300) }) : assignRequestSchema), [current]);
  const form = useZodForm(schema, { defaultValues: { assigneeMembershipId: '', role, reason: '' } });
  const submit = useCaseSubmit(form);
  const title = current ? t(`cases.team.reassign.${role}`) : t(`cases.team.assign.${role}`);
  return (
    <DialogShell onClose={onClose}>
      <Form
        form={form}
        className="flex min-h-0 flex-1 flex-col space-y-0"
        onSubmit={(values) =>
          submit(async () => {
            const next = await api.assign(view.id, { assigneeMembershipId: values.assigneeMembershipId, role, ...(values.reason ? { reason: values.reason } : {}) });
            apply(next);
            toasts.success(t('cases.team.assigned'), (role === 'OPERATOR' ? next.assignee : next.reviewer)?.name);
            onClose();
          })
        }
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{current ? t('cases.team.reassignText', { name: current.name }) : t(`cases.team.assignText.${role}`)}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-5">
          <FormField name="assigneeMembershipId" label={t(`cases.team.roles.${role}`)} required>
            {(field) => <StaffPicker {...field} branchId={view.branch.id} onChange={(id) => field.onChange(id)} />}
          </FormField>
          {current ? (
            <FormField name="reason" label={t('cases.team.reassignReason')} required hint={t('cases.team.reassignReasonHint')}>
              {(field) => <Textarea {...field} rows={2} dir="auto" />}
            </FormField>
          ) : null}
          <FormError />
        </DialogBody>
        <Footer onClose={onClose} submitting={form.formState.isSubmitting} label={title} />
      </Form>
    </DialogShell>
  );
}

function ApprovalDialog({ approvalId, decision, onClose }: { approvalId: string; decision?: 'APPROVED' | 'REJECTED'; onClose: () => void }) {
  const i18n = useI18n();
  const { t } = i18n;
  const { view, apply } = useCaseContext();
  const api = useCasesApi();
  const toasts = useToast();
  const approval = view.approvals.find((a) => a.id === approvalId);
  const form = useZodForm(decideRequestApprovalSchema, { defaultValues: { decision: decision ?? 'APPROVED', comment: '' } });
  const chosen = form.watch('decision');
  const groupId = React.useId();
  const [selfReview, setSelfReview] = React.useState(false);
  const submit = useCaseSubmit(form);
  return (
    <DialogShell onClose={onClose}>
      <Form
        form={form}
        className="flex min-h-0 flex-1 flex-col space-y-0"
        onSubmit={async (values) => {
          setSelfReview(false);
          try {
            apply(await api.decideApproval(view.id, approvalId, { decision: values.decision, ...(values.comment ? { comment: values.comment } : {}) }));
            toasts.success(values.decision === 'APPROVED' ? t('cases.approvals.approved') : t('cases.approvals.sentBack'), view.requestNo);
            onClose();
          } catch (error) {
            // The person who prepared a case can not approve it: explain instead of showing a bare refusal.
            if (isApiError(error) && error.code === 'SEGREGATION_OF_DUTIES') {
              setSelfReview(true);
              return;
            }
            await submit(async () => {
              throw error;
            });
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('cases.approvals.decideTitle')}</DialogTitle>
          <DialogDescription>
            {approval?.requestedByName ? t('cases.approvals.preparedBy', { name: approval.requestedByName }) : t('cases.approvals.decideText')}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-5">
          <FormField name="decision" label={t('cases.approvals.decision')}>
            {(field) => (
              <RadioGroup id={field.id} value={field.value} onValueChange={field.onChange} aria-label={t('cases.approvals.decision')}>
                {(['APPROVED', 'REJECTED'] as const).map((value) => (
                  <ChoiceLabel
                    key={value}
                    htmlFor={`${groupId}-${value}`}
                    control={<RadioGroupItem id={`${groupId}-${value}`} value={value} />}
                    label={t(`cases.approvals.decisions.${value}`)}
                    description={t(`cases.approvals.decisionHints.${value}`)}
                  />
                ))}
              </RadioGroup>
            )}
          </FormField>
          <FormField
            name="comment"
            label={chosen === 'REJECTED' ? t('cases.approvals.commentReject') : t('cases.approvals.comment')}
            required={chosen === 'REJECTED'}
            optional={chosen !== 'REJECTED'}
            hint={chosen === 'REJECTED' ? t('cases.approvals.commentRejectHint') : undefined}
          >
            {(field) => <Textarea {...field} rows={3} dir="auto" />}
          </FormField>
          {selfReview ? (
            <Alert tone="warning" live title={t('cases.approvals.selfTitle')}>
              {t('cases.approvals.selfText')}
            </Alert>
          ) : null}
          <FormError />
        </DialogBody>
        <Footer onClose={onClose} submitting={form.formState.isSubmitting} label={chosen === 'REJECTED' ? t('cases.approvals.submitReject') : t('cases.approvals.submitApprove')} destructive={chosen === 'REJECTED'} />
      </Form>
    </DialogShell>
  );
}

// ---------------------------------------------------------------- external processing

function SubmissionDialog({ onClose }: { onClose: () => void }) {
  const { t, pick } = useI18n();
  const { view, apply } = useCaseContext();
  const api = useCasesApi();
  const toasts = useToast();
  const permitted: SubmissionChannel[] = view.service.permittedChannels ?? [...CAPABILITY_CHANNELS[view.service.complianceCapability]];
  const form = useZodForm(recordExternalReferenceSchema, {
    defaultValues: { channel: permitted[0] ?? 'MANUAL_PORTAL', authorityName: '', referenceNo: '', partnerName: '', partnerReference: '', notes: '' },
  });
  const channel = form.watch('channel');
  const groupId = React.useId();
  const submit = useCaseSubmit(form);
  const first = view.status === 'READY_TO_SUBMIT';

  // The service does not allow the centre to submit: say why, offer nothing to fill in.
  if (permitted.length === 0) {
    return (
      <DialogShell onClose={onClose}>
        <DialogHeader>
          <DialogTitle>{t('cases.external.recordTitle')}</DialogTitle>
          <DialogDescription>{pick(view.service.name, view.service.nameAr)}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Alert tone="warning" title={t('cases.external.notPermittedTitle')}>
            {t(`cases.external.capabilityText.${view.service.complianceCapability}`)}
          </Alert>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('common.close')}
          </Button>
        </DialogFooter>
      </DialogShell>
    );
  }

  const source = channel === 'AUTHORISED_PARTNER' ? 'PARTNER_PROVIDED' : 'STAFF_ENTERED';
  return (
    <DialogShell size="lg" onClose={onClose}>
      <Form
        form={form}
        className="flex min-h-0 flex-1 flex-col space-y-0"
        onSubmit={(values) =>
          submit(async () => {
            if (values.channel === 'AUTHORISED_PARTNER' && !values.partnerName) {
              form.setError('partnerName', { type: 'required', message: 'Required' });
              return;
            }
            apply(
              await api.recordSubmission(view.id, {
                channel: values.channel,
                referenceNo: values.referenceNo,
                ...(values.authorityName ? { authorityName: values.authorityName } : {}),
                ...(values.partnerName ? { partnerName: values.partnerName } : {}),
                ...(values.partnerReference ? { partnerReference: values.partnerReference } : {}),
                ...(values.notes ? { notes: values.notes } : {}),
              }),
            );
            toasts.success(t('cases.external.recorded'), values.referenceNo);
            onClose();
          })
        }
      >
        <DialogHeader>
          <DialogTitle>{t('cases.external.recordTitle')}</DialogTitle>
          <DialogDescription>{first ? t('cases.external.recordText') : t('cases.external.recordTextMore')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-5">
          <FormField name="channel" label={t('cases.external.channel')} hint={t('cases.external.channelHint')}>
            {(field) => (
              <RadioGroup id={field.id} value={field.value} onValueChange={field.onChange} aria-label={t('cases.external.channel')}>
                {permitted.map((value) => (
                  <ChoiceLabel
                    key={value}
                    htmlFor={`${groupId}-${value}`}
                    control={<RadioGroupItem id={`${groupId}-${value}`} value={value} />}
                    label={t(`cases.external.channels.${value}`)}
                    description={t(`cases.external.channelHints.${value}`)}
                  />
                ))}
              </RadioGroup>
            )}
          </FormField>
          <div className="grid gap-5 sm:grid-cols-2">
            <FormField name="referenceNo" label={t('cases.external.referenceNo')} required hint={t('cases.external.referenceNoHint')}>
              {(field) => <Input {...field} dir="ltr" autoComplete="off" spellCheck={false} className="tabular" />}
            </FormField>
            <FormField name="authorityName" label={t('cases.external.authority')} optional>
              {(field) => <Input {...field} dir="auto" autoComplete="off" />}
            </FormField>
            {channel === 'AUTHORISED_PARTNER' ? (
              <>
                <FormField name="partnerName" label={t('cases.external.partnerName')} required>
                  {(field) => <Input {...field} dir="auto" autoComplete="off" />}
                </FormField>
                <FormField name="partnerReference" label={t('cases.external.partnerReference')} optional>
                  {(field) => <Input {...field} dir="ltr" autoComplete="off" spellCheck={false} className="tabular" />}
                </FormField>
              </>
            ) : null}
          </div>
          <FormField name="notes" label={t('cases.external.notes')} optional hint={t('cases.external.notesHint')}>
            {(field) => <Textarea {...field} rows={2} dir="auto" />}
          </FormField>
          <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-3 py-2.5 text-sm text-foreground/90">
            <span>{t('cases.external.sourcePreview')}</span>
            <SourceLabel source={source} label={STATUS_SOURCE_LABEL[source]} />
          </div>
          <FormError />
        </DialogBody>
        <Footer onClose={onClose} submitting={form.formState.isSubmitting} label={t('cases.external.recordSubmit')} />
      </Form>
    </DialogShell>
  );
}

function ExternalStatusDialog({ referenceId, onClose }: { referenceId: string; onClose: () => void }) {
  const { t } = useI18n();
  const { view, apply } = useCaseContext();
  const api = useCasesApi();
  const toasts = useToast();
  const reference = view.externalReferences.find((r) => r.id === referenceId);
  const form = useZodForm(updateExternalReferenceSchema, { defaultValues: { status: reference?.status ?? '', notes: reference?.notes ?? '' } });
  const submit = useCaseSubmit(form);
  if (!reference) return null;
  return (
    <DialogShell onClose={onClose}>
      <Form
        form={form}
        className="flex min-h-0 flex-1 flex-col space-y-0"
        onSubmit={(values) =>
          submit(async () => {
            apply(await api.updateExternalReference(view.id, reference.id, { ...(values.status ? { status: values.status } : {}), ...(values.notes ? { notes: values.notes } : {}) }));
            toasts.success(t('cases.external.statusSaved'), reference.referenceNo);
            onClose();
          })
        }
      >
        <DialogHeader>
          <DialogTitle>{t('cases.external.statusTitle')}</DialogTitle>
          <DialogDescription>
            <span className="ltr-value tabular">{reference.referenceNo}</span>
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-5">
          <FormField name="status" label={t('cases.external.statusField')} required hint={t('cases.external.statusHint')}>
            {(field) => <Textarea {...field} rows={2} dir="auto" autoFocus />}
          </FormField>
          <FormField name="notes" label={t('cases.external.notes')} optional hint={t('cases.external.notesHint')}>
            {(field) => <Textarea {...field} rows={2} dir="auto" />}
          </FormField>
          <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-3 py-2.5 text-sm text-foreground/90">
            <span>{t('cases.external.sourcePreview')}</span>
            <SourceLabel source={reference.channel === 'AUTHORISED_PARTNER' ? 'PARTNER_PROVIDED' : 'STAFF_ENTERED'} />
          </div>
          <FormError />
        </DialogBody>
        <Footer onClose={onClose} submitting={form.formState.isSubmitting} label={t('cases.external.statusSubmit')} />
      </Form>
    </DialogShell>
  );
}

function ExternalResultDialog({ outcome, onClose }: { outcome?: ExternalOutcome; onClose: () => void }) {
  const { t } = useI18n();
  const { view, apply } = useCaseContext();
  const api = useCasesApi();
  const toasts = useToast();
  const form = useZodForm(recordExternalResultSchema, { defaultValues: { outcome: outcome ?? 'COMPLETED', note: '' } });
  const chosen = form.watch('outcome');
  const groupId = React.useId();
  const submit = useCaseSubmit(form);
  return (
    <DialogShell onClose={onClose}>
      <Form
        form={form}
        className="flex min-h-0 flex-1 flex-col space-y-0"
        onSubmit={(values) =>
          submit(async () => {
            apply(await api.recordExternalResult(view.id, { outcome: values.outcome, ...(values.note ? { note: values.note } : {}) }));
            toasts.success(t('cases.external.resultSaved'), t(`cases.external.outcomes.${values.outcome}`));
            onClose();
          })
        }
      >
        <DialogHeader>
          <DialogTitle>{t('cases.external.resultTitle')}</DialogTitle>
          <DialogDescription>{t('cases.external.resultText')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-5">
          <FormField name="outcome" label={t('cases.external.outcome')}>
            {(field) => (
              <RadioGroup id={field.id} value={field.value} onValueChange={field.onChange} aria-label={t('cases.external.outcome')}>
                {(['COMPLETED', 'RETURNED', 'REJECTED'] as const).map((value) => (
                  <ChoiceLabel
                    key={value}
                    htmlFor={`${groupId}-${value}`}
                    control={<RadioGroupItem id={`${groupId}-${value}`} value={value} />}
                    label={t(`cases.external.outcomes.${value}`)}
                    description={t(`cases.external.outcomeHints.${value}`)}
                  />
                ))}
              </RadioGroup>
            )}
          </FormField>
          <FormField name="note" label={t('cases.external.resultNote')} required={chosen !== 'COMPLETED'} optional={chosen === 'COMPLETED'} hint={t('cases.external.resultNoteHint')}>
            {(field) => <Textarea {...field} rows={3} dir="auto" />}
          </FormField>
          <FormError />
        </DialogBody>
        <Footer onClose={onClose} submitting={form.formState.isSubmitting} label={t('cases.external.resultSubmit')} />
      </Form>
    </DialogShell>
  );
}
