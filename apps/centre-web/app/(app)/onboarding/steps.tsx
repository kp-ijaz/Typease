'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, Check, CheckCircle2, CircleDashed, MailPlus, MapPin, PackagePlus, Pencil, Plus } from 'lucide-react';
import type { Page } from '@typease/types';
import type { PublicPlan } from '@typease/api-client';
import { brandingSchema, onboardingBusinessSchema } from '@typease/validation';
import {
  Alert, Badge, Button, Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle, ChoiceLabel, CodeInput, DevTokenHint, Form, FormError, FormField, Input, PhoneInput, RadioGroup,
  RadioGroupItem, Select, Skeleton, cn, formatPhone, useApi, useI18n, useSession, useToast, useZodForm,
} from '@typease/ui';
import { BranchDialog } from '@/components/adm/branch-dialog';
import { ActionError, Field, LoadError, useEmirateName, useEmirateOptions, useHoursSummary } from '@/components/adm/shared';
import { InviteStaffDialog } from '@/components/adm/staff-dialogs';
import type { BranchRow, BrandingState, StaffMember, TenantDetail } from '@/components/adm/types';
import { admKeys } from '@/lib/keys/adm';
import { keys } from '@/lib/query-keys';
import type { StepProps, WizardStep } from './onboarding-wizard';

/** Draft slots of GET /onboarding (`draft.step2` ...), one per step that has a form. */
const DRAFT = { business: 2, plan: 3 } as const;

/** Frame of one step: title, what it is for, the content and the Back / Continue row. */
function StepCard({ title, description, children, back, actions }: { title: string; description: string; children: React.ReactNode; back: (() => void) | null; actions: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle className="text-lg">{title}</CardTitle>
          <CardDescription className="text-base">{description}</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">{children}</CardContent>
      <CardFooter className="flex-col-reverse items-stretch justify-between sm:flex-row sm:items-center">
        {back ? (
          <Button variant="outline" onClick={back}>
            {t('common.back')}
          </Button>
        ) : (
          <span />
        )}
        <span className="flex flex-col-reverse gap-2 sm:flex-row">{actions}</span>
      </CardFooter>
    </Card>
  );
}

function Tick({ done, children }: { done: boolean; children: React.ReactNode }) {
  return (
    <p className={cn('flex items-start gap-2.5 text-base', done ? 'text-foreground' : 'text-muted-foreground')}>
      {done ? <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success-text" aria-hidden="true" /> : <CircleDashed className="mt-0.5 size-5 shrink-0" aria-hidden="true" />}
      <span>{children}</span>
    </p>
  );
}

// ---------------------------------------------------------------- 1. account

/** Email is confirmed before the first sign-in; the mobile number is confirmed here with a 6-digit code. */
export function AccountStep({ state, refresh, next, back }: StepProps) {
  const { t } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const session = useSession();
  const user = session.user;
  const step = state.steps.find((s) => s.key === 'account');
  const id = React.useId();
  const [phone, setPhone] = React.useState(user?.phone ?? '');
  const [code, setCode] = React.useState('');
  const [sentTo, setSentTo] = React.useState<string | null>(null);
  const [devOtp, setDevOtp] = React.useState<string | null>(null);
  const [devLink, setDevLink] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<'send' | 'confirm' | 'email' | null>(null);
  const [error, setError] = React.useState<unknown>(null);

  const send = async () => {
    setBusy('send');
    setError(null);
    try {
      const reply = await api.client.post<{ status: string; dev?: { otp?: string } }>('/auth/phone/request-verification', { phone });
      setSentTo(phone);
      setCode('');
      setDevOtp(reply.dev?.otp ?? null);
      toasts.success(t('adm.onboarding.account.codeSent'), formatPhone(phone));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };
  const confirm = async () => {
    if (!sentTo) return;
    setBusy('confirm');
    setError(null);
    try {
      await api.client.post('/auth/phone/verify', { phone: sentTo, code });
      toasts.success(t('adm.onboarding.account.phoneVerified'));
      await session.reload();
      await refresh();
      setSentTo(null);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };
  const resendEmail = async () => {
    if (!user) return;
    setBusy('email');
    setError(null);
    try {
      const reply = await api.auth.resendVerification(user.email);
      setDevLink(reply.dev?.emailVerificationToken ?? null);
      toasts.success(t('adm.onboarding.account.emailSent'), user.email);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <StepCard
      title={t('adm.onboarding.account.title')}
      description={t('adm.onboarding.account.text')}
      back={back}
      actions={
        <Button onClick={next} disabled={!step?.done}>
          {t('common.continue')}
        </Button>
      }
    >
      <div className="space-y-3 rounded-lg border p-4">
        <Tick done={!!user?.emailVerified}>
          {user?.emailVerified ? t('adm.onboarding.account.emailDone', { email: user.email }) : t('adm.onboarding.account.emailPending', { email: user?.email ?? '' })}
        </Tick>
        {user && !user.emailVerified ? (
          <div className="ps-7">
            <Button variant="outline" size="sm" loading={busy === 'email'} onClick={() => void resendEmail()}>
              {t('adm.onboarding.account.resendEmail')}
            </Button>
            {devLink ? (
              <DevTokenHint>
                <Link className="text-secondary-text underline-offset-4 hover:underline" href={`/verify-email?token=${encodeURIComponent(devLink)}`}>
                  {t('auth.dev.verifyLink')}
                </Link>
              </DevTokenHint>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="space-y-4 rounded-lg border p-4">
        <Tick done={!!user?.phoneVerified}>{user?.phoneVerified ? t('adm.onboarding.account.phoneDone', { phone: formatPhone(user.phone ?? '') }) : t('adm.onboarding.account.phonePending')}</Tick>
        {user?.phoneVerified ? null : (
          <div className="space-y-4 ps-7">
            <div className="flex flex-wrap items-end gap-3">
              <Field label={t('adm.onboarding.account.phone')} htmlFor={`${id}-phone`} className="w-full sm:w-72">
                <PhoneInput id={`${id}-phone`} value={phone} onChange={setPhone} />
              </Field>
              <Button variant={sentTo ? 'outline' : 'default'} loading={busy === 'send'} disabled={!/^\+[1-9]\d{6,14}$/.test(phone) || busy !== null} onClick={() => void send()}>
                {sentTo ? t('adm.onboarding.account.resendCode') : t('adm.onboarding.account.sendCode')}
              </Button>
            </div>
            {sentTo ? (
              <div className="space-y-3">
                <Field label={t('adm.onboarding.account.code')} htmlFor={`${id}-code`} hint={t('adm.onboarding.account.codeHint', { phone: formatPhone(sentTo) })} className="max-w-xs">
                  <CodeInput id={`${id}-code`} value={code} onChange={setCode} autoFocus />
                </Field>
                {devOtp ? <DevTokenHint>{t('auth.dev.otp', { code: devOtp })}</DevTokenHint> : null}
                <Button loading={busy === 'confirm'} disabled={code.length !== 6 || busy !== null} onClick={() => void confirm()}>
                  {t('adm.onboarding.account.confirmCode')}
                </Button>
              </div>
            ) : null}
            {step?.done ? <p className="text-sm text-muted-foreground">{t('adm.onboarding.account.phoneOptional')}</p> : null}
          </div>
        )}
      </div>
      <ActionError error={error} />
    </StepCard>
  );
}

// ---------------------------------------------------------------- 2. business

export function BusinessStep({ state, refresh, next, back }: StepProps) {
  const api = useApi();
  const tenant = useQuery({ queryKey: admKeys.tenant.detail, queryFn: () => api.client.get<TenantDetail>('/tenant') });
  if (tenant.isPending) return <Skeleton className="h-96" />;
  if (tenant.isError) return <LoadError error={tenant.error} onRetry={() => void tenant.refetch()} />;
  return <BusinessForm tenant={tenant.data} state={state} refresh={refresh} next={next} back={back} />;
}

function BusinessForm({ tenant, state, refresh, next, back }: Pick<StepProps, 'state' | 'refresh' | 'next' | 'back'> & { tenant: TenantDetail }) {
  const { t } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const session = useSession();
  const queryClient = useQueryClient();
  const emirates = useEmirateOptions();
  const draft = (state.draft?.[`step${DRAFT.business}`] ?? {}) as Record<string, string | undefined>;
  const form = useZodForm(onboardingBusinessSchema, {
    emptyAs: 'null',
    defaultValues: {
      legalName: draft.legalName ?? tenant.legalName ?? '',
      tradeLicenceNo: draft.tradeLicenceNo ?? tenant.tradeLicenceNo ?? '',
      taxRegistrationNo: draft.taxRegistrationNo ?? tenant.taxRegistrationNo ?? '',
      emirate: (draft.emirate ?? tenant.emirate ?? '') as 'Dubai',
      contactEmail: draft.contactEmail ?? tenant.contactEmail ?? '',
      contactPhone: draft.contactPhone ?? tenant.contactPhone ?? '',
      defaultLanguage: ((draft.defaultLanguage ?? tenant.defaultLanguage) === 'ar' ? 'ar' : 'en') as 'en' | 'ar',
    },
  });

  // Unfinished input is saved as a draft on the server a moment after typing stops, and when the step is left.
  const [draftSaved, setDraftSaved] = React.useState(false);
  const watched = JSON.stringify(form.watch());
  const lastSaved = React.useRef(watched);
  const saveDraft = React.useCallback(async () => {
    const snapshot = JSON.stringify(form.getValues());
    if (snapshot === lastSaved.current) return;
    try {
      await api.client.put('/onboarding/draft', { step: DRAFT.business, data: form.getValues() });
      lastSaved.current = snapshot;
      setDraftSaved(true);
    } catch {
      /* a draft that could not be saved must not interrupt typing; the form itself is saved on Continue */
    }
  }, [api, form]);
  React.useEffect(() => {
    if (watched === lastSaved.current) return;
    setDraftSaved(false);
    const timer = window.setTimeout(() => void saveDraft(), 1200);
    return () => window.clearTimeout(timer);
  }, [watched, saveDraft]);

  return (
    <Form
      form={form}
      onSubmit={async (values) => {
        await api.client.put('/onboarding/business', values);
        toasts.success(t('adm.onboarding.business.saved'));
        await queryClient.invalidateQueries({ queryKey: admKeys.tenant.all });
        await queryClient.invalidateQueries({ queryKey: keys.tenantConfig(tenant.slug) });
        await session.reload();
        await refresh();
        next();
      }}
    >
      <StepCard
        title={t('adm.onboarding.business.title')}
        description={t('adm.onboarding.business.text')}
        back={
          back
            ? () => {
                void saveDraft();
                back();
              }
            : null
        }
        actions={
          <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
            {t('adm.onboarding.saveContinue')}
          </Button>
        }
      >
        <div className="grid gap-5 sm:grid-cols-2">
          <FormField name="legalName" label={t('adm.settings.profile.legalName')} required hint={t('adm.settings.profile.legalNameHint')} className="sm:col-span-2">
            {(field) => <Input {...field} autoComplete="organization" autoFocus />}
          </FormField>
          <FormField name="tradeLicenceNo" label={t('adm.settings.profile.tradeLicence')} optional>
            {(field) => <Input {...field} autoComplete="off" dir="ltr" className="tabular" />}
          </FormField>
          <FormField name="taxRegistrationNo" label={t('adm.settings.profile.trn')} optional hint={t('adm.settings.profile.trnHint')}>
            {(field) => <Input {...field} autoComplete="off" dir="ltr" className="tabular" />}
          </FormField>
          <FormField name="emirate" label={t('adm.settings.profile.emirate')} required>
            {(field) => <Select {...field} onValueChange={field.onChange} options={emirates} placeholder={t('common.selectPlaceholder')} />}
          </FormField>
          <FormField name="defaultLanguage" label={t('adm.settings.profile.language')} hint={t('adm.settings.profile.languageHint')}>
            {(field) => (
              <Select
                {...field}
                onValueChange={field.onChange}
                options={[
                  { value: 'en', label: 'English' },
                  { value: 'ar', label: 'العربية' },
                ]}
              />
            )}
          </FormField>
          <FormField name="contactEmail" label={t('adm.settings.profile.email')} required>
            {(field) => <Input {...field} type="email" inputMode="email" autoComplete="off" autoCapitalize="none" spellCheck={false} dir="ltr" />}
          </FormField>
          <FormField name="contactPhone" label={t('adm.settings.profile.phone')} required>
            {(field) => <PhoneInput {...field} />}
          </FormField>
        </div>
        <FormError />
        <p className="text-sm text-muted-foreground" role="status">
          {draftSaved ? t('adm.onboarding.draftSaved') : t('adm.onboarding.draftNote')}
        </p>
      </StepCard>
    </Form>
  );
}

// ---------------------------------------------------------------- 3. plan

const PLAN_LIMITS = ['branches', 'staffUsers', 'monthlyRequests'] as const;
const PLAN_FEATURES = ['corporatePortal', 'automation', 'aiAssistant', 'whiteLabel', 'customDomains'] as const;

export function PlanStep({ state, refresh, next, back }: StepProps) {
  const { t, formatMoney, formatDate, formatNumber } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const plans = useQuery({ queryKey: admKeys.plans, queryFn: () => api.public.plans() as Promise<PublicPlan[]>, staleTime: 10 * 60_000, enabled: !state.plan });
  const draft = (state.draft?.[`step${DRAFT.plan}`] ?? {}) as { planKey?: string; billingCycle?: 'MONTHLY' | 'ANNUAL'; couponCode?: string };
  const [planKey, setPlanKey] = React.useState<string>(draft.planKey ?? '');
  const [cycle, setCycle] = React.useState<'MONTHLY' | 'ANNUAL'>(draft.billingCycle ?? 'MONTHLY');
  const [coupon, setCoupon] = React.useState(draft.couponCode ?? '');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  const [invoiceId, setInvoiceId] = React.useState<string | null>(null);
  const id = React.useId();

  if (state.plan) {
    return (
      <StepCard
        title={t('adm.onboarding.plan.title')}
        description={t('adm.onboarding.plan.chosenText')}
        back={back}
        actions={<Button onClick={next}>{t('common.continue')}</Button>}
      >
        <div className="space-y-3 rounded-lg border p-4">
          <Tick done>
            <span className="font-medium">{t('adm.onboarding.plan.chosen', { plan: state.plan.name })}</span>
          </Tick>
          <p className="ps-7 text-base text-muted-foreground">
            {state.plan.status === 'TRIALING' && state.plan.trialEndsAt ? t('adm.onboarding.plan.trialUntil', { date: formatDate(state.plan.trialEndsAt, 'long') }) : state.plan.status === 'PAST_DUE' ? t('adm.onboarding.plan.paymentDue') : t('adm.onboarding.plan.active')}
          </p>
          {invoiceId || state.plan.status === 'PAST_DUE' ? (
            <Button asChild variant="outline" className="ms-7">
              <Link href={invoiceId ? `/subscription?invoice=${invoiceId}` : '/subscription'}>{t('adm.onboarding.plan.payInvoice')}</Link>
            </Button>
          ) : null}
        </div>
        <p className="text-sm text-muted-foreground">
          {t('adm.onboarding.plan.changeLater')}{' '}
          <Link href="/subscription" className="text-secondary-text underline-offset-4 hover:underline">
            {t('adm.onboarding.plan.subscriptionLink')}
          </Link>
        </p>
      </StepCard>
    );
  }

  const list = plans.data ?? [];
  const selected = list.find((p) => p.key === planKey) ?? null;
  const saveDraft = () => void api.client.put('/onboarding/draft', { step: DRAFT.plan, data: { planKey, billingCycle: cycle, couponCode: coupon } }).catch(() => undefined);

  const choose = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const reply = await api.client.post<{ outcome: 'TRIAL_STARTED' | 'PAYMENT_REQUIRED' | 'ACTIVE'; invoiceId: string | null }>('/onboarding/plan', { planKey: selected.key, billingCycle: cycle, couponCode: coupon.trim() || undefined });
      await queryClient.invalidateQueries({ queryKey: admKeys.tenant.usage });
      await queryClient.invalidateQueries({ queryKey: admKeys.subscription.all });
      await refresh();
      if (reply.outcome === 'PAYMENT_REQUIRED') {
        setInvoiceId(reply.invoiceId);
        toasts.info(t('adm.onboarding.plan.invoiceIssued'), t('adm.onboarding.plan.invoiceIssuedText'));
      } else {
        toasts.success(reply.outcome === 'TRIAL_STARTED' ? t('adm.onboarding.plan.trialStarted') : t('adm.onboarding.plan.started'), selected.name);
        next();
      }
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <StepCard
      title={t('adm.onboarding.plan.title')}
      description={t('adm.onboarding.plan.text')}
      back={
        back
          ? () => {
              if (planKey) saveDraft();
              back();
            }
          : null
      }
      actions={
        <Button onClick={() => void choose()} disabled={!selected} loading={busy} loadingText={t('common.saving')}>
          {selected ? (selected.trialDays > 0 ? t('adm.onboarding.plan.startTrial', { plan: selected.name }) : t('adm.onboarding.plan.choose', { plan: selected.name })) : t('adm.onboarding.plan.chooseOne')}
        </Button>
      }
    >
      <RadioGroup value={cycle} onValueChange={(v) => setCycle(v as 'MONTHLY' | 'ANNUAL')} aria-label={t('adm.onboarding.plan.cycle')} className="flex flex-wrap gap-x-8 gap-y-2">
        <ChoiceLabel htmlFor={`${id}-m`} control={<RadioGroupItem id={`${id}-m`} value="MONTHLY" />} label={t('adm.onboarding.plan.monthly')} />
        <ChoiceLabel htmlFor={`${id}-a`} control={<RadioGroupItem id={`${id}-a`} value="ANNUAL" />} label={t('adm.onboarding.plan.annual')} />
      </RadioGroup>

      {plans.isPending ? (
        <div className="grid gap-4 md:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-56" />
          ))}
        </div>
      ) : plans.isError ? (
        <LoadError error={plans.error} onRetry={() => void plans.refetch()} />
      ) : (
        <RadioGroup value={planKey} onValueChange={setPlanKey} aria-label={t('adm.onboarding.plan.title')} className="grid gap-4 md:grid-cols-2">
          {list.map((p) => {
            const active = p.key === planKey;
            return (
              <label key={p.key} htmlFor={`${id}-p-${p.key}`} className={cn('flex cursor-pointer flex-col rounded-lg border p-4 transition-colors', active ? 'border-secondary bg-secondary-soft/50 ring-1 ring-secondary' : 'hover:bg-muted/40')}>
                <span className="flex items-start justify-between gap-3">
                  <span>
                    <span className="block text-md font-semibold">{p.name}</span>
                    {p.description ? (
                      <span className="mt-0.5 block text-sm text-muted-foreground" dir="auto">
                        {p.description}
                      </span>
                    ) : null}
                  </span>
                  <RadioGroupItem id={`${id}-p-${p.key}`} value={p.key} />
                </span>
                <span className="mt-3 block">
                  <span className="tabular text-2xl font-semibold">{formatMoney(cycle === 'ANNUAL' ? p.annualPrice : p.monthlyPrice, p.currency)}</span>{' '}
                  <span className="text-sm text-muted-foreground">{cycle === 'ANNUAL' ? t('adm.onboarding.plan.perYear') : t('adm.onboarding.plan.perMonth')}</span>
                </span>
                {cycle === 'ANNUAL' && Number(p.annualSaving) > 0 ? <span className="mt-1 block text-sm text-success-text">{t('adm.onboarding.plan.saving', { amount: formatMoney(p.annualSaving, p.currency) })}</span> : null}
                {p.trialDays > 0 ? (
                  <span className="mt-2">
                    <Badge tone="info">{t('adm.onboarding.plan.trialBadge', { days: formatNumber(p.trialDays) })}</Badge>
                  </span>
                ) : null}
                <ul className="mt-3 space-y-1 text-sm">
                  {PLAN_LIMITS.map((k) => (
                    <li key={k} className="flex items-start gap-2">
                      <Check className="mt-0.5 size-4 shrink-0 text-success-text" aria-hidden="true" />
                      {t(`adm.onboarding.plan.limits.${k}`, { count: p.limits[k] < 0 ? t('adm.onboarding.plan.unlimited') : formatNumber(p.limits[k]) })}
                    </li>
                  ))}
                  {PLAN_FEATURES.filter((k) => p.features[k]).map((k) => (
                    <li key={k} className="flex items-start gap-2">
                      <Check className="mt-0.5 size-4 shrink-0 text-success-text" aria-hidden="true" />
                      {t(`adm.settings.plan.features.${k}`)}
                    </li>
                  ))}
                </ul>
              </label>
            );
          })}
        </RadioGroup>
      )}

      <Alert tone="info" title={t('adm.onboarding.plan.trialTitle')}>
        {t('adm.onboarding.plan.trialText')}
      </Alert>

      <Field label={t('adm.onboarding.plan.coupon')} htmlFor={`${id}-coupon`} hint={t('adm.onboarding.plan.couponHint')} className="max-w-xs">
        <Input id={`${id}-coupon`} value={coupon} onChange={(e) => setCoupon(e.target.value.toUpperCase().slice(0, 40))} autoComplete="off" dir="ltr" className="tabular" />
      </Field>
      <ActionError error={error} />
    </StepCard>
  );
}

// ---------------------------------------------------------------- 4. branding (optional, slim)

const slimBranding = brandingSchema.pick({ businessName: true, businessNameAr: true, supportEmail: true, supportPhone: true });

export function BrandingStep({ refresh, next, back }: StepProps) {
  const api = useApi();
  const branding = useQuery({ queryKey: admKeys.branding.all, queryFn: () => api.client.get<BrandingState>('/branding') });
  if (branding.isPending) return <Skeleton className="h-80" />;
  if (branding.isError) return <LoadError error={branding.error} onRetry={() => void branding.refetch()} />;
  return <BrandingSlimForm data={branding.data} refresh={refresh} next={next} back={back} />;
}

function BrandingSlimForm({ data, refresh, next, back }: Pick<StepProps, 'refresh' | 'next' | 'back'> & { data: BrandingState }) {
  const { t } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const session = useSession();
  const queryClient = useQueryClient();
  const row = data.tenant;
  const form = useZodForm(slimBranding, {
    emptyAs: 'null',
    defaultValues: { businessName: row?.businessName ?? session.tenant?.name ?? '', businessNameAr: row?.businessNameAr ?? '', supportEmail: row?.supportEmail ?? '', supportPhone: row?.supportPhone ?? '' },
  });
  return (
    <Form
      form={form}
      onSubmit={async (values) => {
        await api.client.put('/branding', values);
        toasts.success(t('adm.branding.saved'));
        await queryClient.invalidateQueries({ queryKey: admKeys.branding.all });
        await queryClient.invalidateQueries({ queryKey: keys.tenantConfig(session.tenant?.slug ?? '') });
        await refresh();
        next();
      }}
    >
      <StepCard
        title={t('adm.onboarding.branding.title')}
        description={t('adm.onboarding.branding.text')}
        back={back}
        actions={
          <>
            <Button variant="outline" onClick={next}>
              {t('adm.onboarding.skip')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {t('adm.onboarding.saveContinue')}
            </Button>
          </>
        }
      >
        <div className="grid gap-5 sm:grid-cols-2">
          <FormField name="businessName" label={t('adm.branding.fields.businessName')}>
            {(field) => <Input {...field} autoComplete="off" dir="ltr" lang="en" />}
          </FormField>
          <FormField name="businessNameAr" label={t('adm.branding.fields.businessNameAr')}>
            {(field) => <Input {...field} autoComplete="off" dir="rtl" lang="ar" />}
          </FormField>
          <FormField name="supportEmail" label={t('adm.branding.fields.supportEmail')}>
            {(field) => <Input {...field} type="email" inputMode="email" autoComplete="off" autoCapitalize="none" spellCheck={false} dir="ltr" />}
          </FormField>
          <FormField name="supportPhone" label={t('adm.branding.fields.supportPhone')}>
            {(field) => <PhoneInput {...field} />}
          </FormField>
        </div>
        <FormError />
        <Alert
          tone="info"
          title={data.whiteLabelIncluded ? t('adm.onboarding.branding.whiteLabelTitle') : t('adm.onboarding.branding.typeaseTitle')}
          action={
            <Button asChild size="sm" variant="outline">
              <Link href="/branding">
                <ArrowUpRight className="rtl-mirror" aria-hidden="true" />
                {t('adm.onboarding.branding.open')}
              </Link>
            </Button>
          }
        >
          {data.whiteLabelIncluded ? t('adm.onboarding.branding.whiteLabelText') : t('adm.onboarding.branding.typeaseText')}
        </Alert>
      </StepCard>
    </Form>
  );
}

// ---------------------------------------------------------------- 5. services

export function ServicesStep({ state, refresh, next, back }: StepProps) {
  const { t, tn } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const session = useSession();
  const queryClient = useQueryClient();
  const canRead = session.hasPermission('service.read');
  const count = useQuery({ queryKey: ['services', 'onboarding-count'], queryFn: () => api.client.get<Page<unknown>>('/services', { query: { pageSize: 1 } }), enabled: canRead, select: (page) => page.meta.total });
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  const [installed, setInstalled] = React.useState<{ createdCount: number; skippedCount: number } | null>(null);
  const done = state.steps.find((s) => s.key === 'services')?.done ?? false;

  const install = async () => {
    setBusy(true);
    setError(null);
    try {
      const reply = await api.client.post<{ created: string[]; skipped: string[]; createdCount: number; skippedCount: number }>('/services/starter-catalogue');
      setInstalled(reply);
      toasts.success(t('adm.onboarding.services.installed'), tn('adm.onboarding.services.installedCount', reply.createdCount));
      await queryClient.invalidateQueries({ queryKey: ['services'] });
      await refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <StepCard
      title={t('adm.onboarding.services.title')}
      description={t('adm.onboarding.services.text')}
      back={back}
      actions={
        <Button onClick={next} disabled={!done}>
          {t('common.continue')}
        </Button>
      }
    >
      <Tick done={done}>{done ? (count.data !== undefined ? tn('adm.onboarding.services.have', count.data) : t('adm.onboarding.services.haveSome')) : t('adm.onboarding.services.none')}</Tick>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="flex flex-col rounded-lg border p-4">
          <p className="text-md font-semibold">{t('adm.onboarding.services.starterTitle')}</p>
          <p className="mt-1 flex-1 text-base text-muted-foreground">{t('adm.onboarding.services.starterText')}</p>
          <Button className="mt-4 self-start" variant={done ? 'outline' : 'default'} loading={busy} loadingText={t('adm.onboarding.services.installing')} disabled={!session.hasPermission('service.manage')} onClick={() => void install()}>
            <PackagePlus aria-hidden="true" />
            {t('adm.onboarding.services.install')}
          </Button>
        </div>
        <div className="flex flex-col rounded-lg border p-4">
          <p className="text-md font-semibold">{t('adm.onboarding.services.ownTitle')}</p>
          <p className="mt-1 flex-1 text-base text-muted-foreground">{t('adm.onboarding.services.ownText')}</p>
          <Button asChild variant="outline" className="mt-4 self-start">
            <Link href="/services">
              <ArrowUpRight className="rtl-mirror" aria-hidden="true" />
              {t('adm.onboarding.services.open')}
            </Link>
          </Button>
        </div>
      </div>
      {installed ? (
        <Alert tone="success" live title={tn('adm.onboarding.services.installedCount', installed.createdCount)}>
          {installed.skippedCount ? tn('adm.onboarding.services.skipped', installed.skippedCount) : t('adm.onboarding.services.review')}
        </Alert>
      ) : null}
      <ActionError error={error} />
    </StepCard>
  );
}

// ---------------------------------------------------------------- 6. branches

export function BranchesStep({ state, refresh, next, back }: StepProps) {
  const { t, pick } = useI18n();
  const api = useApi();
  const summary = useHoursSummary();
  const emirate = useEmirateName();
  const branches = useQuery({ queryKey: admKeys.branches.admin, queryFn: () => api.client.get<BranchRow[]>('/branches', { query: { includeInactive: true } }) });
  const [dialog, setDialog] = React.useState<{ branch: BranchRow | null } | null>(null);
  const done = state.steps.find((s) => s.key === 'branches')?.done ?? false;
  const active = (branches.data ?? []).filter((b) => b.isActive);

  return (
    <StepCard
      title={t('adm.onboarding.branches.title')}
      description={t('adm.onboarding.branches.text')}
      back={back}
      actions={
        <Button onClick={next} disabled={!done}>
          {t('common.continue')}
        </Button>
      }
    >
      {branches.isPending ? (
        <Skeleton className="h-24" />
      ) : branches.isError ? (
        <LoadError error={branches.error} onRetry={() => void branches.refetch()} />
      ) : (
        <ul className="divide-y rounded-lg border">
          {active.map((b) => (
            <li key={b.id} className="flex flex-wrap items-start justify-between gap-3 p-4">
              <div className="min-w-0 space-y-1">
                <p className="flex flex-wrap items-center gap-2 font-medium">
                  {pick(b.name, b.nameAr)}
                  {b.isHeadOffice ? <Badge tone="brand">{t('adm.branches.headOffice')}</Badge> : null}
                </p>
                <p className="flex items-start gap-2 text-sm text-muted-foreground">
                  <MapPin className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  <span dir="auto">{[b.address, emirate(b.emirate)].filter(Boolean).join(' · ') || t('adm.branches.noAddress')}</span>
                </p>
                <p className="tabular text-sm text-muted-foreground">{summary(b.workingHours) || t('adm.branches.noHours')}</p>
                {!b.address || !b.phone ? <p className="text-sm text-warning-text">{t('adm.onboarding.branches.incomplete')}</p> : null}
              </div>
              <Button variant="subtle" size="sm" onClick={() => setDialog({ branch: b })}>
                <Pencil aria-hidden="true" />
                {t('common.edit')}
              </Button>
            </li>
          ))}
          {active.length === 0 ? <li className="p-4 text-base text-muted-foreground">{t('adm.branches.emptyText')}</li> : null}
        </ul>
      )}
      <Button variant="outline" onClick={() => setDialog({ branch: null })}>
        <Plus aria-hidden="true" />
        {t('adm.onboarding.branches.addAnother')}
      </Button>
      <BranchDialog
        open={!!dialog}
        onOpenChange={(open) => {
          if (!open) {
            setDialog(null);
            void refresh();
          }
        }}
        branch={dialog?.branch ?? null}
        first={active.length === 0}
      />
    </StepCard>
  );
}

// ---------------------------------------------------------------- 7. staff (optional)

export function StaffStep({ refresh, next, back }: StepProps) {
  const { t } = useI18n();
  const api = useApi();
  const session = useSession();
  const staff = useQuery({ queryKey: admKeys.staff.full, queryFn: () => api.client.get<StaffMember[]>('/staff') });
  const branches = useQuery({ queryKey: admKeys.branches.admin, queryFn: () => api.client.get<BranchRow[]>('/branches', { query: { includeInactive: true } }) });
  const [inviting, setInviting] = React.useState(false);
  const others = (staff.data ?? []).filter((m) => m.userId !== session.user?.id);

  return (
    <StepCard title={t('adm.onboarding.staff.title')} description={t('adm.onboarding.staff.text')} back={back} actions={<Button onClick={next}>{others.length ? t('common.continue') : t('adm.onboarding.skip')}</Button>}>
      {staff.isPending ? (
        <Skeleton className="h-16" />
      ) : staff.isError ? (
        <LoadError error={staff.error} onRetry={() => void staff.refetch()} />
      ) : others.length === 0 ? (
        <p className="rounded-lg border px-4 py-3 text-base text-muted-foreground">{t('adm.onboarding.staff.none')}</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {others.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
              <span className="min-w-0">
                <span className="block font-medium">{m.user.fullName}</span>
                <span className="ltr-value block truncate text-sm text-muted-foreground">{m.user.email}</span>
              </span>
              <Badge tone={m.status === 'INVITED' ? 'warning' : 'success'}>{m.status === 'INVITED' ? t('adm.staff.status.INVITED') : m.role.name}</Badge>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => setInviting(true)}>
          <MailPlus aria-hidden="true" />
          {t('adm.staff.invite.action')}
        </Button>
        <Button asChild variant="link">
          <Link href="/staff">{t('adm.onboarding.staff.open')}</Link>
        </Button>
      </div>
      <InviteStaffDialog
        open={inviting}
        onOpenChange={(open) => {
          setInviting(open);
          if (!open) void refresh();
        }}
        branches={branches.data ?? []}
      />
    </StepCard>
  );
}

// ---------------------------------------------------------------- 8. review and finish

export function FinishStep({ state, refresh, back, goTo }: StepProps) {
  const { t } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const session = useSession();
  const queryClient = useQueryClient();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);

  const finish = async () => {
    setBusy(true);
    setError(null);
    try {
      const reply = await api.client.post<{ status: string }>('/onboarding/complete');
      toasts.success(reply.status === 'PENDING_APPROVAL' ? t('adm.onboarding.completed.waitingTitle') : t('adm.onboarding.completed.readyTitle'));
      await session.reload();
      await queryClient.invalidateQueries({ queryKey: admKeys.tenant.all });
      await refresh();
    } catch (e) {
      setError(e);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <StepCard
      title={t('adm.onboarding.finish.title')}
      description={state.canComplete ? t('adm.onboarding.finish.readyText') : t('adm.onboarding.finish.missingText')}
      back={back}
      actions={
        <Button variant="accent" size="lg" onClick={() => void finish()} disabled={!state.canComplete} loading={busy} loadingText={t('common.saving')}>
          {t('adm.onboarding.finish.submit')}
        </Button>
      }
    >
      <ul className="divide-y rounded-lg border">
        {state.steps.map((s) => (
          <li key={s.key} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <span className="flex min-w-0 items-start gap-2.5">
              {s.done ? <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success-text" aria-hidden="true" /> : <CircleDashed className={cn('mt-0.5 size-5 shrink-0', s.required ? 'text-warning-text' : 'text-muted-foreground')} aria-hidden="true" />}
              <span>
                <span className="block font-medium">{t(`adm.onboarding.steps.${s.key}`)}</span>
                <span className="block text-sm text-muted-foreground">{s.done ? t('adm.onboarding.done') : s.required ? t('adm.onboarding.finish.needed') : t('adm.onboarding.finish.optional')}</span>
              </span>
            </span>
            <Button variant={s.done || !s.required ? 'ghost' : 'subtle'} size="sm" onClick={() => goTo(s.key as WizardStep)}>
              {s.done || !s.required ? t('adm.onboarding.finish.review') : t('adm.onboarding.finish.complete')}
            </Button>
          </li>
        ))}
      </ul>
      {state.canComplete ? <Alert tone="info">{t('adm.onboarding.finish.whatNext')}</Alert> : null}
      <ActionError error={error} />
    </StepCard>
  );
}
