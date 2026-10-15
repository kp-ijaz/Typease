'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, CircleCheck, Pencil } from 'lucide-react';
import { isApiError } from '@typease/api-client';
import { formFields } from '@typease/validation';
import { Alert, Button, Card, CardContent, CopyButton, DescriptionList, Label, Textarea, countryName, useErrorMessage, useI18n } from '@typease/ui';
import { ChecklistBadge, DocumentChecklist, missingDocuments } from '@/components/portal/checklist';
import { DynamicForm, checkForm, displayFormValue, fieldsPayload, formErrorsOf, type FormErrors, type FormValuesState } from '@/components/portal/dynamic-form';
import { CompanyRequestNotice, FeeEstimate, ProcessingTime, WhatHappensNext } from '@/components/portal/service-info';
import { PersonName, SectionTitle, useRole } from '@/components/portal/shared';
import { usePortalApi } from '@/lib/api';
import { ROUTES } from '@/lib/config';
import { keys } from '@/lib/query-keys';
import type { RequestView, SubmittedRequest } from '@/lib/types';

/** Saves what the step holds. Resolves false when the save failed and the person should stay on the step. */
export type Flush = () => Promise<boolean>;

/** Back on the start side, the step's main action on the end side; stacked and full width on phones. */
function StepButtons({ back, children }: { back?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between [&>*]:w-full sm:[&>*]:w-auto">
      <div className="flex flex-col-reverse gap-2 sm:flex-row [&>*]:w-full sm:[&>*]:w-auto">{back}</div>
      <div className="flex flex-col-reverse gap-2 sm:flex-row [&>*]:w-full sm:[&>*]:w-auto">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------- step 2: details

export function DetailsStep({ view, apply, flush, onNext, onLater }: {
  view: RequestView;
  apply: (view?: RequestView | null) => void;
  /** The wizard calls this before leaving the step by another way (the stepper). */
  flush: React.MutableRefObject<Flush | null>;
  onNext: () => void;
  onLater: () => void;
}) {
  const i18n = useI18n();
  const { t, formatTime } = i18n;
  const api = usePortalApi();
  const describe = useErrorMessage();
  const schema = view.form.schema;
  const hasForm = !!schema && formFields(schema).length > 0;

  const [values, setValues] = React.useState<FormValuesState>(view.form.values);
  const [instructions, setInstructions] = React.useState(view.customerInstructions ?? '');
  const [errors, setErrors] = React.useState<FormErrors>({});
  const [failure, setFailure] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<'next' | 'later' | 'auto' | null>(null);
  const [savedAt, setSavedAt] = React.useState<Date | null>(null);
  const instructionsId = React.useId();

  // What the server holds, to send only what changed.
  const stored = React.useRef({ values: view.form.values, instructions: view.customerInstructions ?? '' });
  const latest = React.useRef({ values, instructions });
  latest.current = { values, instructions };
  const running = React.useRef<Promise<boolean> | null>(null);

  const dirty = () => {
    const now = latest.current;
    const fields = schema ? fieldsPayload(schema, now.values, stored.current.values) : {};
    const changed = Object.entries(fields).filter(([key, value]) => JSON.stringify(value ?? null) !== JSON.stringify(stored.current.values[key] ?? null));
    return { fields: Object.fromEntries(changed), instructions: now.instructions.trim() !== stored.current.instructions.trim() };
  };

  /** Saves the draft. Only "next" insists on a complete form; a draft may be half filled, but what is filled in must be valid. */
  const save = React.useCallback(
    async (mode: 'next' | 'later' | 'auto'): Promise<boolean> => {
      if (running.current) await running.current;
      const job = (async () => {
        const now = latest.current;
        const check = checkForm(schema, now.values, mode !== 'next', i18n);
        if (!check.ok) {
          // A silent save never interrupts typing; an explicit one shows what is wrong.
          if (mode !== 'auto') {
            setErrors(check.errors);
            setFailure(mode === 'next' ? t('my.wizard.details.incomplete') : t('form.checkFields'));
          }
          return false;
        }
        const change = dirty();
        if (!Object.keys(change.fields).length && !change.instructions) return true;
        setBusy(mode);
        try {
          let next: RequestView | null = null;
          if (Object.keys(change.fields).length) next = await api.saveFields(view.id, change.fields);
          if (change.instructions) next = await api.updateRequest(view.id, { instructions: now.instructions.trim() || null });
          if (next) {
            stored.current = { values: next.form.values, instructions: now.instructions };
            apply(next);
          }
          setSavedAt(new Date());
          setFailure(null);
          return true;
        } catch (error) {
          const fieldErrors = formErrorsOf(error, schema, i18n);
          if (Object.keys(fieldErrors).length) setErrors(fieldErrors);
          if (mode !== 'auto' || !Object.keys(fieldErrors).length) setFailure(Object.keys(fieldErrors).length ? t('form.checkFields') : describe(error));
          return false;
        } finally {
          setBusy(null);
        }
      })();
      running.current = job;
      try {
        return await job;
      } finally {
        if (running.current === job) running.current = null;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, apply, i18n, schema, t, view.id],
  );

  // Leaving through the stepper saves too.
  React.useEffect(() => {
    flush.current = () => save('later');
    return () => {
      flush.current = null;
    };
  }, [flush, save]);

  // The draft is saved a moment after the person stops typing: a phone call or a closed tab costs nothing.
  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      const change = dirty();
      if (Object.keys(change.fields).length || change.instructions) void save('auto');
    }, 1500);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values, instructions]);

  const change = (key: string, value: unknown) => {
    setValues((s) => ({ ...s, [key]: value }));
    setErrors((s) => {
      if (!(key in s)) return s;
      const { [key]: _removed, ...rest } = s;
      return rest;
    });
  };

  return (
    <div className="space-y-5">
      <Card>
        <CardContent className="space-y-8">
          <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
            <div>
              <SectionTitle>{t('my.wizard.details.title')}</SectionTitle>
              <p className="mt-1 text-base text-muted-foreground">{t('my.wizard.details.text')}</p>
            </div>
            <p className="text-sm text-muted-foreground" role="status" data-save-state={busy ? 'saving' : savedAt ? 'saved' : 'idle'}>
              {busy ? t('common.saving') : savedAt ? t('my.wizard.details.savedAt', { time: formatTime(savedAt) }) : null}
            </p>
          </div>

          {hasForm && schema ? <DynamicForm schema={schema} values={values} errors={errors} sources={view.form.fields} onChange={change} /> : <Alert tone="info">{t('my.wizard.details.noForm')}</Alert>}

          <div className="space-y-1.5 border-t pt-6">
            <Label htmlFor={instructionsId} optionalText={t('common.optional')}>
              {t('my.wizard.details.instructions')}
            </Label>
            <Textarea id={instructionsId} rows={3} dir="auto" maxLength={2000} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
            <p className="text-sm text-muted-foreground">{t('my.wizard.details.instructionsHint')}</p>
          </div>

          {failure ? (
            <Alert tone="danger" live>
              {failure}
            </Alert>
          ) : null}
        </CardContent>
      </Card>

      <StepButtons
        back={
          <Button
            variant="outline"
            loading={busy === 'later'}
            loadingText={t('common.saving')}
            onClick={async () => {
              if (await save('later')) onLater();
            }}
          >
            {t('my.wizard.saveLater')}
          </Button>
        }
      >
        <Button
          size="lg"
          loading={busy === 'next'}
          loadingText={t('common.saving')}
          onClick={async () => {
            if (await save('next')) onNext();
          }}
        >
          {t('common.continue')}
          <ArrowRight className="rtl-mirror" aria-hidden="true" />
        </Button>
      </StepButtons>
    </div>
  );
}

// ---------------------------------------------------------------- step 3: documents

export function DocumentsStep({ view, apply, onBack, onNext }: { view: RequestView; apply: (view?: RequestView | null) => void; onBack: () => void; onNext: () => void }) {
  const { t, tn } = useI18n();
  const missing = missingDocuments(view).length;
  const inputs = view.checklist.filter((line) => line.kind === 'INPUT');
  return (
    <div className="space-y-5">
      <Card>
        <CardContent className="space-y-5">
          <div>
            <SectionTitle>{t('my.wizard.documents.title')}</SectionTitle>
            <p className="mt-1 text-base text-muted-foreground">{inputs.length ? t('my.wizard.documents.text') : t('my.service.documentsNone')}</p>
          </div>
          {inputs.length ? <DocumentChecklist view={view} editable onChanged={apply} /> : null}
          {missing > 0 ? (
            <Alert tone="warning" data-missing-documents={missing}>
              {tn('my.wizard.documents.missing', missing)}
            </Alert>
          ) : null}
        </CardContent>
      </Card>
      <StepButtons
        back={
          <Button variant="outline" onClick={onBack}>
            <ArrowLeft className="rtl-mirror" aria-hidden="true" />
            {t('common.back')}
          </Button>
        }
      >
        <Button size="lg" onClick={onNext}>
          {t('common.continue')}
          <ArrowRight className="rtl-mirror" aria-hidden="true" />
        </Button>
      </StepButtons>
    </div>
  );
}

// ---------------------------------------------------------------- step 4: review and submit

export function ReviewStep({ view, onEdit, onSubmitted }: { view: RequestView; onEdit: (step: 'details' | 'documents') => void; onSubmitted: (result: SubmittedRequest) => void }) {
  const i18n = useI18n();
  const { t, tn, pick, locale } = i18n;
  const api = usePortalApi();
  const role = useRole();
  const describe = useErrorMessage();
  const service = useQuery({ queryKey: keys.catalogue.service(view.service.id), queryFn: () => api.service(view.service.id), staleTime: 5 * 60_000 });
  const [busy, setBusy] = React.useState(false);
  const [failure, setFailure] = React.useState<string | null>(null);
  const employee = !role.company;

  const schema = view.form.schema;
  const fields = schema ? formFields(schema).filter((f) => view.form.visibleFields.includes(f.key)) : [];
  const formCheck = checkForm(schema, view.form.values, false, i18n);
  const missing = missingDocuments(view);
  const inputs = view.checklist.filter((line) => line.kind === 'INPUT');

  const submit = async () => {
    setBusy(true);
    setFailure(null);
    try {
      onSubmitted(await api.submitRequest(view.id));
    } catch (error) {
      // The server checks the whole form again: send the person to the step that has the problem.
      if (isApiError(error) && error.code === 'FORM_INVALID') setFailure(t('my.wizard.review.formInvalid'));
      else setFailure(describe(error));
      setBusy(false);
    }
  };

  const editButton = (step: 'details' | 'documents') => (
    <Button variant="ghost" size="sm" onClick={() => onEdit(step)}>
      <Pencil aria-hidden="true" />
      {t('common.edit')}
    </Button>
  );

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
      <div className="min-w-0 space-y-5">
        <Card>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <SectionTitle>{t('my.wizard.review.details')}</SectionTitle>
              {editButton('details')}
            </div>
            {!formCheck.ok ? (
              <Alert tone="warning" action={<Button size="sm" variant="outline" onClick={() => onEdit('details')}>{t('my.wizard.review.complete')}</Button>}>
                {t('my.wizard.details.incomplete')}
              </Alert>
            ) : null}
            <DescriptionList
              items={[
                { label: t('my.requests.columns.service'), value: pick(view.service.name, view.service.nameAr), wide: true },
                ...(role.company ? [{ label: t('my.requests.columns.person'), value: <RequestSubject view={view} /> }] : []),
                { label: t('my.wizard.service.branch'), value: pick(view.branch.name, view.branch.nameAr) },
                ...fields.map((field) => ({
                  label: pick(field.label, field.labelAr),
                  value: <span dir="auto">{displayFormValue(field, view.form.values[field.key], i18n, (code) => countryName(code, locale))}</span>,
                  wide: field.type === 'textarea',
                })),
                ...(view.customerInstructions ? [{ label: t('my.wizard.details.instructions'), value: <span dir="auto" className="whitespace-pre-wrap">{view.customerInstructions}</span>, wide: true }] : []),
              ]}
            />
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <SectionTitle>{t('my.wizard.review.documents')}</SectionTitle>
              {editButton('documents')}
            </div>
            {inputs.length === 0 ? (
              <p className="text-base text-muted-foreground">{t('my.service.documentsNone')}</p>
            ) : (
              <ul className="divide-y rounded-lg border">
                {inputs.map((line) => (
                  <li key={line.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-3">
                    <span className="min-w-0 text-base">{pick(line.label, line.labelAr)}</span>
                    <ChecklistBadge line={line} />
                  </li>
                ))}
              </ul>
            )}
            {missing.length ? (
              <Alert tone="warning" action={<Button size="sm" variant="outline" onClick={() => onEdit('documents')}>{t('my.wizard.review.addDocuments')}</Button>}>
                {tn('my.wizard.documents.missing', missing.length)}
              </Alert>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <aside className="space-y-5 lg:sticky lg:top-24">
        <Card>
          <CardContent className="space-y-5">
            {service.data?.price ? (
              <div>
                <h3 className="mb-3 text-md font-semibold">{service.data.price.containsEstimates ? t('my.service.feesTitle') : t('my.price.title')}</h3>
                <FeeEstimate price={service.data.price} />
              </div>
            ) : null}
            <ProcessingTime hours={service.data?.estimatedProcessingHours} />
            <div>
              <h3 className="mb-3 text-md font-semibold">{t('my.next.title')}</h3>
              <WhatHappensNext policy={service.data?.paymentPolicy} capability={service.data?.complianceCapability} employee={employee} />
            </div>
          </CardContent>
        </Card>
        {employee ? <CompanyRequestNotice /> : null}
        {failure ? (
          <Alert tone="danger" live>
            {failure}
          </Alert>
        ) : null}
        <div className="space-y-2">
          <Button variant="accent" size="lg" className="w-full" disabled={!formCheck.ok} loading={busy} loadingText={t('common.loading')} onClick={() => void submit()}>
            {t('my.wizard.review.submit')}
          </Button>
          <p className="text-sm text-muted-foreground">{role.company ? t('my.wizard.review.confirmCompany') : t('my.wizard.review.confirm')}</p>
        </div>
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------- done

export function DoneScreen({ result }: { result: SubmittedRequest }) {
  const { t, pick } = useI18n();
  const api = usePortalApi();
  const role = useRole();
  const forPerson = role.company && result.customer.type !== 'BUSINESS';
  const service = useQuery({ queryKey: keys.catalogue.service(result.service.id), queryFn: () => api.service(result.service.id), staleTime: 5 * 60_000 });
  return (
    <div className="mx-auto max-w-2xl">
      <Card>
        <CardContent className="space-y-6 sm:p-8">
          <div className="flex flex-col items-center text-center" role="status">
            <span className="mb-4 flex size-14 items-center justify-center rounded-full bg-success-soft text-success-text">
              <CircleCheck className="size-8" aria-hidden="true" />
            </span>
            <h1 className="text-2xl font-semibold">{t('my.wizard.done.title')}</h1>
            <p className="mt-2 max-w-md text-base text-muted-foreground">
              {forPerson
                ? t('my.wizard.done.textFor', { service: pick(result.service.name, result.service.nameAr), name: pick(result.customer.fullName, result.customer.fullNameAr) })
                : t('my.wizard.done.text', { service: pick(result.service.name, result.service.nameAr) })}
            </p>
          </div>

          <dl className="divide-y rounded-lg border">
            <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
              <dt className="text-base text-muted-foreground">{t('my.requests.columns.number')}</dt>
              <dd className="flex items-center gap-1">
                <span className="tabular ltr-value text-md font-semibold" data-request-no>
                  {result.requestNo}
                </span>
                <CopyButton value={result.requestNo} label={t('my.wizard.done.copyNumber')} />
              </dd>
            </div>
            {result.trackingCode ? (
              <div className="px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <dt className="text-base text-muted-foreground">{t('my.wizard.done.trackingCode')}</dt>
                  <dd className="flex items-center gap-1">
                    <span className="tabular ltr-value text-md font-semibold" data-tracking-code>
                      {result.trackingCode}
                    </span>
                    <CopyButton value={result.trackingCode} label={t('my.wizard.done.copyCode')} />
                  </dd>
                </div>
                <p className="mt-1.5 text-sm text-muted-foreground">{t('my.wizard.done.codeHint')}</p>
              </div>
            ) : null}
          </dl>

          <div>
            <h2 className="mb-3 text-md font-semibold">{t('my.next.title')}</h2>
            <WhatHappensNext policy={service.data?.paymentPolicy} capability={service.data?.complianceCapability} employee={!role.company} />
          </div>

          <div className="flex flex-col gap-2 sm:flex-row [&>*]:w-full sm:[&>*]:w-auto">
            <Button asChild size="lg">
              <Link href={`${ROUTES.requests}/${result.id}`}>{t('my.wizard.openRequest')}</Link>
            </Button>
            {role.company ? (
              // HR usually files the same service for several people: the next one starts with the service chosen.
              <Button asChild variant="outline" size="lg" data-action="same-again">
                <Link href={`${ROUTES.newRequest}?serviceId=${result.service.id}`}>{t('my.wizard.done.another')}</Link>
              </Button>
            ) : (
              <Button asChild variant="outline" size="lg">
                <Link href={ROUTES.requests}>{t('my.wizard.done.list')}</Link>
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/** Who a request is for: the employee by name, or the company itself. */
export function RequestSubject({ view }: { view: Pick<RequestView, 'customer'> }) {
  const { t, pick } = useI18n();
  if (view.customer.type === 'BUSINESS') return <>{t('my.wizard.who.companyShort')}</>;
  return <PersonName name={pick(view.customer.fullName, view.customer.fullNameAr)} erased={view.customer.erased} />;
}
