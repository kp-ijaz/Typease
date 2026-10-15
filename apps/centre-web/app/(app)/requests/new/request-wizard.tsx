'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Clock, FileText, RefreshCw, ShieldCheck, UserPlus } from 'lucide-react';
import { formFields } from '@typease/validation';
import {
  Alert, Badge, Button, Card, CardContent, CardFooter, CardHeader, CardTitle, Checkbox, ChoiceLabel, DescriptionList, EmptyState, Label, PageHeader, RequirePermission,
  SearchInput, Select, Skeleton, Stepper, cn, countryName, focusRing, formatPhone, useI18n, useSession, useToast,
} from '@typease/ui';
import { useBranch, useBranches } from '@/components/branch';
import { CustomerPicker } from '@/components/pickers';
import { caseKeys } from '@/lib/keys/cases';
import { keys } from '@/lib/query-keys';
import { useCasesApi } from '@/components/cases/api';
import { DocumentChecklist } from '@/components/cases/documents';
import { checkForm } from '@/components/cases/dynamic-form';
import { applyCaseView, caseErrorText, useCase } from '@/components/cases/shared';
import type { CaseView, ServiceFull, ServiceRow, SubmittedCase } from '@/components/cases/types';
import { AddCustomerDialog } from '@/components/add-customer-dialog';
import { StepButtons, WIZARD_STEPS, type WizardStep } from './wizard-shared';
import { DetailsStep, DoneScreen, ReviewStep, type Flush } from './wizard-steps';

const isStep = (value: string | null): value is WizardStep => WIZARD_STEPS.includes(value as WizardStep);

/** Where to continue a draft: the first step that still needs something. */
function resumeStep(view: CaseView, i18n: Parameters<typeof checkForm>[3]): WizardStep {
  if (view.form.schema && formFields(view.form.schema).length && !checkForm(view.form.schema, view.form.values, false, i18n).ok) return 'details';
  if (view.checklist.some((line) => line.kind === 'INPUT' && line.isMandatory && (line.status === 'MISSING' || line.status === 'REJECTED'))) return 'documents';
  return 'review';
}

/**
 * New request, step by step. The draft is created on the server as soon as the
 * customer and the service are known; from then on every step saves to it, so
 * `/requests/new?draft=<id>` continues on any device where it stopped.
 */
export function RequestWizard() {
  return (
    <RequirePermission anyOf={['request.create']}>
      <Wizard />
    </RequirePermission>
  );
}

function Wizard() {
  const i18n = useI18n();
  const { t } = i18n;
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const queryClient = useQueryClient();
  const draftId = search.get('draft') ?? '';
  const stepParam = search.get('step');

  // Before the draft exists the choices live here (and start from the link that opened the page).
  const [customerId, setCustomerId] = React.useState(search.get('customerId') ?? '');
  const [serviceId, setServiceId] = React.useState(search.get('serviceId') ?? '');
  const [corporateAccountId, setCorporateAccountId] = React.useState(search.get('corporateAccountId') ?? '');
  const [submitted, setSubmitted] = React.useState<SubmittedCase | null>(null);
  // A link that already names the customer (from a customer page) starts at the service.
  const [startAtService] = React.useState(() => !!search.get('customerId'));
  const flush = React.useRef<Flush | null>(null);

  const draft = useCase(draftId, !!draftId);
  const view = draft.data;

  const navigate = React.useCallback(
    (params: Record<string, string | undefined>, mode: 'replace' | 'push' = 'replace') => {
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

  const startOver = React.useCallback(
    (forCustomer?: string) => {
      setSubmitted(null);
      setCustomerId(forCustomer ?? '');
      setServiceId('');
      setCorporateAccountId('');
      router.push(forCustomer ? `/requests/new?customerId=${forCustomer}` : '/requests/new');
    },
    [router],
  );

  if (submitted) return <DoneScreen result={submitted} onNewForCustomer={() => startOver(submitted.customer.id)} />;

  const header = (
    <PageHeader
      breadcrumbs={[{ label: t('nav.requests'), href: '/requests' }]}
      title={t('requests.new')}
      description={view ? t('cases.wizard.draftSaved', { number: view.requestNo }) : t('sections.newRequest')}
      meta={view ? <Badge tone="neutral">{t('cases.wizard.draftBadge', { number: view.requestNo })}</Badge> : undefined}
    />
  );

  if (draftId && draft.isPending) {
    return (
      <>
        {header}
        <Skeleton className="mb-6 h-10 w-full max-w-3xl" />
        <Skeleton className="h-96 w-full" />
      </>
    );
  }
  if (draftId && (draft.isError || !view)) {
    return (
      <>
        {header}
        <Alert
          tone="danger"
          title={t('cases.wizard.draftErrorTitle')}
          action={
            <>
              <Button size="sm" variant="outline" onClick={() => void draft.refetch()}>
                {t('common.retry')}
              </Button>
              <Button size="sm" variant="outline" onClick={() => startOver()}>
                {t('cases.wizard.startNew')}
              </Button>
            </>
          }
        >
          {caseErrorText(draft.error, i18n)}
        </Alert>
      </>
    );
  }
  if (view && view.status !== 'DRAFT') {
    return (
      <>
        {header}
        <Alert
          tone="info"
          title={t('cases.wizard.alreadySubmittedTitle', { number: view.requestNo })}
          action={
            <>
              <Button asChild size="sm">
                <Link href={`/requests/${view.id}`}>{t('cases.wizard.openCase')}</Link>
              </Button>
              <Button size="sm" variant="outline" onClick={() => startOver()}>
                {t('cases.wizard.startNew')}
              </Button>
            </>
          }
        >
          {t('cases.wizard.alreadySubmittedText')}
        </Alert>
      </>
    );
  }

  let step: WizardStep = isStep(stepParam) ? stepParam : view ? resumeStep(view, i18n) : startAtService ? 'service' : 'customer';
  if (!view && (step === 'details' || step === 'documents' || step === 'review')) step = customerId ? 'service' : 'customer';
  if (!view && !customerId) step = 'customer';
  const index = WIZARD_STEPS.indexOf(step);

  /** Leaves the current step: whatever it holds is saved first, and a failed save keeps the person where they are. */
  const goTo = async (next: WizardStep) => {
    if (flush.current && !(await flush.current())) return;
    navigate({ step: next });
  };
  const apply = (next?: CaseView | null) => view && applyCaseView(queryClient, next, view.id);

  return (
    <>
      {header}
      <Stepper
        className="mb-6"
        current={index}
        steps={WIZARD_STEPS.map((key) => ({ id: key, label: t(`cases.wizard.steps.${key}`) }))}
        onStepClick={(i) => void goTo(WIZARD_STEPS[i])}
      />

      {step === 'customer' ? (
        <CustomerStep
          view={view ?? null}
          customerId={view?.customer.id ?? customerId}
          corporateAccountId={view?.corporateAccount?.id ?? corporateAccountId}
          lockedCompany={!!search.get('corporateAccountId')}
          onCustomer={(id) => {
            setCustomerId(id);
            if (!search.get('corporateAccountId')) setCorporateAccountId('');
          }}
          onCorporate={setCorporateAccountId}
          onNext={() => navigate({ step: 'service' })}
          onStartNew={() => startOver()}
        />
      ) : null}

      {step === 'service' ? (
        <ServiceStep
          view={view ?? null}
          customerId={customerId}
          corporateAccountId={corporateAccountId}
          serviceId={view?.service.id ?? serviceId}
          onService={setServiceId}
          onBack={() => navigate({ step: 'customer' })}
          onNext={() => navigate({ step: 'details' })}
          onCreated={(created) => {
            queryClient.setQueryData(caseKeys.detail(created.id), created);
            void queryClient.invalidateQueries({ queryKey: keys.requests.all });
            navigate({ draft: created.id, step: 'details', customerId: undefined, serviceId: undefined, corporateAccountId: undefined });
          }}
          onStartNew={() => startOver()}
        />
      ) : null}

      {step === 'details' && view ? <DetailsStep view={view} apply={apply} flush={flush} onBack={() => navigate({ step: 'service' })} onNext={() => navigate({ step: 'documents' })} /> : null}

      {step === 'documents' && view ? (
        <div className="space-y-5">
          <Alert tone="info">{t('cases.wizard.documentsIntro')}</Alert>
          <DocumentChecklist view={view} onChanged={apply} mode="intake" />
          <StepButtons onBack={() => navigate({ step: 'details' })} onNext={() => navigate({ step: 'review' })} />
        </div>
      ) : null}

      {step === 'review' && view ? (
        <ReviewStep
          view={view}
          onEdit={(target) => navigate({ step: target })}
          onSubmitted={(result) => {
            applyCaseView(queryClient, result, result.id);
            setSubmitted(result);
            window.scrollTo({ top: 0 });
          }}
        />
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------- step 1: customer

function CustomerStep({ view, customerId, corporateAccountId, lockedCompany, onCustomer, onCorporate, onNext, onStartNew }: {
  view: CaseView | null;
  customerId: string;
  corporateAccountId: string;
  lockedCompany: boolean;
  onCustomer: (id: string) => void;
  onCorporate: (id: string) => void;
  onNext: () => void;
  onStartNew: () => void;
}) {
  const { t, pick, locale, tn } = useI18n();
  const api = useCasesApi();
  const session = useSession();
  const [adding, setAdding] = React.useState(false);
  const pickerId = React.useId();
  const billId = React.useId();

  const customer = useQuery({ queryKey: caseKeys.customer(customerId), queryFn: () => api.customer(customerId), enabled: !!customerId && session.hasPermission('customer.read') });
  const company = useQuery({
    queryKey: caseKeys.corporateAccount(corporateAccountId),
    queryFn: () => api.corporateAccount(corporateAccountId),
    enabled: !!corporateAccountId && lockedCompany && session.hasPermission('corporate.read'),
  });

  const data = customer.data;
  const ownCompany = data?.corporateAccount ?? null;
  const items = data
    ? [
        { label: t('cases.wizard.customer.number'), value: <span className="tabular">{data.customerNo}</span> },
        { label: t('customers.form.type'), value: t(`customers.types.${data.type}`) },
        { label: t('customers.form.phone'), value: data.phone ? <span className="ltr-value tabular">{formatPhone(data.phone)}</span> : null },
        { label: t('customers.form.email'), value: data.email ? <span className="ltr-value">{data.email}</span> : null },
        { label: t('customers.form.nationality'), value: countryName(data.nationality, locale) || null },
        { label: t('customers.form.preferredLanguage'), value: data.preferredLanguage === 'ar' ? 'العربية' : 'English' },
        { label: t('cases.wizard.customer.emiratesId'), value: data.emiratesIdMasked ? <span className="ltr-value tabular">{data.emiratesIdMasked}</span> : null },
        { label: t('cases.wizard.customer.passport'), value: data.passportNoMasked ? <span className="ltr-value tabular">{data.passportNoMasked}</span> : null },
      ]
    : [];

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader className="items-center pb-4">
          <div>
            <CardTitle>{t('cases.wizard.customer.title')}</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">{view ? t('cases.wizard.lockedText') : t('cases.wizard.customer.text')}</p>
          </div>
          {view ? (
            <Button variant="outline" size="sm" onClick={onStartNew}>
              {t('cases.wizard.startNew')}
            </Button>
          ) : session.hasPermission('customer.create') ? (
            <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
              <UserPlus aria-hidden="true" />
              {t('customers.add')}
            </Button>
          ) : null}
        </CardHeader>
        <CardContent className="space-y-5 border-t">
          {lockedCompany && corporateAccountId ? (
            <Alert tone="info">
              {t('cases.wizard.customer.forCompany', { name: company.data ? pick(company.data.companyName, company.data.companyNameAr) : t('cases.wizard.customer.theCompany') })}
            </Alert>
          ) : null}
          {view ? null : (
            <div className="max-w-xl space-y-1.5">
              <Label htmlFor={pickerId} required>
                {t('cases.fields.customer')}
              </Label>
              <CustomerPicker
                id={pickerId}
                value={customerId}
                selectedLabel={data?.fullName ?? (customerId ? t('common.loading') : null)}
                corporateAccountId={lockedCompany ? corporateAccountId : undefined}
                onChange={(id) => onCustomer(id)}
              />
              <p className="text-sm text-muted-foreground">{t('cases.wizard.customer.hint')}</p>
            </div>
          )}

          {customerId && customer.isPending && session.hasPermission('customer.read') ? <Skeleton className="h-32 w-full" /> : null}
          {customer.isError ? (
            <Alert tone="danger" action={<Button size="sm" variant="outline" onClick={() => void customer.refetch()}>{t('common.retry')}</Button>}>
              {t('cases.wizard.customer.loadError')}
            </Alert>
          ) : null}
          {data ? (
            <div className="rounded-lg border bg-muted/30 p-4" data-customer-summary>
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <p className="text-md font-semibold text-foreground">
                  {data.fullName}
                  {data.fullNameAr ? (
                    <span lang="ar" className="ms-2 font-normal text-muted-foreground">
                      {data.fullNameAr}
                    </span>
                  ) : null}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  {data.counters ? (
                    <Badge tone={data.counters.openRequests > 0 ? 'info' : 'neutral'}>{tn('cases.wizard.customer.openRequests', data.counters.openRequests)}</Badge>
                  ) : null}
                  {data.status !== 'ACTIVE' ? <Badge tone="danger">{t('cases.wizard.customer.inactive')}</Badge> : null}
                  <Button asChild variant="link" size="sm">
                    <Link href={`/customers/${data.id}`} target="_blank" rel="noopener">
                      {t('cases.wizard.customer.openProfile')}
                    </Link>
                  </Button>
                </div>
              </div>
              <DescriptionList items={items} columns={3} />
              {!data.phone && !data.email ? <p className="mt-4 text-sm text-warning-text">{t('cases.wizard.customer.noContact')}</p> : null}
            </div>
          ) : null}

          {!view && !lockedCompany && ownCompany ? (
            <ChoiceLabel
              htmlFor={billId}
              control={<Checkbox id={billId} checked={corporateAccountId === ownCompany.id} onCheckedChange={(on) => onCorporate(on === true ? ownCompany.id : '')} />}
              label={t('cases.wizard.customer.billCompany', { name: pick(ownCompany.companyName, ownCompany.companyNameAr ?? null) })}
              description={t('cases.wizard.customer.billCompanyHint')}
            />
          ) : null}
        </CardContent>
      </Card>
      <StepButtons onNext={onNext} nextDisabled={!customerId} />
      {session.hasPermission('customer.create') ? <AddCustomerDialog open={adding} onOpenChange={setAdding} onCreated={(created) => onCustomer(created.id)} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------- step 2: service

function processingTime(hours: number | null, tn: (key: string, count: number) => string): string | null {
  if (!hours || hours <= 0) return null;
  return hours < 24 ? tn('cases.wizard.service.hours', hours) : tn('cases.wizard.service.days', Math.ceil(hours / 24));
}

function ServiceStep({ view, customerId, corporateAccountId, serviceId, onService, onBack, onNext, onCreated, onStartNew }: {
  view: CaseView | null;
  customerId: string;
  corporateAccountId: string;
  serviceId: string;
  onService: (id: string) => void;
  onBack: () => void;
  onNext: () => void;
  onCreated: (view: CaseView) => void;
  onStartNew: () => void;
}) {
  const i18n = useI18n();
  const { t, tn, pick } = i18n;
  const api = useCasesApi();
  const session = useSession();
  const toasts = useToast();
  const working = useBranch();
  const branches = useBranches();
  const [q, setQ] = React.useState('');
  const [category, setCategory] = React.useState('all');
  const [branchId, setBranchId] = React.useState('');
  const [creating, setCreating] = React.useState(false);
  const [failure, setFailure] = React.useState<string | null>(null);
  const detailRef = React.useRef<HTMLDivElement>(null);
  const branchField = React.useId();

  const catalogue = useQuery({ queryKey: caseKeys.serviceCatalogue, queryFn: () => api.services(), staleTime: 5 * 60_000, enabled: !view });
  const services = React.useMemo(() => (catalogue.data?.data ?? []).filter((s) => s.isActive), [catalogue.data]);
  const selected = services.find((s) => s.id === serviceId) ?? null;

  // Branches the person works at; the request can only be opened at one that offers the service.
  const mine = React.useMemo(() => {
    const m = session.membership;
    return (branches.data ?? []).filter((b) => !m || m.allBranches || m.branchIds.includes(b.id));
  }, [branches.data, session.membership]);
  const offering = React.useMemo(() => (selected ? mine.filter((b) => selected.allBranches || selected.branchIds.includes(b.id)) : mine), [mine, selected]);
  React.useEffect(() => {
    if (view || !selected) return;
    if (offering.some((b) => b.id === branchId)) return;
    const preferred = offering.find((b) => b.id === working.branchId) ?? offering.find((b) => b.isHeadOffice) ?? offering[0];
    setBranchId(preferred?.id ?? '');
  }, [view, selected, offering, branchId, working.branchId]);

  const effectiveBranch = view?.branch.id ?? (branchId || undefined);
  const full = useQuery({
    queryKey: caseKeys.serviceFull(serviceId, effectiveBranch, corporateAccountId || undefined),
    queryFn: () => api.serviceFull(serviceId, { branchId: effectiveBranch, corporateAccountId: (view?.corporateAccount?.id ?? corporateAccountId) || undefined }),
    enabled: !!serviceId,
  });

  const categories = React.useMemo(() => {
    const map = new Map<string, { value: string; label: string }>();
    for (const s of services) if (s.category) map.set(s.category.key, { value: s.category.key, label: pick(s.category.name, s.category.nameAr) });
    return [...map.values()];
  }, [services, pick]);
  const needle = q.trim().toLowerCase();
  const shown = services.filter(
    (s) =>
      (category === 'all' || s.category?.key === category) &&
      (!needle || [s.name, s.nameAr ?? '', s.code, s.category?.name ?? '', s.category?.nameAr ?? ''].some((text) => text.toLowerCase().includes(needle))),
  );

  const choose = (service: ServiceRow) => {
    onService(service.id);
    setFailure(null);
    // On a phone the description is below the list: bring it into view.
    window.setTimeout(() => detailRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 50);
  };

  const create = async () => {
    if (!selected) return;
    setCreating(true);
    setFailure(null);
    try {
      const created = await api.create({ serviceId: selected.id, customerId, ...(branchId ? { branchId } : {}), ...(corporateAccountId ? { corporateAccountId } : {}) });
      toasts.success(t('cases.wizard.draftCreated'), t('cases.wizard.draftCreatedText', { number: created.requestNo }));
      onCreated(created);
    } catch (error) {
      setFailure(caseErrorText(error, i18n));
    } finally {
      setCreating(false);
    }
  };

  if (view) {
    return (
      <div className="space-y-5">
        <Card>
          <CardHeader className="items-center pb-4">
            <div>
              <CardTitle>{pick(view.service.name, view.service.nameAr)}</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">{t('cases.wizard.lockedText')}</p>
            </div>
            <Button variant="outline" size="sm" onClick={onStartNew}>
              {t('cases.wizard.startNew')}
            </Button>
          </CardHeader>
          <CardContent className="border-t">
            {full.data ? <ServiceDetail service={full.data} /> : full.isPending ? <Skeleton className="h-48 w-full" /> : <Alert tone="info">{t(`cases.external.capabilityText.${view.service.complianceCapability}`)}</Alert>}
            <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
              <Building2 className="size-4" aria-hidden="true" />
              {t('cases.wizard.service.atBranch', { branch: pick(view.branch.name, view.branch.nameAr) })}
            </p>
          </CardContent>
        </Card>
        <StepButtons onBack={onBack} onNext={onNext} />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <Card className="self-start">
          <CardHeader className="pb-4">
            <div>
              <CardTitle>{t('cases.wizard.service.title')}</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">{t('cases.wizard.service.text')}</p>
            </div>
          </CardHeader>
          <div className="flex flex-wrap gap-3 border-t p-4">
            <div className="min-w-0 flex-1 basis-52">
              <SearchInput value={q} onChange={setQ} debounceMs={150} placeholder={t('cases.wizard.service.search')} aria-label={t('cases.wizard.service.search')} />
            </div>
            <Select
              className="w-full sm:w-56"
              aria-label={t('cases.wizard.service.category')}
              value={category}
              onValueChange={setCategory}
              options={[{ value: 'all', label: t('cases.wizard.service.allCategories') }, ...categories]}
            />
          </div>
          {catalogue.isPending ? (
            <div className="space-y-2 border-t p-4">
              {[0, 1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : catalogue.isError ? (
            <div className="border-t p-4">
              <Alert tone="danger" action={<Button size="sm" variant="outline" onClick={() => void catalogue.refetch()}>{t('common.retry')}</Button>}>
                {caseErrorText(catalogue.error, i18n)}
              </Alert>
            </div>
          ) : shown.length ? (
            <ul role="listbox" aria-label={t('cases.wizard.service.title')} className="scroll-quiet max-h-[28rem] divide-y overflow-y-auto border-t">
              {shown.map((service) => {
                const active = service.id === serviceId;
                const time = processingTime(service.estimatedProcessingHours, tn);
                return (
                  <li key={service.id} role="option" aria-selected={active}>
                    <button
                      type="button"
                      onClick={() => choose(service)}
                      className={cn('flex w-full items-start gap-3 px-4 py-3 text-start transition-colors hover:bg-muted/50', active && 'bg-secondary-soft/70 hover:bg-secondary-soft/70', focusRing, 'focus-visible:ring-inset')}
                      data-service={service.code}
                    >
                      <span aria-hidden="true" className={cn('mt-1 flex size-4 shrink-0 items-center justify-center rounded-full border-2', active ? 'border-secondary' : 'border-input')}>
                        {active ? <span className="size-2 rounded-full bg-secondary" /> : null}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-base font-medium text-foreground">
                          <bdi>{pick(service.name, service.nameAr)}</bdi>
                        </span>
                        <span className="mt-0.5 flex flex-wrap gap-x-3 text-sm text-muted-foreground">
                          {service.category ? <span>{pick(service.category.name, service.category.nameAr)}</span> : null}
                          {time ? <span>{time}</span> : null}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptyState className="border-t" icon={<FileText />} title={t('cases.wizard.service.noneTitle')} description={t('cases.wizard.service.noneText')} />
          )}
        </Card>

        <div ref={detailRef} className="scroll-mt-24">
          {selected ? (
            <Card>
              <CardHeader className="pb-4">
                <div>
                  <CardTitle>
                    <bdi>{pick(selected.name, selected.nameAr)}</bdi>
                  </CardTitle>
                  <p className="mt-1 text-sm text-muted-foreground">{selected.category ? pick(selected.category.name, selected.category.nameAr) : null}</p>
                </div>
              </CardHeader>
              <CardContent className="space-y-5 border-t">
                {full.isPending ? <Skeleton className="h-64 w-full" /> : full.isError ? <Alert tone="danger" action={<Button size="sm" variant="outline" onClick={() => void full.refetch()}>{t('common.retry')}</Button>}>{caseErrorText(full.error, i18n)}</Alert> : <ServiceDetail service={full.data} />}
                <div className="space-y-1.5 border-t pt-5">
                  <Label htmlFor={branchField}>{t('cases.wizard.service.branch')}</Label>
                  {branches.isPending && session.hasPermission('branch.read') ? (
                    <Skeleton className="h-10 w-full max-w-sm" />
                  ) : offering.length > 1 ? (
                    <Select id={branchField} className="max-w-sm" value={branchId} onValueChange={setBranchId} options={offering.map((b) => ({ value: b.id, label: pick(b.name, b.nameAr) }))} />
                  ) : offering.length === 1 ? (
                    <p id={branchField} className="text-base text-foreground">
                      {pick(offering[0].name, offering[0].nameAr)}
                    </p>
                  ) : mine.length ? (
                    <Alert tone="warning">{t('cases.wizard.service.notAtYourBranch')}</Alert>
                  ) : (
                    <p id={branchField} className="text-sm text-muted-foreground">
                      {t('cases.wizard.service.branchDefault')}
                    </p>
                  )}
                  {offering.length > 1 ? <p className="text-sm text-muted-foreground">{t('cases.wizard.service.branchHint')}</p> : null}
                </div>
              </CardContent>
              {failure ? (
                <CardFooter>
                  <Alert tone="danger" live className="w-full">
                    {failure}
                  </Alert>
                </CardFooter>
              ) : null}
            </Card>
          ) : (
            <Card>
              <EmptyState icon={<FileText />} title={t('cases.wizard.service.pickTitle')} description={t('cases.wizard.service.pickText')} />
            </Card>
          )}
        </div>
      </div>
      <StepButtons onBack={onBack} onNext={() => void create()} busy={creating} nextDisabled={!selected || (mine.length > 0 && offering.length === 0)} nextLabel={t('cases.wizard.service.continue')} />
    </div>
  );
}

/** What the service is, how long it takes, what it costs (estimates) and which documents it needs. */
export function ServiceDetail({ service }: { service: ServiceFull }) {
  const { t, tn, pick, formatMoney } = useI18n();
  const price = service.price;
  const time = processingTime(service.estimatedProcessingHours, tn);
  const description = pick(service.description, service.descriptionAr);
  return (
    <div className="space-y-5" data-service-detail>
      {description ? (
        <p className="text-base text-foreground/90">
          <bdi>{description}</bdi>
        </p>
      ) : null}
      <Alert tone={service.complianceCapability === 'DOCUMENT_PREPARATION_ONLY' || service.complianceCapability === 'INFORMATIONAL_ONLY' ? 'warning' : 'info'} title={t(`cases.capability.${service.complianceCapability}`)}>
        {t(`cases.wizard.service.compliance.${service.complianceCapability}`)}
      </Alert>
      <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-foreground/90">
        {time ? (
          <span className="inline-flex items-center gap-2">
            <Clock className="size-4 text-muted-foreground" aria-hidden="true" />
            {t('cases.wizard.service.time', { time })}
          </span>
        ) : null}
        {service.requiresApproval ? (
          <span className="inline-flex items-center gap-2">
            <ShieldCheck className="size-4 text-muted-foreground" aria-hidden="true" />
            {t('cases.overview.reviewYes')}
          </span>
        ) : null}
        <span className="inline-flex items-center gap-2">
          <RefreshCw className="size-4 text-muted-foreground" aria-hidden="true" />
          {t(`cases.paymentPolicy.${service.paymentPolicy}`)}
        </span>
      </div>

      <section aria-labelledby="fees-title" className="rounded-lg border">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/40 px-4 py-2.5">
          <h3 id="fees-title" className="text-sm font-semibold text-foreground">
            {t('cases.wizard.service.fees')}
          </h3>
          <Badge tone="warning">{t('cases.wizard.service.estimate')}</Badge>
        </div>
        {price ? (
          <dl className="px-4 py-2 text-base">
            {price.components.map((component) => (
              <div key={component.component} className="flex items-baseline justify-between gap-4 py-1.5">
                <dt className="text-muted-foreground">
                  {t(`cases.wizard.service.components.${component.component}`)}
                  {component.isEstimate ? <span className="ms-1.5 text-xs">({t('cases.wizard.service.estimateShort')})</span> : null}
                </dt>
                <dd className="tabular whitespace-nowrap">{formatMoney(component.amount, price.currency)}</dd>
              </div>
            ))}
            <div className="flex items-baseline justify-between gap-4 py-1.5">
              <dt className="text-muted-foreground">{t('cases.money.tax')}</dt>
              <dd className="tabular whitespace-nowrap">{formatMoney(price.taxAmount, price.currency)}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-4 border-t py-2 font-semibold text-foreground">
              <dt>{t('cases.wizard.service.totalEstimate')}</dt>
              <dd className="tabular whitespace-nowrap">{formatMoney(price.total, price.currency)}</dd>
            </div>
          </dl>
        ) : (
          <p className="px-4 py-3 text-sm text-muted-foreground">{t('cases.wizard.service.noPrice')}</p>
        )}
        <p className="border-t px-4 py-2.5 text-sm text-muted-foreground">{t('cases.wizard.service.feesNote')}</p>
      </section>

      <section aria-labelledby="needed-title">
        <h3 id="needed-title" className="mb-2 text-sm font-semibold text-foreground">
          {t('cases.wizard.service.documents')}
        </h3>
        {service.requirements.length ? (
          <ul className="space-y-1.5">
            {service.requirements.map((requirement) => (
              <li key={requirement.id} className="flex flex-wrap items-baseline gap-x-2 text-base text-foreground/90">
                <span dir="auto">{pick(requirement.label, requirement.labelAr)}</span>
                {requirement.isMandatory ? null : <span className="text-sm text-muted-foreground">({t('cases.docs.optional')})</span>}
                {requirement.description ? (
                  <span className="basis-full text-sm text-muted-foreground">
                    <bdi>{requirement.description}</bdi>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{t('cases.docs.inputsNone')}</p>
        )}
      </section>
      {service.eligibilityGuidance ? (
        <p className="text-sm text-muted-foreground">
          <bdi>{service.eligibilityGuidance}</bdi>
        </p>
      ) : null}
    </div>
  );
}
