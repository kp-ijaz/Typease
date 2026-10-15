'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight } from 'lucide-react';
import { mergeCustomersSchema } from '@typease/validation';
import {
  Alert, Button, ChoiceLabel, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Form, FormError, FormField, Input, Label, RadioGroup, RadioGroupItem, Skeleton,
  StatusBadge, Stepper, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea, cn, countryName, formatPhone, useApi, useI18n, useToast, useZodForm,
} from '@typease/ui';
import { CustomerPicker } from '@/components/pickers';
import { peopleKeys } from '@/lib/keys/people';
import { LoadError, Ltr } from '../shared';
import type { CustomerOverview, MergeResult } from '../types';
import { StrengthBadge, useSignalText } from './duplicate-warning';
import { useDuplicateCheck } from './duplicates-card';

type Direction = 'keepThis' | 'keepOther';

/** What the API moves to the kept record (customers.md, "Merging"), in the order staff think about it. */
const MOVES = ['serviceRequests', 'documents', 'quotations', 'invoices', 'payments', 'appointments', 'reminderSchedules', 'supportTickets', 'notes', 'contacts', 'tagAssignments', 'consents', 'memberships', 'other'] as const;

/**
 * Merge two records of the same person. Never automatic and never suggested on a name alone:
 *  1. choose the other record and which of the two is kept, and compare them side by side;
 *  2. read what will move, type the number of the record that is retired and give a reason.
 * The result shows what the API moved and what it kept on the retired record.
 */
export function MergeCustomerDialog({ customer, open, onOpenChange, initialOtherId }: { customer: CustomerOverview; open: boolean; onOpenChange: (open: boolean) => void; initialOtherId?: string | null }) {
  const { t, has, locale, formatDate, formatMoney, formatNumber } = useI18n();
  const api = useApi();
  const router = useRouter();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const signalText = useSignalText();
  const ids = React.useId();

  const [otherId, setOtherId] = React.useState<string>(initialOtherId ?? '');
  const [direction, setDirection] = React.useState<Direction>('keepThis');
  const [step, setStep] = React.useState<0 | 1>(0);
  const [result, setResult] = React.useState<MergeResult | null>(null);

  const other = useQuery({
    queryKey: peopleKeys.customers.detail(otherId),
    queryFn: () => api.client.get<CustomerOverview>(`/customers/${otherId}`),
    enabled: open && !!otherId && otherId !== customer.id,
  });
  const duplicates = useDuplicateCheck(customer, open);
  const otherData = other.data;

  const kept = direction === 'keepThis' ? customer : otherData;
  const retired = direction === 'keepThis' ? otherData : customer;
  const match = otherId ? duplicates.data?.candidates.find((c) => c.customer.id === otherId) : undefined;

  const same = otherId === customer.id;
  const blockers: string[] = [];
  if (same) blockers.push(t('people.customer.merge.blockSame'));
  if (kept && retired && !same) {
    if (kept.status !== 'ACTIVE') blockers.push(t('people.customer.merge.blockKeptInactive', { number: kept.customerNo }));
    if (retired.status === 'MERGED' || retired.status === 'ANONYMISED') blockers.push(t('people.customer.merge.blockRetiredClosed', { number: retired.customerNo }));
  }
  const bothHaveLogins = !!kept && !!retired && kept.portalAccess.status !== 'NONE' && retired.portalAccess.status !== 'NONE';

  const form = useZodForm(mergeCustomersSchema, { defaultValues: { targetId: '', sourceId: '', confirmSourceCustomerNo: '', reason: '' } });
  const typed = form.watch('confirmSourceCustomerNo') ?? '';
  const typedMatches = !!retired && typed.trim().toLowerCase() === retired.customerNo.toLowerCase();

  const goToConfirm = () => {
    if (!kept || !retired) return;
    form.reset({ targetId: kept.id, sourceId: retired.id, confirmSourceCustomerNo: '', reason: '' });
    setStep(1);
  };

  const merge = async (values: { targetId: string; sourceId: string; confirmSourceCustomerNo: string; reason: string }) => {
    const merged = await api.client.post<MergeResult>('/customers/merge', values);
    setResult(merged);
    toasts.success(t('people.customer.merge.done'), t('people.customer.merge.doneText', { source: merged.source.customerNo, target: merged.target.customerNo }));
    // The merge moves rows of many modules: refresh everything this page and its neighbours show.
    await queryClient.invalidateQueries();
  };

  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next && result && result.target.id !== customer.id) router.push(`/customers/${result.target.id}`);
  };

  const label = (key: string, group: 'items' | 'fields') => (has(`people.customer.merge.${group}.${key}`) ? t(`people.customer.merge.${group}.${key}`) : key);
  const counts = (record: Record<string, number>) => Object.entries(record).filter(([, n]) => n > 0);

  // ---- side-by-side comparison
  const rows: Array<{ label: string; value: (c: CustomerOverview) => React.ReactNode; raw: (c: CustomerOverview) => string }> = [
    { label: t('people.customer.fields.customerNo'), value: (c) => <Ltr>{c.customerNo}</Ltr>, raw: (c) => c.customerNo },
    { label: t('customers.form.fullName'), value: (c) => c.fullName, raw: (c) => c.fullName.toLowerCase() },
    { label: t('customers.form.fullNameAr'), value: (c) => (c.fullNameAr ? <span lang="ar">{c.fullNameAr}</span> : null), raw: (c) => c.fullNameAr ?? '' },
    { label: t('customers.form.phone'), value: (c) => (c.phone ? <Ltr>{formatPhone(c.phone)}</Ltr> : null), raw: (c) => c.phone ?? '' },
    { label: t('customers.form.email'), value: (c) => (c.email ? <Ltr className="break-all">{c.email}</Ltr> : null), raw: (c) => c.email ?? '' },
    { label: t('customers.form.nationality'), value: (c) => countryName(c.nationality, locale) || null, raw: (c) => c.nationality ?? '' },
    { label: t('people.customer.fields.dateOfBirth'), value: (c) => (c.dateOfBirth ? formatDate(c.dateOfBirth) : null), raw: (c) => c.dateOfBirth ?? '' },
    { label: t('people.customer.fields.emiratesId'), value: (c) => (c.emiratesIdMasked ? <Ltr>{c.emiratesIdMasked}</Ltr> : null), raw: (c) => c.emiratesIdMasked ?? '' },
    { label: t('people.customer.fields.passportNo'), value: (c) => (c.passportNoMasked ? <Ltr>{c.passportNoMasked}</Ltr> : null), raw: (c) => c.passportNoMasked ?? '' },
    { label: t('people.customer.fields.company'), value: (c) => c.corporateAccount?.companyName ?? null, raw: (c) => c.corporateAccountId ?? '' },
    { label: t('customers.columns.portal'), value: (c) => <StatusBadge kind="portalAccess" status={c.portalAccess.status} />, raw: (c) => c.portalAccess.status },
    { label: t('people.customer.merge.requests'), value: (c) => formatNumber(c.counters.totalRequests), raw: () => '' },
    { label: t('people.customer.merge.documents'), value: (c) => formatNumber(c.counters.documents), raw: () => '' },
    { label: t('people.customer.merge.unpaid'), value: (c) => (c.counters.unpaidInvoices ? `${formatNumber(c.counters.unpaidInvoices)} · ${formatMoney(c.counters.unpaidInvoicesBalance, c.counters.currency)}` : formatNumber(0)), raw: () => '' },
    { label: t('customers.columns.created'), value: (c) => formatDate(c.createdAt), raw: () => '' },
  ];

  const dash = <span className="text-muted-foreground">–</span>;

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>{t('people.customer.merge.title')}</DialogTitle>
          <DialogDescription>{t('people.customer.merge.description')}</DialogDescription>
        </DialogHeader>

        {result ? (
          <>
            <DialogBody className="space-y-5">
              <Alert tone="success" live title={t('people.customer.merge.done')}>
                {t('people.customer.merge.doneText', { source: result.source.customerNo, target: result.target.customerNo })}
              </Alert>
              <div className="grid gap-5 sm:grid-cols-2">
                <div>
                  <h3 className="text-md font-semibold text-foreground">{t('people.customer.merge.movedTitle')}</h3>
                  {counts(result.moved).length ? (
                    <ul className="mt-2 space-y-1 text-base">
                      {counts(result.moved).map(([key, n]) => (
                        <li key={key} className="flex justify-between gap-4 border-b py-1 last:border-0">
                          <span>{label(key, 'items')}</span>
                          <span className="tabular font-medium">{formatNumber(n)}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-2 text-base text-muted-foreground">{t('people.customer.merge.movedNone')}</p>
                  )}
                </div>
                <div className="space-y-5">
                  <div>
                    <h3 className="text-md font-semibold text-foreground">{t('people.customer.merge.retainedTitle', { number: result.source.customerNo })}</h3>
                    {counts(result.retainedOnSource).length ? (
                      <>
                        <ul className="mt-2 space-y-1 text-base">
                          {counts(result.retainedOnSource).map(([key, n]) => (
                            <li key={key} className="flex justify-between gap-4 border-b py-1 last:border-0">
                              <span>{label(key, 'items')}</span>
                              <span className="tabular font-medium">{formatNumber(n)}</span>
                            </li>
                          ))}
                        </ul>
                        <p className="mt-2 text-sm text-muted-foreground">{t('people.customer.merge.retainedText')}</p>
                      </>
                    ) : (
                      <p className="mt-2 text-base text-muted-foreground">{t('people.customer.merge.retainedNone')}</p>
                    )}
                  </div>
                  {result.filledFields.length ? (
                    <div>
                      <h3 className="text-md font-semibold text-foreground">{t('people.customer.merge.filledTitle')}</h3>
                      <p className="mt-1 text-base text-foreground/90">{result.filledFields.map((f) => label(f, 'fields')).join(', ')}</p>
                    </div>
                  ) : null}
                </div>
              </div>
            </DialogBody>
            <DialogFooter>
              <Button onClick={() => close(false)}>{result.target.id === customer.id ? t('common.done') : t('people.customer.merge.openKept', { number: result.target.customerNo })}</Button>
            </DialogFooter>
          </>
        ) : step === 0 ? (
          <>
            <DialogBody className="space-y-5">
              <Stepper steps={[{ id: 'compare', label: t('people.customer.merge.stepCompare') }, { id: 'confirm', label: t('people.customer.merge.stepConfirm') }]} current={0} />

              <div className="space-y-1.5 sm:max-w-md">
                <Label htmlFor={`${ids}-other`}>{t('people.customer.merge.other')}</Label>
                <CustomerPicker id={`${ids}-other`} value={otherId} selectedLabel={otherData?.fullName ?? t('common.loading')} onChange={(id) => setOtherId(id)} />
                <p className="text-sm text-muted-foreground">{t('people.customer.merge.otherHint', { name: customer.fullName, number: customer.customerNo })}</p>
              </div>

              {same ? <Alert tone="danger">{t('people.customer.merge.blockSame')}</Alert> : null}

              {otherId && !same ? (
                other.isPending ? (
                  <div className="space-y-2" role="status" aria-label={t('common.loading')}>
                    <Skeleton className="h-10" />
                    <Skeleton className="h-48" />
                  </div>
                ) : other.isError || !otherData ? (
                  <LoadError error={other.error} onRetry={() => void other.refetch()} />
                ) : (
                  <>
                    {/* How sure are we that these are the same person? */}
                    {match ? (
                      <Alert tone={match.strength === 'STRONG' ? 'info' : 'warning'} title={<span className="flex flex-wrap items-center gap-2">{t('people.customer.merge.signalsTitle')} <StrengthBadge strength={match.strength} /></span>}>
                        {signalText(match.signals)}
                        {match.strength === 'WEAK' ? <span className="mt-1 block">{t('people.customer.duplicates.weakHint')}</span> : null}
                      </Alert>
                    ) : duplicates.isSuccess ? (
                      <Alert tone="warning" title={t('people.customer.merge.noSignalsTitle')}>
                        {t('people.customer.merge.noSignalsText')}
                      </Alert>
                    ) : null}

                    <fieldset className="space-y-2">
                      <legend className="text-sm font-medium text-foreground">{t('people.customer.merge.direction')}</legend>
                      <RadioGroup value={direction} onValueChange={(v) => setDirection(v as Direction)} aria-label={t('people.customer.merge.direction')} className="grid gap-3 sm:grid-cols-2">
                        {(['keepThis', 'keepOther'] as const).map((option) => {
                          const keep = option === 'keepThis' ? customer : otherData;
                          const retire = option === 'keepThis' ? otherData : customer;
                          return (
                            <div key={option} className={cn('rounded-lg border p-3', direction === option && 'border-secondary bg-secondary-soft/40')}>
                              <ChoiceLabel
                                htmlFor={`${ids}-${option}`}
                                control={<RadioGroupItem id={`${ids}-${option}`} value={option} />}
                                label={t('people.customer.merge.keep', { name: keep.fullName, number: keep.customerNo })}
                                description={t('people.customer.merge.retire', { name: retire.fullName, number: retire.customerNo })}
                              />
                            </div>
                          );
                        })}
                      </RadioGroup>
                    </fieldset>

                    {kept && retired ? (
                      <div className="rounded-lg border">
                        <Table>
                          <caption className="sr-only">{t('people.customer.merge.compareCaption')}</caption>
                          <TableHeader>
                            <TableRow className="hover:bg-transparent">
                              <TableHead className="w-1/4">{t('people.customer.merge.detail')}</TableHead>
                              <TableHead>
                                {t('people.customer.merge.keptColumn')}
                                <span className="tabular ms-1.5 font-normal">{kept.customerNo}</span>
                              </TableHead>
                              <TableHead>
                                {t('people.customer.merge.retiredColumn')}
                                <span className="tabular ms-1.5 font-normal">{retired.customerNo}</span>
                              </TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {rows.map((row) => {
                              const a = row.raw(kept);
                              const b = row.raw(retired);
                              const differs = !!a && !!b && a !== b && row.label !== t('people.customer.fields.customerNo');
                              return (
                                <TableRow key={row.label} className={cn('hover:bg-transparent', differs && 'bg-warning-soft/50 hover:bg-warning-soft/50')}>
                                  <TableCell className="py-2 text-sm text-muted-foreground">
                                    {row.label}
                                    {differs ? <span className="block text-xs font-medium text-warning-text">{t('people.customer.merge.differs')}</span> : null}
                                  </TableCell>
                                  <TableCell className="py-2">{row.value(kept) ?? dash}</TableCell>
                                  <TableCell className="py-2">{row.value(retired) ?? dash}</TableCell>
                                </TableRow>
                              );
                            })}
                          </TableBody>
                        </Table>
                      </div>
                    ) : null}

                    {blockers.map((b) => (
                      <Alert key={b} tone="danger">
                        {b}
                      </Alert>
                    ))}
                    {bothHaveLogins ? <Alert tone="warning">{t('people.customer.merge.warnLogins')}</Alert> : null}
                  </>
                )
              ) : null}
            </DialogBody>
            <DialogFooter>
              <Button variant="outline" onClick={() => close(false)}>
                {t('common.cancel')}
              </Button>
              <Button onClick={goToConfirm} disabled={!kept || !retired || same || blockers.length > 0}>
                {t('common.continue')}
                <ArrowRight className="rtl-mirror" aria-hidden="true" />
              </Button>
            </DialogFooter>
          </>
        ) : kept && retired ? (
          <Form form={form} onSubmit={merge} className="flex min-h-0 flex-1 flex-col space-y-0">
            <DialogBody className="space-y-5">
              <Stepper steps={[{ id: 'compare', label: t('people.customer.merge.stepCompare') }, { id: 'confirm', label: t('people.customer.merge.stepConfirm') }]} current={1} onStepClick={() => setStep(0)} />

              <div className="grid gap-3 sm:grid-cols-[1fr_auto_1fr] sm:items-center">
                <div className="rounded-lg border p-3">
                  <p className="text-xs font-semibold text-muted-foreground">{t('people.customer.merge.retiredColumn')}</p>
                  <p className="text-base font-medium text-foreground">{retired.fullName}</p>
                  <p className="tabular text-sm text-muted-foreground">{retired.customerNo}</p>
                </div>
                <ArrowRight className="rtl-mirror mx-auto size-5 rotate-90 text-muted-foreground sm:rotate-0" aria-hidden="true" />
                <div className="rounded-lg border border-success/40 bg-success-soft/50 p-3">
                  <p className="text-xs font-semibold text-success-text">{t('people.customer.merge.keptColumn')}</p>
                  <p className="text-base font-medium text-foreground">{kept.fullName}</p>
                  <p className="tabular text-sm text-muted-foreground">{kept.customerNo}</p>
                </div>
              </div>

              <div className="grid gap-5 sm:grid-cols-2">
                <div>
                  <h3 className="text-md font-semibold text-foreground">{t('people.customer.merge.willMoveTitle', { number: kept.customerNo })}</h3>
                  <ul className="mt-2 list-disc space-y-0.5 ps-5 text-base text-foreground/90">
                    {MOVES.map((key) => (
                      <li key={key}>{t(`people.customer.merge.moves.${key}`)}</li>
                    ))}
                  </ul>
                </div>
                <div className="space-y-4">
                  <div>
                    <h3 className="text-md font-semibold text-foreground">{t('people.customer.merge.willStayTitle', { number: retired.customerNo })}</h3>
                    <p className="mt-2 text-base text-foreground/90">{t('people.customer.merge.willStayText')}</p>
                  </div>
                  <div>
                    <h3 className="text-md font-semibold text-foreground">{t('people.customer.merge.alsoTitle')}</h3>
                    <ul className="mt-2 list-disc space-y-0.5 ps-5 text-base text-foreground/90">
                      <li>{t('people.customer.merge.alsoFill')}</li>
                      <li>{t('people.customer.merge.alsoReadOnly', { number: retired.customerNo })}</li>
                    </ul>
                  </div>
                </div>
              </div>

              <Alert tone="warning" title={t('people.customer.merge.irreversibleTitle')}>
                {t('people.customer.merge.irreversibleText')}
              </Alert>

              <div className="grid gap-5 sm:grid-cols-2">
                <FormField name="confirmSourceCustomerNo" label={t('people.customer.merge.typeNumber', { number: retired.customerNo })} required hint={t('people.customer.merge.typeNumberHint')}>
                  {(field) => <Input {...field} autoComplete="off" spellCheck={false} dir="ltr" className="tabular" aria-invalid={field['aria-invalid'] || (typed.length > 0 && !typedMatches)} />}
                </FormField>
                <FormField name="reason" label={t('people.customer.merge.reason')} required hint={t('people.customer.merge.reasonHint')}>
                  {(field) => <Textarea {...field} rows={2} dir="auto" />}
                </FormField>
              </div>
              <FormError />
            </DialogBody>
            <DialogFooter>
              <Button variant="outline" onClick={() => setStep(0)} disabled={form.formState.isSubmitting}>
                {t('common.back')}
              </Button>
              <Button type="submit" variant="destructive" disabled={!typedMatches} loading={form.formState.isSubmitting} loadingText={t('common.loading')}>
                {t('people.customer.merge.submit')}
              </Button>
            </DialogFooter>
          </Form>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
