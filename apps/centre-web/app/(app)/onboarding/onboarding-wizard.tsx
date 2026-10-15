'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, CheckCircle2, Hourglass, PartyPopper } from 'lucide-react';
import { Button, Card, CardContent, PageHeader, RequirePermission, Skeleton, cn, focusRing, useApi, useI18n, useSession } from '@typease/ui';
import { CardSkeleton, LoadError } from '@/components/adm/shared';
import type { OnboardingState, OnboardingStepKey } from '@/components/adm/types';
import { admKeys } from '@/lib/keys/adm';
import { AccountStep, BranchesStep, BrandingStep, BusinessStep, FinishStep, PlanStep, ServicesStep, StaffStep } from './steps';

export type WizardStep = OnboardingStepKey | 'finish';
const ORDER: WizardStep[] = ['account', 'business', 'plan', 'branding', 'services', 'branches', 'staff', 'finish'];

export interface StepProps {
  state: OnboardingState;
  /** Reload GET /onboarding (what is done) after a step saved something. */
  refresh: () => Promise<unknown>;
  next: () => void;
  back: (() => void) | null;
  goTo: (step: WizardStep) => void;
}

/** On a phone the steps are one row that scrolls sideways: the step that is open is kept in sight. */
function KeepStepInView({ step }: { step: string }) {
  React.useEffect(() => {
    const button = document.querySelector<HTMLElement>('main nav [aria-current="step"]');
    const list = button?.closest('ol');
    if (button && list && list.scrollWidth > list.clientWidth) button.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [step]);
  return null;
}

export function OnboardingWizard() {
  return (
    <RequirePermission anyOf={['settings.manage']}>
      <Wizard />
    </RequirePermission>
  );
}

/**
 * Set-up of a new centre, driven by GET /onboarding: which steps exist, which are done, and the
 * drafts saved so far. Every step saves through the API, so the wizard can be left and resumed
 * on any device; the step is kept in the URL (?step=business).
 */
function Wizard() {
  const { t, tn } = useI18n();
  const api = useApi();
  const router = useRouter();
  const pathname = usePathname();
  const session = useSession();
  const queryClient = useQueryClient();
  const requested = useSearchParams().get('step') as WizardStep | null;
  const onboarding = useQuery({ queryKey: admKeys.onboarding.all, queryFn: () => api.client.get<OnboardingState>('/onboarding') });

  const header = <PageHeader title={t('adm.onboarding.title')} description={t('adm.onboarding.description', { centre: session.tenant?.name ?? '' })} />;
  if (onboarding.isPending) {
    return (
      <>
        {header}
        <div className="grid gap-6 lg:grid-cols-[17rem_minmax(0,1fr)]">
          <Skeleton className="hidden h-96 lg:block" />
          <CardSkeleton lines={6} />
        </div>
      </>
    );
  }
  if (onboarding.isError) {
    return (
      <>
        {header}
        <LoadError error={onboarding.error} onRetry={() => void onboarding.refetch()} />
      </>
    );
  }

  const state = onboarding.data;
  if (state.completed) return <Completed status={state.tenantStatus} />;

  const done = (key: WizardStep) => (key === 'finish' ? false : (state.steps.find((s) => s.key === key)?.done ?? false));
  const required = (key: WizardStep) => (key === 'finish' ? true : (state.steps.find((s) => s.key === key)?.required ?? false));
  // Resume where the person left off: the first required step that is still open.
  const resume: WizardStep = ORDER.find((key) => key !== 'finish' && required(key) && !done(key)) ?? 'finish';
  const current: WizardStep = requested && ORDER.includes(requested) ? requested : resume;
  const index = ORDER.indexOf(current);
  const goTo = (step: WizardStep) => {
    router.push(`${pathname}?step=${step}`, { scroll: false });
    window.scrollTo({ top: 0 });
  };
  const requiredSteps = state.steps.filter((s) => s.required);
  const requiredDone = requiredSteps.filter((s) => s.done).length;

  const props: StepProps = {
    state,
    refresh: () => queryClient.invalidateQueries({ queryKey: admKeys.onboarding.all }),
    next: () => goTo(ORDER[Math.min(index + 1, ORDER.length - 1)]),
    back: index > 0 ? () => goTo(ORDER[index - 1]) : null,
    goTo,
  };

  return (
    <>
      {header}
      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-6 lg:grid-cols-[17rem_minmax(0,1fr)]">
        <nav aria-label={t('adm.onboarding.stepsLabel')} className="min-w-0 lg:sticky lg:top-20">
          <div className="mb-3">
            <p className="text-sm font-medium">{t('adm.onboarding.progress', { done: requiredDone, total: requiredSteps.length })}</p>
            <div role="progressbar" aria-label={t('adm.onboarding.progressLabel')} aria-valuemin={0} aria-valuemax={requiredSteps.length} aria-valuenow={requiredDone} className="mt-1.5 h-2 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-success transition-[width]" style={{ width: `${(requiredDone / Math.max(1, requiredSteps.length)) * 100}%` }} />
            </div>
          </div>
          <KeepStepInView step={current} />
          <ol className="scroll-quiet flex gap-2 overflow-x-auto pb-1 lg:flex-col lg:gap-1 lg:overflow-visible lg:pb-0">
            {ORDER.map((key, i) => {
              const isCurrent = key === current;
              const isDone = done(key);
              return (
                <li key={key} className="shrink-0">
                  <button
                    type="button"
                    onClick={() => goTo(key)}
                    aria-current={isCurrent ? 'step' : undefined}
                    className={cn('flex w-full items-center gap-2.5 rounded-md border px-3 py-2 text-start text-base lg:border-transparent', isCurrent ? 'border-secondary bg-secondary-soft font-medium text-foreground' : 'bg-card text-muted-foreground hover:text-foreground lg:bg-transparent lg:hover:bg-muted', focusRing)}
                  >
                    <span
                      aria-hidden="true"
                      className={cn('tabular flex size-6 shrink-0 items-center justify-center rounded-full border-2 text-xs font-semibold', isDone ? 'border-success bg-success text-success-foreground' : isCurrent ? 'border-secondary bg-secondary text-secondary-foreground' : 'border-input bg-card')}
                    >
                      {isDone ? <Check className="size-3.5" strokeWidth={3.5} /> : i + 1}
                    </span>
                    <span className="whitespace-nowrap lg:whitespace-normal">
                      {t(`adm.onboarding.steps.${key}`)}
                      {key !== 'finish' && !required(key) ? <span className="ms-1.5 text-sm font-normal text-muted-foreground">({t('common.optional')})</span> : null}
                      <span className="sr-only">{isDone ? `, ${t('adm.onboarding.done')}` : ''}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
          <p className="mt-3 hidden text-sm text-muted-foreground lg:block">{t('adm.onboarding.resumeNote')}</p>
        </nav>

        <div className="min-w-0">
          <p className="mb-2 text-sm text-muted-foreground">{t('common.step', { current: index + 1, total: ORDER.length })}</p>
          {current === 'account' ? <AccountStep {...props} /> : null}
          {current === 'business' ? <BusinessStep {...props} /> : null}
          {current === 'plan' ? <PlanStep {...props} /> : null}
          {current === 'branding' ? <BrandingStep {...props} /> : null}
          {current === 'services' ? <ServicesStep {...props} /> : null}
          {current === 'branches' ? <BranchesStep {...props} /> : null}
          {current === 'staff' ? <StaffStep {...props} /> : null}
          {current === 'finish' ? <FinishStep {...props} /> : null}
          {requiredDone < requiredSteps.length ? <p className="mt-4 text-sm text-muted-foreground">{tn('adm.onboarding.remaining', requiredSteps.length - requiredDone)}</p> : null}
        </div>
      </div>
    </>
  );
}

/** The end state: the centre is operational, or it waits for TypEase to approve it. */
function Completed({ status }: { status: string }) {
  const { t } = useI18n();
  const waiting = status === 'PENDING_APPROVAL';
  return (
    <>
      <PageHeader title={t('adm.onboarding.title')} />
      <Card className="mx-auto max-w-2xl">
        <CardContent className="flex flex-col items-center px-6 py-12 text-center">
          <span aria-hidden="true" className={cn('mb-5 flex size-14 items-center justify-center rounded-full', waiting ? 'bg-warning-soft text-warning-text' : 'bg-success-soft text-success-text')}>
            {waiting ? <Hourglass className="size-7" /> : <PartyPopper className="size-7" />}
          </span>
          <h2 className="text-xl font-semibold">{waiting ? t('adm.onboarding.completed.waitingTitle') : t('adm.onboarding.completed.readyTitle')}</h2>
          <p className="mt-2 max-w-md text-base text-muted-foreground">{waiting ? t('adm.onboarding.completed.waitingText') : status === 'TRIAL' ? t('adm.onboarding.completed.trialText') : t('adm.onboarding.completed.readyText')}</p>
          {waiting ? null : (
            <ul className="mt-6 space-y-2 text-start text-base">
              {(['next1', 'next2', 'next3'] as const).map((k) => (
                <li key={k} className="flex items-start gap-2">
                  <CheckCircle2 className="mt-1 size-4 shrink-0 text-success-text" aria-hidden="true" />
                  {t(`adm.onboarding.completed.${k}`)}
                </li>
              ))}
            </ul>
          )}
          <div className="mt-8 flex flex-wrap justify-center gap-2">
            <Button asChild variant={waiting ? 'outline' : 'accent'} size="lg">
              <Link href="/dashboard">{t('adm.onboarding.completed.dashboard')}</Link>
            </Button>
            {waiting ? null : (
              <Button asChild variant="outline" size="lg">
                <Link href="/requests/new">{t('adm.onboarding.completed.firstRequest')}</Link>
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </>
  );
}
