'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Building2, ChevronRight, SearchX, Store, UserRound } from 'lucide-react';
import { isApiError } from '@typease/api-client';
import { formFields } from '@typease/validation';
import {
  Alert, Badge, Button, Card, CardContent, ChoiceLabel, Combobox, ConfirmDialog, EmptyState, Label, PageHeader, RadioGroup, RadioGroupItem, SearchInput, Select, Skeleton, SkeletonText,
  Stepper, cn, focusRing, useErrorMessage, useI18n, useToast, type ComboboxOption,
} from '@typease/ui';
import { TILE_TONES, categoryIcon } from '@/components/portal/catalogue';
import { missingDocuments } from '@/components/portal/checklist';
import { checkForm } from '@/components/portal/dynamic-form';
import { useApplyRequest, useRequestView } from '@/components/portal/request-hooks';
import { CompanyRequestNotice, FeeEstimate, ProcessingTime, RequirementList, isContractPrice } from '@/components/portal/service-info';
import { CompanyStatusNotice, Gate, LoadError, Money, NotFoundCard, isNotFound, retryUnlessFinal, useCompanyAccount, useRole } from '@/components/portal/shared';
import { usePortalApi } from '@/lib/api';
import { ROUTES } from '@/lib/config';
import { keys } from '@/lib/query-keys';
import type { ReminderRow, RequestView, SubmittedRequest } from '@/lib/types';
import { DetailsStep, DocumentsStep, DoneScreen, RequestSubject, ReviewStep, type Flush } from './wizard-steps';

const DRAFT_STEPS = ['details', 'documents', 'review'] as const;
type DraftStep = (typeof DRAFT_STEPS)[number];
const isDraftStep = (value: string | null): value is DraftStep => DRAFT_STEPS.includes(value as DraftStep);
/** The value of `?for=` when the request is for the company itself and not for one employee. */
const COMPANY = 'company';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Where to continue a draft: the first step that still needs something. */
function resumeStep(view: RequestView, i18n: Parameters<typeof checkForm>[3]): DraftStep {
  if (view.form.schema && formFields(view.form.schema).length && !checkForm(view.form.schema, view.form.values, false, i18n).ok) return 'details';
  if (missingDocuments(view).length) return 'documents';
  return 'review';
}

export function RequestWizard() {
  return (
    <Gate anyOf={['corp.requests.create', 'self.requests']}>
      <Wizard />
    </Gate>
  );
}

/**
 * New request, step by step. A company administrator first says who it is for (one employee,
 * or the company itself; the API takes one person per request), then chooses the service, fills
 * in its details, adds the documents, reviews and submits. An employee starts at the service:
 * the request is always their own. The draft is created on the server as soon as the service is
 * chosen and every step saves to it, so `/requests/new?draft=<id>` continues where it stopped.
 */
function Wizard() {
  const i18n = useI18n();
  const { t, pick } = i18n;
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const toasts = useToast();
  const api = usePortalApi();
  const role = useRole();
  const queryClient = useQueryClient();
  const { account, active } = useCompanyAccount();

  const draftId = search.get('draft') ?? '';
  const stepParam = search.get('step');
  const serviceId = search.get('serviceId') ?? '';
  const renewalOf = search.get('renewalOf') ?? '';
  const employeeParam = search.get('employee') ?? '';
  // `?employee=<id>` (from an employee's page) or `?for=company`; anything else is "not chosen yet".
  const subject = !role.company ? '' : search.get('for') === COMPANY ? COMPANY : UUID.test(employeeParam) ? employeeParam : '';

  const [submitted, setSubmitted] = React.useState<SubmittedRequest | null>(null);
  const [discardOpen, setDiscardOpen] = React.useState(false);
  const flush = React.useRef<Flush | null>(null);

  // The confirmation belongs to the draft in the address: "same service for another employee" leaves it.
  const done = submitted && submitted.id === draftId ? submitted : null;
  const draft = useRequestView(draftId, !!draftId && !done);
  const apply = useApplyRequest(draftId);
  const view = draft.data;
  const employee = useQuery({ queryKey: keys.employees.detail(subject), queryFn: ({ signal }) => api.employee(subject, signal), enabled: !!subject && subject !== COMPANY && !draftId, retry: retryUnlessFinal });
  const reminders = useQuery({ queryKey: keys.reminders, queryFn: ({ signal }) => api.reminders(undefined, signal), enabled: !!renewalOf && !draftId });
  const renewal = renewalOf ? reminders.data?.data.find((r) => r.id === renewalOf) : undefined;

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

  if (done) return <DoneScreen result={done} />;

  const steps = [...(role.company ? ['who'] : []), 'service', ...DRAFT_STEPS];
  const stepper = (current: string, onStepClick?: (id: string) => void) => (
    <Stepper
      className="mb-6 max-w-3xl"
      steps={steps.map((id) => ({ id, label: t(`my.wizard.steps.${id}`) }))}
      current={steps.indexOf(current)}
      onStepClick={onStepClick ? (index) => onStepClick(steps[index]) : undefined}
    />
  );

  const title = view ? pick(view.service.name, view.service.nameAr) : t('nav.newRequest');
  const header = (
    <PageHeader
      breadcrumbs={[{ label: role.company ? t('nav.requests') : t('my.requests.mineTitle'), href: ROUTES.requests }]}
      title={title}
      description={view ? t('my.wizard.draftSaved', { number: view.requestNo }) : role.company ? t('my.wizard.introCompany') : t('my.wizard.intro')}
      meta={
        view ? (
          <>
            <Badge tone="neutral">{t('my.wizard.draftBadge')}</Badge>
            {role.company ? (
              <Badge tone="brand" icon={view.customer.type === 'BUSINESS' ? <Building2 /> : <UserRound />} data-request-for>
                <RequestSubject view={view} />
              </Badge>
            ) : null}
          </>
        ) : undefined
      }
    />
  );

  // ---- no draft yet: who it is for, then the service
  if (!draftId) {
    // New requests are only taken while the centre has the company's account active.
    if (role.company && !active) {
      return (
        <>
          {header}
          <CompanyStatusNotice />
        </>
      );
    }
    if (role.company && !subject) {
      return (
        <>
          {header}
          {stepper('who')}
          <WhoStep renewal={renewal} companyName={account.data ? pick(account.data.companyName, account.data.companyNameAr) : ''} onChosen={(value) => navigate(value === COMPANY ? { for: COMPANY, employee: undefined } : { employee: value, for: undefined })} />
        </>
      );
    }

    const subjectLine =
      role.company && subject ? (
        <SubjectLine
          name={subject === COMPANY ? t('my.wizard.who.companyShort') : employee.data?.fullName ?? ''}
          company={subject === COMPANY}
          loading={subject !== COMPANY && employee.isPending}
          onChange={() => navigate({ employee: undefined, for: undefined })}
        />
      ) : null;

    if (subject && subject !== COMPANY && employee.isError) {
      return (
        <>
          {header}
          {stepper('who')}
          {isNotFound(employee.error) ? (
            <NotFoundCard title={t('my.employees.notFoundTitle')} text={t('my.employees.notFoundText')} backHref={ROUTES.newRequest} backLabel={t('my.wizard.who.chooseAgain')} />
          ) : (
            <LoadError error={employee.error} onRetry={() => void employee.refetch()} />
          )}
        </>
      );
    }
    if (subject && subject !== COMPANY && employee.data && employee.data.status !== 'ACTIVE') {
      return (
        <>
          {header}
          {stepper('who')}
          <Alert tone="warning" title={t('my.wizard.who.inactiveTitle', { name: employee.data.fullName })} action={<Button size="sm" variant="outline" onClick={() => navigate({ employee: undefined })}>{t('my.wizard.who.chooseAgain')}</Button>}>
            {t('my.wizard.who.inactiveText')}
          </Alert>
        </>
      );
    }

    return (
      <>
        {header}
        {stepper('service', role.company ? (id) => (id === 'who' ? navigate({ employee: undefined, for: undefined }) : undefined) : undefined)}
        {subjectLine}
        {serviceId ? (
          <ServiceIntro
            serviceId={serviceId}
            renewal={renewal}
            employeeId={subject && subject !== COMPANY ? subject : ''}
            onBack={() => navigate({ serviceId: undefined })}
            onCreated={(created) => {
              queryClient.setQueryData(keys.requests.detail(created.id), created);
              void queryClient.invalidateQueries({ queryKey: keys.requests.all, predicate: (q) => q.queryKey[1] !== 'detail' });
              navigate({ draft: created.id, step: 'details', serviceId: undefined, renewalOf: undefined, employee: undefined, for: undefined }, 'replace');
            }}
          />
        ) : (
          <ServicePicker renewal={renewal} onPick={(id) => navigate({ serviceId: id })} />
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
          <NotFoundCard title={t('my.wizard.draftMissingTitle')} text={t('my.wizard.draftMissingText')} backHref={ROUTES.requests} backLabel={t('nav.requests')} />
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
              <Link href={`${ROUTES.requests}/${view.id}`}>{t('my.wizard.openRequest')}</Link>
            </Button>
          }
        >
          {t('my.wizard.alreadySubmittedText', { number: view.requestNo })}
        </Alert>
      </>
    );
  }

  const step: DraftStep = isDraftStep(stepParam) ? stepParam : resumeStep(view, i18n);
  const go = async (next: string) => {
    // The person and the service of a draft are fixed: its form and checklist belong to them.
    if (!isDraftStep(next)) return;
    // Leaving a step saves it first; when that fails the person stays where the problem is.
    if (flush.current && !(await flush.current())) return;
    navigate({ step: next });
  };

  return (
    <>
      {header}
      {stepper(step, (id) => void go(id))}
      {step === 'details' ? <DetailsStep key={view.id} view={view} apply={apply} flush={flush} onNext={() => navigate({ step: 'documents' })} onLater={() => router.push(ROUTES.requests)} /> : null}
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
            void queryClient.invalidateQueries({ queryKey: keys.account });
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
          router.push(ROUTES.requests);
        }}
      />
    </>
  );
}

/** "For: Ravi Kumar – change" above the service steps. */
function SubjectLine({ name, company, loading, onChange }: { name: string; company: boolean; loading: boolean; onChange: () => void }) {
  const { t } = useI18n();
  const Icon = company ? Building2 : UserRound;
  return (
    <div className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border bg-card px-4 py-2.5 text-base shadow-xs" data-request-for>
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="text-muted-foreground">{t('my.wizard.who.for')}</span>
      {loading ? <Skeleton className="h-5 w-40" /> : <span className="font-medium text-foreground" dir="auto">{name}</span>}
      <Button variant="link" className="ms-auto h-auto p-0" onClick={onChange}>
        {t('my.wizard.who.change')}
      </Button>
    </div>
  );
}

function RenewalNotice({ renewal, className }: { renewal: ReminderRow; className?: string }) {
  const { t, pick, formatDate } = useI18n();
  return (
    <Alert tone="info" className={className} title={t('my.wizard.service.renewalTitle')} data-renewal>
      {t('my.wizard.service.renewalText', { document: pick(renewal.documentTypeName, renewal.documentTypeNameAr), subject: renewal.subjectLabel ?? '', date: formatDate(renewal.expiryDate) })}
    </Alert>
  );
}

// ---------------------------------------------------------------- step 1 (administrators): who is it for

function WhoStep({ renewal, companyName, onChosen }: { renewal?: ReminderRow; companyName: string; onChosen: (value: string) => void }) {
  const { t } = useI18n();
  const api = usePortalApi();
  const [kind, setKind] = React.useState<'employee' | 'company'>('employee');
  const [employeeId, setEmployeeId] = React.useState('');
  const [label, setLabel] = React.useState<string | null>(null);
  const [missing, setMissing] = React.useState(false);
  const pickerId = React.useId();

  // A renewal started from a reminder: the reminder names its subject in words only, so the
  // employee whose name it carries is proposed (the administrator confirms; the API checks the link).
  const subjectLabel = renewal?.subjectLabel?.trim() ?? '';
  const proposal = useQuery({
    queryKey: [...keys.employees.all, 'proposal', subjectLabel],
    queryFn: async ({ signal }) => {
      const page = await api.employees({ q: subjectLabel.split(/\s+/)[0], status: 'ACTIVE', pageSize: 100 }, signal);
      const matches = page.data.filter((e) => subjectLabel.toLowerCase().includes(e.fullName.trim().toLowerCase()));
      return matches.length === 1 ? matches[0] : null;
    },
    enabled: !!subjectLabel,
    staleTime: 60_000,
  });
  const proposed = proposal.data;
  const companyRenewal = !!subjectLabel && !!companyName && subjectLabel.toLowerCase().includes(companyName.trim().toLowerCase());
  React.useEffect(() => {
    if (proposed && !employeeId) {
      setEmployeeId(proposed.id);
      setLabel(proposed.fullName);
    } else if (!proposed && companyRenewal && proposal.isFetched) setKind('company');
    // Only when the proposal arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proposed, companyRenewal, proposal.isFetched]);

  const loadEmployees = React.useCallback(
    async (q: string, signal: AbortSignal): Promise<ComboboxOption[]> => {
      const page = await api.employees({ q: q || undefined, status: 'ACTIVE', pageSize: 20, sort: 'fullName:asc' }, signal);
      return page.data.map((e) => ({ value: e.id, label: e.fullName, description: [e.employeeNo, e.designation].filter(Boolean).join(' – ') || undefined }));
    },
    [api],
  );

  const next = () => {
    if (kind === 'company') return onChosen(COMPANY);
    if (!employeeId) return setMissing(true);
    onChosen(employeeId);
  };

  return (
    <div className="max-w-2xl space-y-5">
      {renewal ? <RenewalNotice renewal={renewal} /> : null}
      <Card>
        <CardContent className="space-y-5">
          <div>
            <h2 className="text-lg font-semibold">{t('my.wizard.who.title')}</h2>
            <p className="mt-1 text-base text-muted-foreground">{t('my.wizard.who.text')}</p>
          </div>
          <RadioGroup value={kind} onValueChange={(v) => setKind(v as 'employee' | 'company')} aria-label={t('my.wizard.who.title')} className="gap-4">
            <div className="space-y-3">
              <ChoiceLabel htmlFor={`${pickerId}-employee`} control={<RadioGroupItem id={`${pickerId}-employee`} value="employee" />} label={t('my.wizard.who.employee')} description={t('my.wizard.who.employeeHint')} />
              {kind === 'employee' ? (
                <div className="space-y-1.5 ps-8">
                  <Label htmlFor={pickerId} required>
                    {t('my.wizard.who.pick')}
                  </Label>
                  <Combobox
                    id={pickerId}
                    value={employeeId}
                    selectedLabel={label}
                    onValueChange={(id, option) => {
                      setEmployeeId(id);
                      setLabel(option?.label ?? null);
                      setMissing(false);
                    }}
                    loadOptions={loadEmployees}
                    placeholder={t('my.wizard.who.pickPlaceholder')}
                    searchPlaceholder={t('my.requests.employeeSearch')}
                    emptyText={t('my.requests.employeeNone')}
                    aria-invalid={missing}
                    aria-describedby={missing ? `${pickerId}-error` : undefined}
                  />
                  {missing ? (
                    <p id={`${pickerId}-error`} role="alert" className="text-sm text-destructive-text">
                      {t('my.wizard.who.pickRequired')}
                    </p>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      {t('my.wizard.who.notListed')}{' '}
                      <Link href={`${ROUTES.employees}?add=1`} className="font-medium text-secondary-text underline-offset-4 hover:underline">
                        {t('my.wizard.who.addEmployee')}
                      </Link>
                    </p>
                  )}
                </div>
              ) : null}
            </div>
            <ChoiceLabel
              htmlFor={`${pickerId}-company`}
              control={<RadioGroupItem id={`${pickerId}-company`} value="company" />}
              label={companyName ? t('my.wizard.who.company', { name: companyName }) : t('my.wizard.who.companyShort')}
              description={t('my.wizard.who.companyHint')}
            />
          </RadioGroup>
        </CardContent>
      </Card>
      <div className="flex flex-col gap-2 sm:flex-row sm:justify-end [&>*]:w-full sm:[&>*]:w-auto">
        <Button size="lg" onClick={next} data-action="who-continue">
          {t('common.continue')}
          <ArrowRight className="rtl-mirror" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- choose the service

function ServicePicker({ renewal, onPick }: { renewal?: ReminderRow; onPick: (serviceId: string) => void }) {
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
              <Link href={`${ROUTES.support}?new=1`}>{t('my.support.ask')}</Link>
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
      {renewal ? <RenewalNotice renewal={renewal} /> : null}
      <h2 id="pick-h" className="text-lg font-semibold">
        {t('my.wizard.service.title')}
      </h2>
      <div className="max-w-md">
        <SearchInput value={q} onChange={setQ} placeholder={t('my.service.searchPlaceholder')} aria-label={t('my.service.searchPlaceholder')} />
      </div>
      <div className="scroll-quiet -mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0" role="group" aria-label={t('my.service.categories')}>
        {chip('', t('my.service.allCategories'))}
        {categories.map((c) => chip(c.key, pick(c.name, c.nameAr)))}
      </div>
      {services.length === 0 ? (
        <Card>
          <EmptyState
            icon={<SearchX />}
            title={t('my.service.emptyTitle')}
            description={t('my.service.emptyText')}
            action={
              <Button
                variant="outline"
                onClick={() => {
                  setQ('');
                  setCategory('');
                }}
              >
                {t('my.service.clear')}
              </Button>
            }
          />
        </Card>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {services.map((s) => {
            const Icon = categoryIcon(s.category.icon);
            const tone = TILE_TONES[Math.max(0, categories.findIndex((c) => c.key === s.category.key)) % TILE_TONES.length];
            const contract = isContractPrice(s.price);
            return (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => onPick(s.id)}
                  data-service={s.id}
                  className={cn('flex h-full w-full items-center gap-3.5 rounded-lg border bg-card p-4 text-start shadow-xs transition-shadow hover:shadow-md', focusRing)}
                >
                  <span aria-hidden="true" className={cn('flex size-11 shrink-0 items-center justify-center rounded-lg', tone)}>
                    <Icon className="size-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="text-md font-semibold text-foreground">{pick(s.name, s.nameAr)}</span>
                      {contract ? (
                        <Badge tone="success" data-contract-price>
                          {t('my.service.contractBadge')}
                        </Badge>
                      ) : null}
                    </span>
                    <span className="mt-0.5 block text-sm text-muted-foreground">
                      {pick(s.category.name, s.category.nameAr)}
                      {s.price ? (
                        <>
                          <span aria-hidden="true"> – </span>
                          {Number(s.price.total) === 0 ? t('my.service.free') : <>{t('my.service.from')}: <Money amount={s.price.total} currency={s.price.currency} /></>}
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
function ServiceIntro({ serviceId, renewal, employeeId, onBack, onCreated }: { serviceId: string; renewal?: ReminderRow; employeeId: string; onBack: () => void; onCreated: (view: RequestView) => void }) {
  const { t, pick } = useI18n();
  const api = usePortalApi();
  const describe = useErrorMessage();
  // An employee starts a request of the company about themselves: the company decides and pays.
  const employee = !useRole().company;
  const service = useQuery({ queryKey: keys.catalogue.service(serviceId), queryFn: () => api.service(serviceId), retry: retryUnlessFinal });
  const branches = useQuery({ queryKey: keys.branches, queryFn: () => api.branches(), staleTime: 10 * 60_000 });
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
            <EmptyState size="page" icon={<Store />} title={t('my.service.notFoundTitle')} description={t('my.service.notFoundText')} />
          </Card>
        ) : (
          <LoadError error={service.error} onRetry={() => void service.refetch()} />
        )}
      </>
    );
  }

  const s = service.data;
  const offered = (branches.data ?? []).filter((b) => s.allBranches || s.branchIds.includes(b.id));
  const description = pick(s.description, s.descriptionAr);

  const start = async () => {
    setBusy(true);
    setFailure(null);
    try {
      onCreated(await api.createRequest({ serviceId: s.id, ...(employeeId ? { corporateEmployeeId: employeeId } : {}), ...(branchId ? { branchId } : {}), ...(renewal ? { renewalOfScheduleId: renewal.id } : {}) }));
    } catch (error) {
      // The company has no record of its own at the centre yet: only the centre can create it.
      if (isApiError(error) && error.code === 'COMPANY_PROFILE_MISSING') setFailure(t('my.wizard.who.companyMissing'));
      else setFailure(describe(error));
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
          {renewal ? <RenewalNotice renewal={renewal} /> : null}
          {employee ? <CompanyRequestNotice /> : null}
          {/* Say plainly what the centre does and what stays with the company or the authority. */}
          <Alert tone="info">{t(`my.service.capability.${s.complianceCapability}`)}</Alert>
          {!s.onlineAvailable ? <Alert tone="warning">{t('my.service.centreOnly')}</Alert> : null}
          <section aria-labelledby="need-h">
            <h3 id="need-h" className="mb-3 text-md font-semibold">
              {t('my.service.documentsTitle')}
            </h3>
            <RequirementList requirements={s.requirements} />
            {s.requirements.some((r) => r.allowReuse) ? <p className="mt-2 text-sm text-muted-foreground">{t('my.wizard.service.reuseNote')}</p> : null}
          </section>
          {s.eligibilityGuidance ? (
            <section aria-labelledby="before-h">
              <h3 id="before-h" className="mb-2 text-md font-semibold">
                {t('my.service.eligibility')}
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
                  <h3 className="mb-3 text-md font-semibold">{s.price.containsEstimates ? t('my.service.feesTitle') : t('my.price.title')}</h3>
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
                  <Button variant="accent" size="lg" className="w-full" loading={busy} loadingText={t('common.loading')} onClick={() => void start()} data-action="start-request">
                    {t('my.wizard.service.start')}
                  </Button>
                  <p className="text-sm text-muted-foreground">{t('my.wizard.service.startHint')}</p>
                </div>
              ) : (
                <Button asChild variant="outline" className="w-full">
                  <Link href={`${ROUTES.support}?new=1`}>{t('my.support.ask')}</Link>
                </Button>
              )}
            </CardContent>
          </Card>
        </aside>
      </div>
    </>
  );
}
