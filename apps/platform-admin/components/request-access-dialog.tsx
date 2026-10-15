'use client';

import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ShieldAlert } from 'lucide-react';
import { requestAccessSchema } from '@typease/validation';
import {
  Alert, Button, Checkbox, ChoiceLabel, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Form, FormError, FormField, Select, Textarea, cn, useI18n,
  useToast, useZodForm,
} from '@typease/ui';
import { usePlatformApi } from '@/lib/api';
import { keys } from '@/lib/query-keys';
import { ACCESS_SCOPES, SENSITIVE_SCOPES, scopeKey } from '@/lib/scopes';
import { Field } from './shared';
import { TenantPicker, type PickedTenant } from './tenant-picker';

const DURATIONS = [15, 30, 60, 120, 240, 480, 1440] as const;

/** "30 minutes", "2 hours", "24 hours": how long an access lasts. */
export function useDurationLabel(): (minutes: number) => string {
  const { tn } = useI18n();
  return React.useCallback((minutes: number) => (minutes % 60 === 0 ? tn('access.duration.hours', minutes / 60) : tn('access.duration.minutes', minutes)), [tn]);
}

/** A scope in words, falling back to its key for one the console does not know yet. */
export function useScopeLabel(): (scope: string) => string {
  const { t, has } = useI18n();
  return React.useCallback((scope: string) => (has(`${scopeKey(scope)}.label`) ? t(`${scopeKey(scope)}.label`) : scope), [t, has]);
}

/**
 * Asks a centre for time-boxed, scoped access to its data
 * (POST /platform/tenants/:id/access-grants). The request only records the wish:
 * the centre's owner approves or denies it, and the clock starts at approval.
 */
export function RequestAccessDialog({
  open, onOpenChange, centre, ticket,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The centre the request is for. Without it the dialog asks. */
  centre?: PickedTenant | null;
  /** A platform support ticket of the same centre that the access is for. */
  ticket?: { id: string; ticketNo: string } | null;
}) {
  const { t } = useI18n();
  const api = usePlatformApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const duration = useDurationLabel();
  const form = useZodForm(requestAccessSchema, { defaultValues: { reason: '', scopes: [], durationMinutes: 60 } });
  const [picked, setPicked] = React.useState<PickedTenant | null>(null);
  const [centreMissing, setCentreMissing] = React.useState(false);
  const id = React.useId();
  const target = centre ?? picked;

  React.useEffect(() => {
    if (open) {
      form.reset({ reason: '', scopes: [], durationMinutes: 60 });
      setPicked(null);
      setCentreMissing(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(next) => !form.formState.isSubmitting && onOpenChange(next)}>
      <DialogContent size="lg">
        <Form
          form={form}
          className="flex min-h-0 flex-1 flex-col space-y-0"
          // The centre is not part of the shared schema: a missing one is shown together with the other messages.
          onSubmitCapture={() => setCentreMissing(!target)}
          onSubmit={async (values) => {
            if (!target) {
              setCentreMissing(true);
              return;
            }
            await api.access.request(target.id, { ...values, ticketId: ticket?.id });
            await Promise.all([keys.access.all, keys.tenants.all].map((queryKey) => queryClient.invalidateQueries({ queryKey })));
            toasts.success(t('access.request.done'), t('access.request.doneText', { name: target.name }));
            onOpenChange(false);
          }}
        >
          <DialogHeader>
            <DialogTitle>{centre ? t('access.request.titleFor', { name: centre.name }) : t('access.request.title')}</DialogTitle>
            <DialogDescription>{t('access.request.text')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            {centre ? null : (
              <Field
                label={
                  <>
                    {t('pc.centre')}
                    <span aria-hidden="true" className="ms-0.5 text-destructive-text">
                      {' *'}
                    </span>
                  </>
                }
                htmlFor={`${id}-centre`}
              >
                <TenantPicker
                  id={`${id}-centre`}
                  value={picked?.id}
                  selectedLabel={picked?.name}
                  aria-invalid={centreMissing && !picked}
                  onChange={(_, tenant) => {
                    setPicked(tenant);
                    setCentreMissing(false);
                  }}
                />
                {centreMissing && !picked ? (
                  <p role="alert" className="text-sm text-destructive-text">
                    {t('validation.required')}
                  </p>
                ) : null}
              </Field>
            )}

            <FormField name="reason" label={t('access.request.reason')} required hint={t('access.request.reasonHint')}>
              {(field) => <Textarea {...field} rows={3} maxLength={1000} dir="auto" />}
            </FormField>

            <FormField name="scopes" label={t('access.request.scopes')} required hint={t('access.request.scopesHint')}>
              {(field) => {
                const value: string[] = Array.isArray(field.value) ? field.value : [];
                return (
                  <ul
                    id={field.id}
                    role="group"
                    aria-label={t('access.request.scopes')}
                    aria-invalid={field['aria-invalid']}
                    aria-describedby={field['aria-describedby']}
                    className={cn('grid gap-x-6 gap-y-3 rounded-lg border p-3 sm:grid-cols-2', field['aria-invalid'] && 'border-destructive')}
                  >
                    {ACCESS_SCOPES.map((scope, index) => (
                      <li key={scope}>
                        <ChoiceLabel
                          htmlFor={`${id}-${scope}`}
                          control={
                            <Checkbox
                              id={`${id}-${scope}`}
                              ref={index === 0 ? field.ref : undefined}
                              checked={value.includes(scope)}
                              onCheckedChange={(checked) => {
                                field.onChange(checked === true ? [...value.filter((s) => s !== scope), scope] : value.filter((s) => s !== scope));
                                field.onBlur();
                              }}
                            />
                          }
                          label={
                            <span className="inline-flex items-center gap-1.5">
                              {t(`${scopeKey(scope)}.label`)}
                              {SENSITIVE_SCOPES.has(scope) ? <ShieldAlert className="size-3.5 text-warning-text" aria-hidden="true" /> : null}
                            </span>
                          }
                          description={t(`${scopeKey(scope)}.text`)}
                        />
                      </li>
                    ))}
                  </ul>
                );
              }}
            </FormField>

            <FormField name="durationMinutes" label={t('access.request.duration')} hint={t('access.request.durationHint')} className="sm:max-w-xs">
              {(field) => <Select {...field} value={String(field.value)} onValueChange={(v) => field.onChange(Number(v))} options={DURATIONS.map((m) => ({ value: String(m), label: duration(m) }))} />}
            </FormField>

            {ticket ? <p className="text-sm text-muted-foreground">{t('access.request.forTicket', { number: ticket.ticketNo })}</p> : null}

            <Alert tone="info" title={t('access.request.nextTitle')}>
              {t('access.request.nextText')}
            </Alert>
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={form.formState.isSubmitting}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {t('access.request.submit')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
