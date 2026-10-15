'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { MessageSquare, Pencil, Send } from 'lucide-react';
import { isApiError } from '@typease/api-client';
import { formFields, requestCommentSchema, requestReasonSchema } from '@typease/validation';
import {
  Alert, Button, Card, CardContent, DescriptionList, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, EmptyState, Form, FormActions,
  FormError, FormField, Textarea, countryName, useBranding, useErrorMessage, useI18n, useToast, useZodForm,
} from '@typease/ui';
import { DynamicForm, checkForm, displayFormValue, fieldsPayload, formErrorsOf, type FormErrors, type FormValuesState } from '@/components/portal/dynamic-form';
import { MessageThread, SectionTitle } from '@/components/portal/shared';
import { usePortalApi } from '@/lib/api';
import { ROUTES } from '@/lib/config';
import type { RequestView } from '@/lib/types';

// ---------------------------------------------------------------- messages with the centre

const messageSchema = requestCommentSchema.pick({ body: true });

/** The conversation about this request. Company users only ever see and write messages the centre shares with them. */
export function RequestMessages({ view, canWrite, onSent }: { view: RequestView; canWrite: boolean; onSent: () => void }) {
  const { t } = useI18n();
  const api = usePortalApi();
  const toasts = useToast();
  const { name } = useBranding();
  const form = useZodForm(messageSchema, { defaultValues: { body: '' } });
  const messages = [...view.comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return (
    <Card>
      <CardContent className="space-y-5">
        <div>
          <SectionTitle>{t('my.request.messages.title', { centre: name })}</SectionTitle>
          <p className="mt-1 text-sm text-muted-foreground">{t('my.request.messages.text')}</p>
        </div>
        {messages.length ? (
          <MessageThread messages={messages.map((m) => ({ id: m.id, fromCentre: m.authorType !== 'CUSTOMER' && m.authorType !== 'CORPORATE', authorName: m.authorName, body: m.body, createdAt: m.createdAt }))} />
        ) : (
          <EmptyState icon={<MessageSquare />} title={t('my.request.messages.emptyTitle')} description={canWrite ? t('my.request.messages.emptyText') : undefined} className="py-6" />
        )}
        {canWrite ? (
          <Form
            form={form}
            className="space-y-3 border-t pt-4"
            onSubmit={async ({ body }) => {
              await api.addComment(view.id, body);
              form.reset({ body: '' });
              toasts.success(t('my.request.messages.sent'));
              onSent();
            }}
          >
            <FormField name="body" label={t('my.request.messages.write')}>
              {(field) => <Textarea {...field} rows={3} dir="auto" maxLength={4000} placeholder={t('my.request.messages.placeholder')} />}
            </FormField>
            <FormError />
            <FormActions>
              <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.loading')}>
                <Send className="rtl-mirror" aria-hidden="true" />
                {t('my.request.messages.send')}
              </Button>
            </FormActions>
          </Form>
        ) : (
          <p className="border-t pt-4 text-sm text-muted-foreground">{t('my.request.messages.closed')}</p>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------- the answers of the request form

/** What was filled in for the request, read-only; editable again while the centre waits for the company. */
export function RequestAnswers({ view, canEdit, apply }: { view: RequestView; canEdit: boolean; apply: (view?: RequestView | null) => void }) {
  const i18n = useI18n();
  const { t, pick, locale } = i18n;
  const [editing, setEditing] = React.useState(false);
  const schema = view.form.schema;
  const fields = schema ? formFields(schema).filter((f) => view.form.visibleFields.includes(f.key)) : [];
  return (
    <Card>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SectionTitle>{t('my.request.details.title')}</SectionTitle>
          {canEdit && fields.length ? (
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              <Pencil aria-hidden="true" />
              {t('my.request.details.edit')}
            </Button>
          ) : null}
        </div>
        {fields.length || view.customerInstructions ? (
          <DescriptionList
            items={[
              ...fields.map((field) => ({
                label: pick(field.label, field.labelAr),
                value: <span dir="auto">{displayFormValue(field, view.form.values[field.key], i18n, (code) => countryName(code, locale))}</span>,
                wide: field.type === 'textarea',
              })),
              ...(view.customerInstructions ? [{ label: t('my.wizard.details.instructions'), value: <span dir="auto" className="whitespace-pre-wrap">{view.customerInstructions}</span>, wide: true }] : []),
            ]}
          />
        ) : (
          <p className="text-base text-muted-foreground">{t('my.request.details.none')}</p>
        )}
        {!canEdit && fields.length && view.status !== 'COMPLETED' && view.status !== 'CANCELLED' ? <p className="text-sm text-muted-foreground">{t('my.request.details.locked')}</p> : null}
      </CardContent>
      {editing && schema ? <EditAnswersDialog view={view} onClose={() => setEditing(false)} apply={apply} /> : null}
    </Card>
  );
}

function EditAnswersDialog({ view, onClose, apply }: { view: RequestView; onClose: () => void; apply: (view?: RequestView | null) => void }) {
  const i18n = useI18n();
  const { t } = i18n;
  const api = usePortalApi();
  const toasts = useToast();
  const describe = useErrorMessage();
  const schema = view.form.schema!;
  const [values, setValues] = React.useState<FormValuesState>(view.form.values);
  const [errors, setErrors] = React.useState<FormErrors>({});
  const [failure, setFailure] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const save = async () => {
    // After submission the whole form has to stay valid on every save.
    const check = checkForm(schema, values, false, i18n);
    if (!check.ok) {
      setErrors(check.errors);
      setFailure(t('form.checkFields'));
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      apply(await api.saveFields(view.id, fieldsPayload(schema, values, view.form.values)));
      toasts.success(t('my.request.details.saved'));
      onClose();
    } catch (error) {
      const fieldErrors = formErrorsOf(error, schema, i18n);
      if (Object.keys(fieldErrors).length) setErrors(fieldErrors);
      setFailure(Object.keys(fieldErrors).length ? t('form.checkFields') : describe(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{t('my.request.details.edit')}</DialogTitle>
          <DialogDescription>{t('my.request.details.editText')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-5">
          <DynamicForm
            schema={schema}
            values={values}
            errors={errors}
            onChange={(key, value) => {
              setValues((s) => ({ ...s, [key]: value }));
              setErrors((s) => {
                if (!(key in s)) return s;
                const { [key]: _removed, ...rest } = s;
                return rest;
              });
            }}
          />
          {failure ? (
            <Alert tone="danger" live>
              {failure}
            </Alert>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button loading={busy} loadingText={t('common.saving')} onClick={() => void save()}>
            {t('common.saveChanges')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- cancel

/** Cancelling asks why (the centre sees the reason) and says plainly what it does not do: it never refunds by itself. */
export function CancelRequestDialog({ view, onClose, apply }: { view: RequestView; onClose: () => void; apply: (view?: RequestView | null) => void }) {
  const { t } = useI18n();
  const api = usePortalApi();
  const toasts = useToast();
  const router = useRouter();
  const form = useZodForm(requestReasonSchema, { defaultValues: { reason: '' } });
  const paid = Number(view.finance?.totals?.paid ?? 0) > 0;
  const [notAllowed, setNotAllowed] = React.useState(false);
  return (
    <Dialog open onOpenChange={(open) => !open && !form.formState.isSubmitting && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{t('my.request.cancelTitle')}</DialogTitle>
          <DialogDescription>{t('my.request.cancelText', { number: view.requestNo })}</DialogDescription>
        </DialogHeader>
        <Form
          form={form}
          className="flex min-h-0 flex-1 flex-col space-y-0"
          onSubmit={async ({ reason }) => {
            setNotAllowed(false);
            try {
              apply(await api.cancelRequest(view.id, reason));
            } catch (error) {
              // The centre has already started: cancelling is then its decision, not a button.
              if (isApiError(error) && error.code === 'CANCELLATION_NOT_ALLOWED') return setNotAllowed(true);
              throw error;
            }
            toasts.success(t('my.request.cancelled', { number: view.requestNo }));
            onClose();
            if (view.status === 'DRAFT') router.push(ROUTES.requests);
          }}
        >
          <DialogBody className="space-y-4">
            {paid ? <Alert tone="warning">{t('my.request.cancelPaid')}</Alert> : null}
            <FormField name="reason" label={t('my.request.cancelReason')} required hint={t('my.request.cancelReasonHint')}>
              {(field) => <Textarea {...field} rows={3} dir="auto" maxLength={500} autoFocus />}
            </FormField>
            {notAllowed ? (
              <Alert tone="warning" live>
                {t('my.request.cancelNotAllowed')}
              </Alert>
            ) : null}
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={form.formState.isSubmitting}>
              {t('my.request.keep')}
            </Button>
            <Button type="submit" variant="destructive" loading={form.formState.isSubmitting} loadingText={t('common.loading')}>
              {t('my.request.cancel')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
