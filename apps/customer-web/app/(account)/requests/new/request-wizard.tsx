'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ChevronRight, SearchX, Store } from 'lucide-react';
import { formFields } from '@typease/validation';
import {
  Alert, Badge, Button, Card, CardContent, ConfirmDialog, EmptyState, Label, PageHeader, SearchInput, Select, Skeleton, SkeletonText, Stepper, cn, focusRing, useErrorMessage,
  useI18n, useToast,
} from '@typease/ui';
import { TILE_TONES, categoryIcon } from '@/components/catalogue';
import { missingDocuments } from '@/components/portal/checklist';
import { checkForm } from '@/components/portal/dynamic-form';
import { useApplyRequest, useRequestView } from '@/components/portal/request-hooks';
import { FeeEstimate, ProcessingTime, RequirementList } from '@/components/portal/service-info';
import { LoadError, Money, NotFoundCard, isNotFound } from '@/components/portal/shared';
import { usePortalApi } from '@/lib/api';
import { keys } from '@/lib/query-keys';
import type { RequestView, SubmittedRequest } from '@/lib/types';
import { DetailsStep, DocumentsStep, DoneScreen, ReviewStep, type Flush } from './wizard-steps';

export const WIZARD_STEPS = ['service', 'details', 'documents', 'review'] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];
const isStep = (value: string | null): value is WizardStep => WIZARD_STEPS.includes(value as WizardStep);

/** Where to continue a draft: the first step that still needs something. */
function resumeStep(view: RequestView, i18n: Parameters<typeof checkForm>[3]): WizardStep {
  if (view.form.schema && formFields(view.form.schema).length && !checkForm(view.form.schema, view.form.values, false, i18n).ok) return 'details';
  if (missingDocuments(view).length) return 'documents';
  return 'review';
}

/**
 * New request, step by step: choose a service, fill in its details, add the
 * documents, review and submit. The draft is created on the server as soon as the
 * service is chosen and every step saves to it, so `/requests/new?draft=<id>`
 * continues on any device where it stopped.
 */
export function RequestWizard() {
  const i18n = useI18n();
  const { t, pick } = i18n;
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const toasts = useToast();
  const api = usePortalApi();
  const queryClient = useQueryClient();
  const draftId = search.get('draft') ?? '';
  const stepParam = search.get('step');
  const serviceId = search.get('serviceId') ?? '';
  const renewalOf = search.get('renewalOf') ?? '';

  const [submitted, setSubmitted] = React.useState<SubmittedRequest | null>(null);
  const [discardOpen, setDiscardOpen] = React.useState(false);
  const flush = React.useRef<Flush | null>(null);

  const draft = useRequestView(draftId, !!draftId && !submitted);
  const apply = useApplyRequest(draftId);
  const view = draft.data;

  const navigate = React.useCallback(
    (params: Record<string, string | undefined>, mode: 'replace' | 'push' = 'push') => {
      const next = new URLSearchParams(search.toString());
      for (const [key, value] of Object.entries(params)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      const qs = next.toString();
      router[mode](qs ? `${pathname}?${qs}` : pathname, { scroll: true });
    },
    [router, pathname, search],
  );

  if (submitted) return <DoneScreen result={submitted} />;

  const title = view ? pick(view.service.name, view.service.nameAr) : t('nav.newRequest');
  const header = (
    <PageHeader
      breadcrumbs={[{ label: t('nav.requests'), href: '/requests' }]}
      title={title}
      description={view ? t('my.wizard.draftSaved', { number: view.requestNo }) : t('my.wizard.intro')}
      meta={view ? <Badge tone="neutral">{t('my.wizard.draftBadge')}</Badge> : undefined}
    />
  );

  // ---- no draft yet: choose the service
  if (!draftId) {
    return (
      <>
        {header}
        <Stepper className="mb-6 max-w-3xl" steps={WIZARD_STEPS.map((id) => ({ id, label: t(`my.wizard.steps.${id}`) }))} current={0} />
        {serviceId ? (
          <ServiceIntro
            serviceId={serviceId}
            renewalOf={renewalOf}
            onBack={() => navigate({ serviceId: undefined })}
            onCreated={(created) => {
              queryClient.setQueryData(keys.requests.detail(created.id), created);
              void queryClient.invalidateQueries({ queryKey: keys.requests.all, predicate: (q) => q.queryKey[1] !== 'detail' });
              navigate({ draft: created.id, step: 'details', serviceId: undefined, renewalOf: undefined }, 'replace');
            }}
          />
        ) : (
          <ServicePicker onPick={(id) => navigate({ serviceId: id })} />
        )}
      </>
    );
  }

  if (draft.isPending) {
    return (
      <>
        {header}
        <Skeleton className="mb-6 h-10 w-full max-w-3xl" />
        <Skeleton className="h-96 w-full" />
      </>
    );
  }
  if (draft.isError || !view) {
    return (
      <>
        {header}
        {isNotFound(draft.error) ? (
          <NotFoundCard title={t('my.wizard.draftMissingTitle')} text={t('my.wizard.draftMissingText')} backHref="/requests" backLabel={t('nav.requests')} />
        ) : (
          <LoadError error={draft.error} onRetry={() => void draft.refetch()} />
        )}
      </>
    );
  }
  if (view.status !== 'DRAFT') {
    return (
      <>
        {header}
        <Alert
          tone="info"
          title={t('my.wizard.alreadySubmittedTitle')}
          action={
            <Button asChild size="sm">
              <Link href={`/requests/${view.id}`}>{t('my.wizard.openRequest')}</Link>
            </Button>
          }
        >
          {t('my.wizard.alreadySubmittedText', { number: view.requestNo })}
        </Alert>
      </>
    );
  }

  const step: WizardStep = isStep(stepParam) && stepParam !== 'service' ? stepParam : resumeStep(view, i18n);
  const current = WIZARD_STEPS.indexOf(step);
  const go = async (next: WizardStep) => {
    // Leaving a step saves it first; when that fails the person stays where the problem is.
    if (flush.current && !(await flush.current())) return;
    navigate({ step: next });
  };

  return (
    <>
      {header}
      <Stepper
        className="mb-6 max-w-3xl"
        steps={WIZARD_STEPS.map((id) => ({ id, label: t(`my.wizard.steps.${id}`) }))}
        current={current}
        // The service of a draft is fixed: its form and checklist belong to it.
        onStepClick={(index) => (index > 0 ? void go(WIZARD_STEPS[index]) : undefined)}
      />
      {step === 'details' ? <DetailsStep key={view.id} view={view} apply={apply} flush={flush} onNext={() => navigate({ step: 'documents' })} onLater={() => router.push('/requests')} /> : null}
      {step === 'documents' ? <DocumentsStep view={view} apply={apply} onBack={() => navigate({ step: 'details' })} onNext={() => navigate({ step: 'review' })} /> : null}
      {step === 'review' ? (
        <ReviewStep
          view={view}
          onEdit={(target) => navigate({ step: target })}
          onSubmitted={(result) => {
            setSubmitted(result);
            queryClient.setQueryData(keys.requests.detail(result.id), result);
            void queryClient.invalidateQueries({ queryKey: keys.requests.all, predicate: (q) => q.queryKey[1] !== 'detail' });
            void queryClient.invalidateQueries({ queryKey: keys.notifications.all });
          }}
        />
      ) : null}

      <div className="mt-8 border-t pt-4">
        <Button variant="link" className="text-muted-foreground" onClick={() => setDiscardOpen(true)}>
          {t('my.wizard.discard')}
        </Button>
      </div>
      <ConfirmDialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        title={t('my.wizard.discardTitle')}
        description={t('my.wizard.discardText', { number: view.requestNo })}
        confirmLabel={t('my.wizard.discard')}
        onConfirm={async () => {
          try {
            await api.cancelRequest(view.id, t('my.wizard.discardReason'));
          } catch (error) {
            toasts.error(error);
            throw error;
          }
          toasts.success(t('my.wizard.discarded', { number: view.requestNo }));
          await queryClient.invalidateQueries({ queryKey: keys.requests.all });
          router.push('/requests');
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------- step 1: choose the service

function ServicePicker({ onPick }: { onPick: (serviceId: string) => void }) {
  const { t, pick } = useI18n();
  const api = usePortalApi();
  const catalogue = useQuery({ queryKey: keys.catalogue.all, queryFn: ({ signal }) => api.catalogue(signal), staleTime: 5 * 60_000 });
  const [q, setQ] = React.useState('');
  const [category, setCategory] = React.useState('');

  const online = React.useMemo(() => (catalogue.data?.services ?? []).filter((s) => s.onlineAvailable), [catalogue.data]);
  const categories = (catalogue.data?.categories ?? []).filter((c) => online.some((s) => s.category.key === c.key));
  const services = React.useMemo(() => {
    const needle = q.trim().toLowerCase();
    return online.filter((s) => {
      if (category && s.category.key !== category) return false;
      if (!needle) return true;
      return [s.name, s.nameAr, s.description, s.descriptionAr, s.category.name, s.category.nameAr].some((text) => text?.toLowerCase().includes(needle));
    });
  }, [online, q, category]);

  if (catalogue.isPending) {
    return (
      <div className="space-y-3" role="status" aria-label={t('common.loading')}>
        <Skeleton className="h-10 w-full max-w-md" />
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-20" />
        ))}
      </div>
    );
  }
  if (catalogue.isError) return <LoadError error={catalogue.error} onRetry={() => void catalogue.refetch()} />;
  if (!online.length) {
    return (
      <Card>
        <EmptyState
          size="page"
          icon={<Store />}
          title={t('my.wizard.service.noneTitle')}
          description={t('my.wizard.service.noneText')}
          action={
            <Button asChild variant="outline">
              <Link href="/contact">{t('nav.contact')}</Link>
            </Button>
          }
        />
      </Card>
    );
  }

  const chip = (key: string, label: string) => (
    <button
      key={key || 'all'}
      type="button"
      aria-pressed={category === key}
      onClick={() => setCategory(key)}
      className={cn(
        'shrink-0 rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors',
        category === key ? 'border-secondary bg-secondary text-secondary-foreground' : 'bg-card text-foreground/80 hover:bg-muted',
        focusRing,
      )}
    >
      {label}
    </button>
  );

  return (
    <section aria-labelledby="pick-h" className="space-y-4">
      <h2 id="pick-h" className="text-lg font-semibold">
        {t('my.wizard.service.title')}
      </h2>
      <div className="max-w-md">
        <SearchInput value={q} onChange={setQ} placeholder={t('services.searchPlaceholder')} aria-label={t('services.searchPlaceholder')} />
      </div>
      <div className="scroll-quiet -mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0" role="group" aria-label={t('home.categories')}>
        {chip('', t('services.allCategories'))}
        {categories.map((c) => chip(c.key, pick(c.name, c.nameAr)))}
      </div>
      {services.length === 0 ? (
        <Card>
          <EmptyState
            icon={<SearchX />}
            title={t('services.emptyTitle')}
            description={t('services.emptyText')}
            action={
              <Button
                variant="outline"
                onClick={() => {
                  setQ('');
                  setCategory('');
                }}
              >
                {t('services.clear')}
              </Button>
            }
          />
        </Card>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {services.map((s) => {
            const Icon = categoryIcon(s.category.icon);
            const tone = TILE_TONES[Math.max(0, categories.findIndex((c) => c.key === s.category.key)) % TILE_TONES.length];
            return (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => onPick(s.id)}
                  className={cn('flex h-full w-full items-center gap-3.5 rounded-lg border bg-card p-4 text-start shadow-xs transition-shadow hover:shadow-md', focusRing)}
                >
                  <span aria-hidden="true" className={cn('flex size-11 shrink-0 items-center justify-center rounded-lg', tone)}>
                    <Icon className="size-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-md font-semibold text-foreground">{pick(s.name, s.nameAr)}</span>
                    <span className="mt-0.5 block text-sm text-muted-foreground">
                      {pick(s.category.name, s.category.nameAr)}
                      {s.price ? (
                        <>
                          <span aria-hidden="true"> – </span>
                          {Number(s.price.total) === 0 ? t('services.free') : <>{t('services.from')}: <Money amount={s.price.total} currency={s.price.currency} /></>}
                        </>
                      ) : null}
                    </span>
                  </span>
                  <ChevronRight className="rtl-mirror size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** What the chosen service needs and costs, before anything is created. "Start" creates the draft. */
function ServiceIntro({ serviceId, renewalOf, onBack, onCreated }: { serviceId: string; renewalOf: string; onBack: () => void; onCreated: (view: RequestView) => void }) {
  const { t, pick, formatDate } = useI18n();
  const api = usePortalApi();
  const describe = useErrorMessage();
  const service = useQuery({ queryKey: keys.catalogue.service(serviceId), queryFn: () => api.service(serviceId), retry: (count, error) => !isNotFound(error) && count < 2 });
  const branches = useQuery({ queryKey: keys.branches, queryFn: () => api.branches(), staleTime: 10 * 60_000 });
  const reminders = useQuery({ queryKey: keys.reminders, queryFn: () => api.reminders(), enabled: !!renewalOf });
  const [branchId, setBranchId] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [failure, setFailure] = React.useState<string | null>(null);
  const branchFieldId = React.useId();

  const back = (
    <Button variant="link" className="mb-3" onClick={onBack}>
      <ArrowLeft className="rtl-mirror" aria-hidden="true" />
      {t('my.wizard.service.other')}
    </Button>
  );

  if (service.isPending) {
    return (
      <div role="status" aria-label={t('common.loading')} className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <SkeletonText lines={8} />
        <Skeleton className="h-64" />
      </div>
    );
  }
  if (service.isError) {
    return (
      <>
        {back}
        {isNotFound(service.error) ? (
          <Card>
            <EmptyState size="page" icon={<Store />} title={t('services.notFoundTitle')} description={t('services.notFoundText')} />
          </Card>
        ) : (
          <LoadError error={service.error} onRetry={() => void service.refetch()} />
        )}
      </>
    );
  }

  const s = service.data;
  const offered = (branches.data ?? []).filter((b) => s.allBranches || s.branchIds.includes(b.id));
  const renewal = renewalOf ? reminders.data?.data.find((r) => r.id === renewalOf) : undefined;
  const description = pick(s.description, s.descriptionAr);

  const start = async () => {
    setBusy(true);
    setFailure(null);
    try {
      onCreated(await api.createRequest({ serviceId: s.id, ...(branchId ? { branchId } : {}), ...(renewal ? { renewalOfScheduleId: renewal.id } : {}) }));
    } catch (error) {
      setFailure(describe(error));
      setBusy(false);
    }
  };

  return (
    <>
      {back}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
        <div className="min-w-0 space-y-6">
          <div>
            <p className="text-sm font-medium text-secondary-text">{pick(s.category.name, s.category.nameAr)}</p>
            <h2 className="mt-1 text-xl font-semibold">{pick(s.name, s.nameAr)}</h2>
            {description ? (
              <p dir="auto" className="mt-2 max-w-2xl text-base text-foreground/85">
                {description}
              </p>
            ) : null}
          </div>
          {renewal ? (
            <Alert tone="info" title={t('my.wizard.service.renewalTitle')}>
              {t('my.wizard.service.renewalText', { document: pick(renewal.documentTypeName, renewal.documentTypeNameAr), date: formatDate(renewal.expiryDate) })}
            </Alert>
          ) : null}
          {/* Say plainly what the centre does and what stays with the customer or the authority. */}
          <Alert tone="info">{t(`services.capability.${s.complianceCapability}`)}</Alert>
          {!s.onlineAvailable ? <Alert tone="warning">{t('services.centreOnly')}</Alert> : null}
          <section aria-labelledby="need-h">
            <h3 id="need-h" className="mb-3 text-md font-semibold">
              {t('services.documentsTitle')}
            </h3>
            <RequirementList requirements={s.requirements} />
            {s.requirements.some((r) => r.allowReuse) ? <p className="mt-2 text-sm text-muted-foreground">{t('my.wizard.service.reuseNote')}</p> : null}
          </section>
          {s.eligibilityGuidance ? (
            <section aria-labelledby="before-h">
              <h3 id="before-h" className="mb-2 text-md font-semibold">
                {t('services.eligibility')}
              </h3>
              <p className="max-w-2xl text-base text-foreground/85" dir="auto">
                {s.eligibilityGuidance}
              </p>
            </section>
          ) : null}
        </div>

        <aside className="lg:sticky lg:top-24">
          <Card>
            <CardContent className="space-y-5">
              {s.price ? (
                <div>
                  <h3 className="mb-3 text-md font-semibold">{s.price.containsEstimates ? t('services.feesTitle') : t('my.price.title')}</h3>
                  <FeeEstimate price={s.price} />
                </div>
              ) : null}
              <ProcessingTime hours={s.estimatedProcessingHours} />
              {offered.length > 1 ? (
                <div className="space-y-1.5">
                  <Label htmlFor={branchFieldId}>{t('my.wizard.service.branch')}</Label>
                  <Select
                    id={branchFieldId}
                    value={branchId || offered.find((b) => b.isHeadOffice)?.id || offered[0].id}
                    onValueChange={setBranchId}
                    options={offered.map((b) => ({ value: b.id, label: pick(b.name, b.nameAr) }))}
                  />
                  <p className="text-sm text-muted-foreground">{t('my.wizard.service.branchHint')}</p>
                </div>
              ) : null}
              {failure ? (
                <Alert tone="danger" live>
                  {failure}
                </Alert>
              ) : null}
              {s.onlineAvailable ? (
                <div className="space-y-2">
                  <Button variant="accent" size="lg" className="w-full" loading={busy} loadingText={t('common.loading')} onClick={() => void start()}>
                    {t('my.wizard.service.start')}
                  </Button>
                  <p className="text-sm text-muted-foreground">{t('my.wizard.service.startHint')}</p>
                </div>
              ) : (
                <Button asChild variant="outline" className="w-full">
                  <Link href="/contact">{t('nav.contact')}</Link>
                </Button>
              )}
            </CardContent>
          </Card>
        </aside>
      </div>
    </>
  );
}
