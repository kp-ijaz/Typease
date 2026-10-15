'use client';

import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { PLAN_LIMIT_KEYS } from '@typease/types';
import { PLAN_FEATURES } from './features';
import { subscriptionPlanSchema, updateSubscriptionPlanSchema, type UpdateSubscriptionPlanInput } from '@typease/validation';
import {
  Button, Checkbox, ChoiceLabel, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Form, FormError, FormField, FormSection, Input, MoneyInput, Switch, useI18n,
  useToast, useZodForm,
} from '@typease/ui';
import { ConfirmAction } from '@/components/shared';
import { usePlatformApi } from '@/lib/api';
import { keys } from '@/lib/query-keys';
import type { PlatformPlan } from '@/lib/types';

/** A number field of react-hook-form: empty stays empty (and is reported as required), anything else is a number. */
const numberProps = (field: { value: unknown; onChange: (value: unknown) => void }) => ({
  value: field.value === null || field.value === undefined ? '' : String(field.value),
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => field.onChange(e.target.value === '' ? '' : Number(e.target.value)),
});

const NEW_LIMITS = { branches: 1, staffUsers: 3, monthlyRequests: 200, storageMb: 2048, aiPages: 0, notifications: 500, corporateClients: 0 };
const NEW_FEATURES = { whiteLabel: false, customDomains: false, corporatePortal: false, automation: false, aiAssistant: false, scheduledReports: false };

/**
 * Adds a plan (POST /platform/plans) or edits one (PATCH /platform/plans/:id). Two forms with
 * their own shared schema: the key and the currency of a plan are fixed once it exists.
 */
export function PlanDialog({ target, onClose }: { target: PlatformPlan | 'new' | null; onClose: () => void }) {
  const plan = target && target !== 'new' ? target : null;
  return (
    <Dialog open={!!target} onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="lg">{target === 'new' ? <CreateForm onClose={onClose} /> : plan ? <EditForm key={plan.id} plan={plan} onClose={onClose} /> : null}</DialogContent>
    </Dialog>
  );
}

function usePlanRefresh() {
  const queryClient = useQueryClient();
  // The public list (keys.plans.all) is a prefix of the admin list: one invalidation refreshes both, and the pickers that use them.
  return React.useCallback(() => Promise.all([keys.plans.all, keys.audit.all, keys.dashboard.all].map((queryKey) => queryClient.invalidateQueries({ queryKey }))), [queryClient]);
}

function CreateForm({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const api = usePlatformApi();
  const toasts = useToast();
  const refresh = usePlanRefresh();
  const form = useZodForm(subscriptionPlanSchema, {
    defaultValues: { key: '', name: '', description: '', monthlyPrice: '', annualPrice: '', currency: 'AED', trialDays: 14, limits: NEW_LIMITS, features: NEW_FEATURES, isPublic: true, isActive: true, sortOrder: 10 },
  });
  return (
    <Form
      form={form}
      className="flex min-h-0 flex-1 flex-col space-y-0"
      onSubmit={async (values) => {
        const created = await api.plans.create(values);
        await refresh();
        toasts.success(t('planAdmin.create.done', { name: created.name }));
        onClose();
      }}
    >
      <DialogHeader>
        <DialogTitle>{t('planAdmin.create.title')}</DialogTitle>
        <DialogDescription>{t('planAdmin.create.text')}</DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-6">
        <PlanFields currency={form.watch('currency') || 'AED'} withKey />
        <FormError />
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={form.formState.isSubmitting}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
          {t('planAdmin.create.submit')}
        </Button>
      </DialogFooter>
    </Form>
  );
}

function EditForm({ plan, onClose }: { plan: PlatformPlan; onClose: () => void }) {
  const { t, tn } = useI18n();
  const api = usePlatformApi();
  const toasts = useToast();
  const refresh = usePlanRefresh();
  const subscribers = plan.subscriptionCount ?? 0;
  const [pending, setPending] = React.useState<UpdateSubscriptionPlanInput | null>(null);
  const [removing, setRemoving] = React.useState(false);
  const form = useZodForm(updateSubscriptionPlanSchema, {
    emptyAs: 'null',
    defaultValues: {
      name: plan.name,
      description: plan.description ?? '',
      monthlyPrice: plan.monthlyPrice,
      annualPrice: plan.annualPrice,
      trialDays: plan.trialDays,
      limits: plan.limits,
      features: plan.features,
      isPublic: plan.isPublic,
      isActive: plan.isActive,
      sortOrder: plan.sortOrder,
    },
  });
  const save = async (values: UpdateSubscriptionPlanInput) => {
    const saved = await api.plans.update(plan.id, values);
    await refresh();
    toasts.success(t('planAdmin.update.done', { name: saved.name }));
    onClose();
  };
  return (
    <>
      <Form
        form={form}
        className="flex min-h-0 flex-1 flex-col space-y-0"
        onSubmit={async (values) => {
          // A plan with subscribers changes for all of them: that is confirmed first.
          if (subscribers > 0) return setPending(values);
          await save(values);
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('planAdmin.update.title', { name: plan.name })}</DialogTitle>
          <DialogDescription>{subscribers > 0 ? tn('planAdmin.update.text', subscribers) : t('planAdmin.update.textNone')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-6">
          <PlanFields currency={plan.currency} />
          <FormError />
        </DialogBody>
        <DialogFooter className="sm:justify-between">
          <Button variant="destructive-outline" onClick={() => setRemoving(true)} disabled={form.formState.isSubmitting}>
            <Trash2 aria-hidden="true" />
            {t('planAdmin.remove.action')}
          </Button>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button variant="outline" onClick={onClose} disabled={form.formState.isSubmitting}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {t('common.saveChanges')}
            </Button>
          </div>
        </DialogFooter>
      </Form>

      <ConfirmAction
        open={!!pending}
        onOpenChange={(open) => !open && setPending(null)}
        tone="default"
        title={t('planAdmin.update.confirmTitle', { name: plan.name })}
        description={tn('planAdmin.update.text', subscribers)}
        confirmLabel={t('common.saveChanges')}
        onConfirm={() => save(pending as UpdateSubscriptionPlanInput)}
      />
      <ConfirmAction
        open={removing}
        onOpenChange={setRemoving}
        title={t('planAdmin.remove.title', { name: plan.name })}
        description={t('planAdmin.remove.text')}
        confirmLabel={t('planAdmin.remove.action')}
        onConfirm={async () => {
          await api.plans.remove(plan.id);
          await refresh();
          toasts.success(t('planAdmin.remove.done', { name: plan.name }));
          onClose();
        }}
      />
    </>
  );
}

/** The fields both forms share. Their names are those of the shared plan schema. */
function PlanFields({ currency, withKey }: { currency: string; withKey?: boolean }) {
  const { t } = useI18n();
  const id = React.useId();
  return (
    <>
      <FormSection title={t('planAdmin.form.basics')}>
        <div className="grid gap-5 sm:grid-cols-2">
          {withKey ? (
            <FormField name="key" label={t('planAdmin.form.key')} required hint={t('planAdmin.form.keyHint')}>
              {(field) => <Input {...field} autoComplete="off" autoCapitalize="none" spellCheck={false} dir="ltr" className="font-mono" autoFocus />}
            </FormField>
          ) : null}
          <FormField name="name" label={t('planAdmin.form.name')} required>
            {(field) => <Input {...field} autoComplete="off" dir="auto" maxLength={80} />}
          </FormField>
          <FormField name="description" label={t('planAdmin.form.description')} optional hint={t('planAdmin.form.descriptionHint')} className={withKey ? 'sm:col-span-2' : undefined}>
            {(field) => <Input {...field} autoComplete="off" dir="auto" maxLength={500} />}
          </FormField>
        </div>
      </FormSection>

      <FormSection title={t('planAdmin.form.prices')} description={t('planAdmin.form.pricesText', { currency })}>
        <div className="grid gap-5 sm:grid-cols-3">
          <FormField name="monthlyPrice" label={t('planAdmin.form.monthlyPrice')} required>
            {(field) => <MoneyInput {...field} currency={currency} />}
          </FormField>
          <FormField name="annualPrice" label={t('planAdmin.form.annualPrice')} required>
            {(field) => <MoneyInput {...field} currency={currency} />}
          </FormField>
          <FormField name="trialDays" label={t('planAdmin.form.trialDays')} required hint={t('planAdmin.form.trialDaysHint')}>
            {(field) => <Input {...field} {...numberProps(field)} type="number" inputMode="numeric" dir="ltr" min={0} max={365} step={1} className="tabular" />}
          </FormField>
        </div>
      </FormSection>

      <FormSection title={t('planAdmin.form.limits')} description={t('planAdmin.form.limitsText')}>
        <div className="grid gap-5 sm:grid-cols-3">
          {PLAN_LIMIT_KEYS.map((key) => (
            <FormField key={key} name={`limits.${key}`} label={key === 'storageMb' ? t('planAdmin.form.storageMb') : t(`plans.limits.${key}`)} required>
              {(field) => <Input {...field} {...numberProps(field)} type="number" inputMode="numeric" dir="ltr" min={-1} step={1} className="tabular" />}
            </FormField>
          ))}
        </div>
      </FormSection>

      <FormSection title={t('planAdmin.form.features')}>
        <ul className="grid gap-x-8 gap-y-2.5 rounded-lg border p-3 sm:grid-cols-2">
          {PLAN_FEATURES.map((key) => (
            <li key={key}>
              <FormField name={`features.${key}`} label={t(`plans.features.${key}`)} hideLabel className="space-y-0">
                {(field) => (
                  <ChoiceLabel
                    htmlFor={`${id}-${key}`}
                    control={<Checkbox id={`${id}-${key}`} ref={field.ref} checked={field.value === true} onCheckedChange={(checked) => field.onChange(checked === true)} />}
                    label={t(`plans.features.${key}`)}
                  />
                )}
              </FormField>
            </li>
          ))}
        </ul>
      </FormSection>

      <FormSection title={t('planAdmin.form.offer')}>
        <div className="grid gap-5 sm:grid-cols-3">
          <FormField name="isActive" label={t('planAdmin.form.isActive')}>
            {(field) => (
              <div className="flex min-h-10 items-center gap-3">
                <Switch id={field.id} ref={field.ref} checked={field.value === true} onCheckedChange={field.onChange} />
                <span className="text-sm text-muted-foreground">{field.value === true ? t('planAdmin.form.isActiveOn') : t('planAdmin.form.isActiveOff')}</span>
              </div>
            )}
          </FormField>
          <FormField name="isPublic" label={t('planAdmin.form.isPublic')}>
            {(field) => (
              <div className="flex min-h-10 items-center gap-3">
                <Switch id={field.id} ref={field.ref} checked={field.value === true} onCheckedChange={field.onChange} />
                <span className="text-sm text-muted-foreground">{field.value === true ? t('planAdmin.form.isPublicOn') : t('planAdmin.form.isPublicOff')}</span>
              </div>
            )}
          </FormField>
          <FormField name="sortOrder" label={t('planAdmin.form.sortOrder')} hint={t('planAdmin.form.sortOrderHint')}>
            {(field) => <Input {...field} {...numberProps(field)} type="number" inputMode="numeric" dir="ltr" min={0} max={1000} step={1} className="tabular" />}
          </FormField>
        </div>
      </FormSection>
    </>
  );
}
