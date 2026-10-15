'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { AlertTriangle, ArrowRight, CircleCheck, FilePlus2, Pencil, Printer } from 'lucide-react';
import type { RequestPriority } from '@typease/api-client';
import { formFields } from '@typease/validation';
import {
  Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, CopyButton, DatePicker, DescriptionList, Label, STATUS_META, Select, StatusBadge, Textarea, countryName,
  useBranding, useI18n, useSession,
} from '@typease/ui';
import { useCasesApi } from '@/components/cases/api';
import { DynamicForm, checkForm, displayFormValue, fieldsPayload, formErrorsOf, type FormErrors, type FormValuesState } from '@/components/cases/dynamic-form';
import { caseErrorText, dateInputToIso, isoToDateInput } from '@/components/cases/shared';
import type { CaseView, SubmittedCase } from '@/components/cases/types';
import { StepButtons, type WizardStep } from './wizard-shared';

const PRIORITIES: RequestPriority[] = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];

/** Saves what the step holds. Resolves false when the save failed and the person should stay on the step. */
export type Flush = () => Promise<boolean>;

// ---------------------------------------------------------------- step 3: details

interface Extras {
  instructions: string;
  priority: RequestPriority;
  targetDate: string;
}

export function DetailsStep({ view, apply, flush, onBack, onNext }: {
  view: CaseView;
  apply: (view?: CaseView | null) => void;
  /** The wizard calls this before leaving the step by another way (the stepper). */
  flush: React.MutableRefObject<Flush | null>;
  onBack: () => void;
  onNext: () => void;
}) {
  const i18n = useI18n();
  const { t, pick, timeZone, today, formatTime } = i18n;
  const api = useCasesApi();
  const schema = view.form.schema;
  const hasForm = !!schema && formFields(schema).length > 0;
  const savedExtras = (v: CaseView): Extras => ({ instructions: v.customerInstructions ?? '', priority: v.priority, targetDate: isoToDateInput(v.targetDate, timeZone) });

  const [values, setValues] = React.useState<FormValuesState>(view.form.values);
  const [extras, setExtras] = React.useState<Extras>(() => savedExtras(view));
  const [errors, setErrors] = React.useState<FormErrors>({});
  const [failure, setFailure] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<'next' | 'back' | 'auto' | null>(null);
  const [savedAt, setSavedAt] = React.useState<Date | null>(null);
  const instructionsId = React.useId();
  const priorityId = React.useId();
  const targetId = React.useId();

  // What the server holds, to send only what changed.
  const stored = React.useRef({ values: view.form.values, extras: savedExtras(view), version: view.version });
  const latest = React.useRef({ values, extras });
  latest.current = { values, extras };
  const running = React.useRef<Promise<boolean> | null>(null);

  const dirty = () => {
    const now = latest.current;
    const fields = schema ? fieldsPayload(schema, now.values, stored.current.values) : {};
    const changedFields = Object.entries(fields).filter(([key, value]) => JSON.stringify(value ?? null) !== JSON.stringify(stored.current.values[key] ?? null));
    const e = stored.current.extras;
    return { fields: Object.fromEntries(changedFields), extras: now.extras.instructions !== e.instructions || now.extras.priority !== e.priority || now.extras.targetDate !== e.targetDate };
  };

  /** Saves the draft. `partial`: required fields may still be empty, but what is filled in must be valid. */
  const save = React.useCallback(
    async (mode: 'next' | 'back' | 'auto'): Promise<boolean> => {
      if (running.current) await running.current;
      const job = (async () => {
        const now = latest.current;
        const check = checkForm(schema, now.values, mode !== 'next', i18n);
        if (!check.ok) {
          // A silent save never interrupts typing; an explicit one shows what is wrong.
          if (mode !== 'auto') {
            setErrors(check.errors);
            setFailure(mode === 'next' ? t('cases.wizard.details.incomplete') : t('form.checkFields'));
          }
          return false;
        }
        const change = dirty();
        if (!Object.keys(change.fields).length && !change.extras) return true;
        setBusy(mode);
        try {
          let next: CaseView | null = null;
          if (Object.keys(change.fields).length) next = await api.saveFields(view.id, change.fields);
          if (change.extras) {
            const e = stored.current.extras;
            next = await api.update(view.id, {
              ...(now.extras.instructions !== e.instructions ? { instructions: now.extras.instructions } : {}),
              ...(now.extras.priority !== e.priority ? { priority: now.extras.priority } : {}),
              ...(now.extras.targetDate !== e.targetDate ? { targetDate: now.extras.targetDate ? dateInputToIso(now.extras.targetDate, timeZone) : null } : {}),
            });
          }
          if (next) {
            stored.current = { values: next.form.values, extras: { ...now.extras }, version: next.version };
            apply(next);
          }
          setSavedAt(new Date());
          setFailure(null);
          return true;
        } catch (error) {
          const fieldErrors = formErrorsOf(error, schema, i18n);
          if (Object.keys(fieldErrors).length) setErrors(fieldErrors);
          if (mode !== 'auto' || !Object.keys(fieldErrors).length) setFailure(Object.keys(fieldErrors).length ? t('form.checkFields') : caseErrorText(error, i18n));
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
    [api, apply, i18n, schema, t, timeZone, view.id],
  );

  // Leaving through the stepper saves too.
  React.useEffect(() => {
    flush.current = () => save('back');
    return () => {
      flush.current = null;
    };
  }, [flush, save]);

  // The draft is saved a moment after the person stops typing: a phone call or a closed tab costs nothing.
  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      const change = dirty();
      if (Object.keys(change.fields).length || change.extras) void save('auto');
    }, 1500);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values, extras]);

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
        <CardHeader className="items-center pb-4">
          <div>
            <CardTitle>{t('cases.wizard.details.title', { service: pick(view.service.name, view.service.nameAr) })}</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">{t('cases.wizard.details.text')}</p>
          </div>
          <p className="text-sm text-muted-foreground" role="status" data-save-state={busy ? 'saving' : savedAt ? 'saved' : 'idle'}>
            {busy ? t('common.saving') : savedAt ? t('cases.wizard.details.savedAt', { time: formatTime(savedAt) }) : null}
          </p>
        </CardHeader>
        <CardContent className="space-y-8 border-t">
          {hasForm && schema ? (
            <DynamicForm schema={schema} values={values} errors={errors} sources={view.form.fields} onChange={change} />
          ) : (
            <Alert tone="info">{t('cases.details.noFormText')}</Alert>
          )}

          <section className="space-y-4 border-t pt-6">
            <h3 className="text-md font-semibold text-foreground">{t('cases.wizard.details.handling')}</h3>
            <div className="space-y-1.5">
              <Label htmlFor={instructionsId} optionalText={t('common.optional')}>
                {t('cases.fields.instructions')}
              </Label>
              <Textarea id={instructionsId} rows={3} dir="auto" maxLength={2000} value={extras.instructions} onChange={(e) => setExtras((s) => ({ ...s, instructions: e.target.value }))} />
              <p className="text-sm text-muted-foreground">{t('cases.actions.instructionsHint')}</p>
            </div>
            <div className="grid gap-5 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor={priorityId}>{t('cases.fields.priority')}</Label>
                <Select
                  id={priorityId}
                  value={extras.priority}
                  onValueChange={(value) => setExtras((s) => ({ ...s, priority: value as RequestPriority }))}
                  options={PRIORITIES.map((p) => ({ value: p, label: pick(STATUS_META.priority[p].en, STATUS_META.priority[p].ar) }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={targetId} optionalText={t('common.optional')}>
                  {t('cases.fields.targetDate')}
                </Label>
                <DatePicker id={targetId} value={extras.targetDate} min={today()} onChange={(value) => setExtras((s) => ({ ...s, targetDate: value }))} />
                <p className="text-sm text-muted-foreground">{t('cases.actions.targetHintDraft')}</p>
              </div>
            </div>
          </section>

          {failure ? (
            <Alert tone="danger" live>
              {failure}
            </Alert>
          ) : null}
        </CardContent>
      </Card>
      <StepButtons
        busy={busy === 'next' || busy === 'back'}
        onBack={() => void save('back').then((ok) => ok && onBack())}
        onNext={() => void save('next').then((ok) => ok && onNext())}
      />
    </div>
  );
}

// ---------------------------------------------------------------- step 5: review and submit

export function ReviewStep({ view, onEdit, onSubmitted }: { view: CaseView; onEdit: (step: WizardStep) => void; onSubmitted: (result: SubmittedCase) => void }) {
  const i18n = useI18n();
  const { t, tn, pick, locale, formatDate } = i18n;
  const api = useCasesApi();
  const [submitting, setSubmitting] = React.useState(false);
  const [failure, setFailure] = React.useState<string | null>(null);

  const schema = view.form.schema;
  const formCheck = checkForm(schema, view.form.values, false, i18n);
  const visible = new Set(view.form.visibleFields);
  const fields = schema ? formFields(schema).filter((f) => visible.has(f.key)) : [];
  const missingFields = fields.filter((f) => formCheck.errors[f.key]);
  const inputs = view.checklist.filter((line) => line.kind === 'INPUT');
  const missingDocs = inputs.filter((line) => line.isMandatory && (line.status === 'MISSING' || line.status === 'REJECTED'));
  const ready = formCheck.ok;

  const submit = async () => {
    setSubmitting(true);
    setFailure(null);
    try {
      onSubmitted(await api.submit(view.id));
    } catch (error) {
      setFailure(caseErrorText(error, i18n));
    } finally {
      setSubmitting(false);
    }
  };

  const edit = (step: WizardStep) => (
    <Button variant="ghost" size="sm" onClick={() => onEdit(step)}>
      <Pencil aria-hidden="true" />
      {t('common.edit')}
    </Button>
  );

  return (
    <div className="space-y-5">
      {missingFields.length || missingDocs.length ? (
        <Alert tone={missingFields.length ? 'danger' : 'warning'} title={missingFields.length ? t('cases.wizard.review.blockedTitle') : t('cases.wizard.review.warningTitle')}>
          <ul className="mt-1 space-y-2">
            {missingFields.length ? (
              <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
                <span>
                  {tn('cases.wizard.review.missingFields', missingFields.length)}{' '}
                  <span className="text-foreground/75">{missingFields.map((f) => pick(f.label, f.labelAr)).join(', ')}</span>
                </span>
                <Button size="sm" variant="outline" onClick={() => onEdit('details')}>
                  {t('cases.wizard.review.fixDetails')}
                </Button>
              </li>
            ) : null}
            {missingDocs.length ? (
              <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
                <span>
                  {tn('cases.wizard.review.missingDocs', missingDocs.length)}{' '}
                  <span className="text-foreground/75">{missingDocs.map((line) => pick(line.label, line.labelAr)).join(', ')}</span>
                  {missingFields.length ? null : <span className="block text-sm text-foreground/75">{t('cases.wizard.review.docsLater')}</span>}
                </span>
                <Button size="sm" variant="outline" onClick={() => onEdit('documents')}>
                  {t('cases.wizard.review.fixDocs')}
                </Button>
              </li>
            ) : null}
          </ul>
        </Alert>
      ) : (
        <Alert tone="success" title={t('cases.wizard.review.readyTitle')}>
          {t('cases.wizard.review.readyText')}
        </Alert>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-4">
            <CardTitle>{t('cases.wizard.review.request')}</CardTitle>
          </CardHeader>
          <CardContent className="border-t">
            <DescriptionList
              columns={1}
              items={[
                {
                  label: t('cases.fields.customer'),
                  value: (
                    <>
                      {view.customer.fullName} <span className="tabular text-muted-foreground">{view.customer.customerNo}</span>
                    </>
                  ),
                },
                { label: t('cases.fields.service'), value: pick(view.service.name, view.service.nameAr) },
                { label: t('cases.fields.branch'), value: pick(view.branch.name, view.branch.nameAr) },
                ...(view.corporateAccount ? [{ label: t('cases.overview.billedTo'), value: pick(view.corporateAccount.companyName, view.corporateAccount.companyNameAr) }] : []),
                { label: t('cases.overview.capability'), value: t(`cases.capability.${view.service.complianceCapability}`) },
              ]}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="items-center pb-4">
            <CardTitle>{t('cases.wizard.details.handling')}</CardTitle>
            {edit('details')}
          </CardHeader>
          <CardContent className="border-t">
            <DescriptionList
              columns={1}
              items={[
                { label: t('cases.fields.priority'), value: <StatusBadge kind="priority" status={view.priority} /> },
                { label: t('cases.fields.targetDate'), value: view.targetDate ? formatDate(view.targetDate) : t('cases.wizard.review.targetAuto') },
                { label: t('cases.fields.instructions'), value: view.customerInstructions ? <span dir="auto" className="whitespace-pre-wrap">{view.customerInstructions}</span> : t('cases.overview.noInstructions') },
              ]}
            />
          </CardContent>
        </Card>
      </div>

      {fields.length ? (
        <Card>
          <CardHeader className="items-center pb-4">
            <CardTitle>{t('cases.details.title')}</CardTitle>
            {edit('details')}
          </CardHeader>
          <CardContent className="border-t">
            <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
              {fields.map((field) => {
                const text = displayFormValue(field, view.form.values[field.key], i18n, (code) => countryName(code, locale) || code);
                return (
                  <div key={field.key} className="min-w-0">
                    <dt className="text-sm text-muted-foreground">{pick(field.label, field.labelAr)}</dt>
                    <dd className="mt-0.5 break-words text-base text-foreground">
                      {text ? (
                        <bdi>{text}</bdi>
                      ) : (
                        <span className={field.required ? 'inline-flex items-center gap-1.5 text-destructive-text' : 'text-muted-foreground'}>
                          {field.required ? <AlertTriangle className="size-4" aria-hidden="true" /> : null}
                          {field.required ? t('cases.details.missing') : '–'}
                        </span>
                      )}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader className="items-center pb-4">
          <CardTitle>{t('cases.tabs.documents')}</CardTitle>
          {edit('documents')}
        </CardHeader>
        {inputs.length ? (
          <ul className="divide-y border-t">
            {inputs.map((line) => (
              <li key={line.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-5 py-3">
                <span className="min-w-0 text-base text-foreground" dir="auto">
                  {pick(line.label, line.labelAr)}
                  {line.isMandatory ? null : <span className="ms-2 text-sm text-muted-foreground">({t('cases.docs.optional')})</span>}
                </span>
                <StatusBadge kind="checklist" status={line.status} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="border-t px-5 py-4 text-sm text-muted-foreground">{t('cases.docs.inputsNone')}</p>
        )}
      </Card>

      {failure ? (
        <Alert tone="danger" live>
          {failure}
        </Alert>
      ) : null}
      <Card className="border-secondary/30 bg-secondary-soft/50">
        <CardContent className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0 flex-1 basis-72">
            <p className="text-md font-semibold text-foreground">{t('cases.wizard.review.submitTitle')}</p>
            <p className="mt-1 text-sm text-foreground/80">{ready ? t('cases.wizard.review.submitText') : t('cases.wizard.review.submitBlocked')}</p>
          </div>
          <div className="flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row">
            <Button variant="outline" onClick={() => onEdit('documents')} disabled={submitting}>
              {t('common.back')}
            </Button>
            <Button variant="accent" size="lg" onClick={() => void submit()} loading={submitting} loadingText={t('common.saving')} disabled={!ready} data-submit-request>
              {t('cases.wizard.review.submit')}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- after submission

const SLIP_CSS = `
#tracking-slip-root { display: none; }
@media print {
  @page { margin: 16mm; }
  body > *:not(#tracking-slip-root) { display: none !important; }
  #tracking-slip-root { display: block !important; color: #000; background: #fff; font-size: 12pt; line-height: 1.5; }
  #tracking-slip-root h1 { font-size: 16pt; font-weight: 600; margin-bottom: 10pt; }
  #tracking-slip-root dl { margin: 12pt 0; }
  #tracking-slip-root dt { color: #444; font-size: 10pt; }
  #tracking-slip-root dd { font-size: 15pt; font-weight: 600; margin: 0 0 10pt; }
  #tracking-slip-root .code { font-family: ui-monospace, Menlo, Consolas, monospace; letter-spacing: 0.08em; font-size: 20pt; }
}
`;

/** Shown once, right after submission: the request number and the tracking code the customer needs. */
export function DoneScreen({ result, onNewForCustomer }: { result: SubmittedCase; onNewForCustomer: () => void }) {
  const { t, pick, dir, locale, formatDate } = useI18n();
  const session = useSession();
  const branding = useBranding();
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  const centre = branding.config ? branding.name : session.tenant?.name ?? '';
  const code = result.trackingCode;
  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <Card>
        <CardContent className="space-y-6 p-6 text-center sm:p-8">
          <span aria-hidden="true" className="mx-auto flex size-14 items-center justify-center rounded-full bg-success-soft text-success-text">
            <CircleCheck className="size-8" />
          </span>
          <div>
            <h1 className="text-2xl font-semibold text-foreground">{t('cases.wizard.done.title')}</h1>
            <p className="mt-1.5 text-base text-muted-foreground">{t('cases.wizard.done.text', { name: result.customer.fullName })}</p>
          </div>
          <dl className="grid gap-4 text-start sm:grid-cols-2">
            <div className="rounded-lg border p-4">
              <dt className="text-sm text-muted-foreground">{t('cases.wizard.done.number')}</dt>
              <dd className="mt-1 flex items-center justify-between gap-2">
                <span className="tabular text-xl font-semibold text-foreground" data-request-no>
                  {result.requestNo}
                </span>
                <CopyButton value={result.requestNo} label={t('requests.copyNumber')} />
              </dd>
            </div>
            <div className="rounded-lg border border-warning/40 bg-warning-soft/60 p-4">
              <dt className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                {t('cases.wizard.done.code')}
                <Badge tone="warning">{t('cases.wizard.done.once')}</Badge>
              </dt>
              <dd className="mt-1 flex items-center justify-between gap-2">
                {code ? (
                  <>
                    <span className="ltr-value font-mono text-xl font-semibold tracking-wider text-foreground" data-tracking-code>
                      {code}
                    </span>
                    <CopyButton value={code} label={t('cases.wizard.done.copyCode')} />
                  </>
                ) : (
                  <span className="text-sm text-muted-foreground">{t('cases.wizard.done.noCode')}</span>
                )}
              </dd>
            </div>
          </dl>
          {code ? <p className="text-sm text-muted-foreground">{t('cases.wizard.done.codeHint')}</p> : null}
          <div className="space-y-2">
            <Button asChild variant="accent" size="lg" className="w-full sm:w-auto sm:min-w-64">
              <Link href={`/requests/${result.id}`}>{t('cases.wizard.openCase')}</Link>
            </Button>
            <div className="flex flex-col justify-center gap-2 sm:flex-row sm:flex-wrap">
              {code ? (
                <Button variant="outline" onClick={() => window.print()}>
                  <Printer aria-hidden="true" />
                  {t('cases.wizard.done.print')}
                </Button>
              ) : null}
              <Button variant="outline" onClick={onNewForCustomer}>
                <FilePlus2 aria-hidden="true" />
                {t('cases.wizard.done.another')}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-4">
          <CardTitle>{t('cases.next.title')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 border-t">
          <p className="text-base font-medium text-foreground">{pick(result.nextStep.text.en, result.nextStep.text.ar)}</p>
          <ul className="space-y-2 text-base text-foreground/90">
            {[
              result.assignee ? t('cases.wizard.done.nextAssigned', { name: result.assignee.name }) : t('cases.wizard.done.nextUnassigned'),
              t(`cases.paymentPolicy.${result.service.paymentPolicy}`),
              result.targetDate ? t('cases.wizard.done.nextTarget', { date: formatDate(result.targetDate) }) : null,
            ]
              .filter(Boolean)
              .map((line) => (
                <li key={line} className="flex items-start gap-2.5">
                  <ArrowRight className="rtl-mirror mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span>{line}</span>
                </li>
              ))}
          </ul>
        </CardContent>
      </Card>

      {mounted && code
        ? createPortal(
            <div id="tracking-slip-root" dir={dir} lang={locale}>
              <style>{SLIP_CSS}</style>
              <p>{centre}</p>
              <h1>{t('cases.wizard.done.slipTitle')}</h1>
              <dl>
                <dt>{t('cases.fields.customer')}</dt>
                <dd>{result.customer.fullName}</dd>
                <dt>{t('cases.fields.service')}</dt>
                <dd>{pick(result.service.name, result.service.nameAr)}</dd>
                <dt>{t('cases.wizard.done.number')}</dt>
                <dd dir="ltr">{result.requestNo}</dd>
                <dt>{t('cases.wizard.done.code')}</dt>
                <dd className="code" dir="ltr">
                  {code}
                </dd>
              </dl>
              <p>{t('cases.wizard.done.slipText')}</p>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
