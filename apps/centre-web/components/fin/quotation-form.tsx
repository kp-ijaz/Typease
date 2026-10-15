'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { isApiError } from '@typease/api-client';
import { createQuotationSchema, isoDate, quotationFromRequestSchema } from '@typease/validation';
import {
  Alert, Button, Card, CardContent, CardHeader, CardTitle, DatePicker, DescriptionList, Form, FormActions, FormError, FormField, MoneyInput, PageHeader, RequirePermission, StatusBadge,
  Textarea, addDays, useI18n, useSession, useToast, useZodForm,
} from '@typease/ui';
import { useBranch, useBranches } from '@/components/branch';
import { CustomerPicker } from '@/components/pickers';
import { finKeys } from '@/lib/keys/fin';
import { useFinApi } from './api';
import { isoToZonedDate, zonedToIso } from './dates';
import { LineEditor, LinesPreview, emptyLine, linesToApi, linesToForm, useDefaultTaxRates, useLinesPreview, type LineFormValue } from './line-editor';
import { DetailSkeleton, FieldSelect, ImmutableNote, LoadError, TextLink } from './shared';
import type { RequestBrief } from './types';

interface Props {
  quotationId?: string;
  requestId?: string;
  customerId?: string;
}

/**
 * Create a quotation (from a request: the API builds the lines from the service price; or
 * free-form) or edit a draft. Everything is saved as a draft and reviewed on the quotation
 * page, where the API's totals are shown, before it is sent to the customer.
 */
export function QuotationForm(props: Props) {
  return (
    <RequirePermission anyOf={['quotation.manage']}>
      <QuotationFormInner {...props} />
    </RequirePermission>
  );
}

function QuotationFormInner({ quotationId, requestId, customerId }: Props) {
  const { t } = useI18n();
  const api = useFinApi();
  const session = useSession();
  const [ownLines, setOwnLines] = React.useState<'no' | 'chosen' | 'no-price'>('no');

  const forRequest = !quotationId && !!requestId && session.hasAnyPermission(['request.read.all', 'request.read.assigned']);
  const request = useQuery({ queryKey: finKeys.requestBrief(requestId ?? ''), queryFn: ({ signal }) => api.requestBrief(requestId as string, signal), enabled: forRequest });

  const header = (
    <PageHeader
      title={quotationId ? t('fin.quotations.form.editTitle') : t('fin.quotations.form.newTitle')}
      description={quotationId ? t('fin.quotations.form.editDescription') : forRequest && ownLines === 'no' ? t('fin.quotations.form.fromRequestDescription') : t('fin.quotations.form.description')}
      breadcrumbs={[{ label: t('fin.quotations.title'), href: '/quotations' }]}
    />
  );

  if (forRequest) {
    if (request.isPending) return <DetailSkeleton />;
    if (request.isError) {
      return (
        <>
          {header}
          <LoadError error={request.error} onRetry={() => void request.refetch()} />
        </>
      );
    }
    if (ownLines === 'no') {
      return (
        <>
          {header}
          <FromRequestForm request={request.data} onOwnLines={(why) => setOwnLines(why)} />
        </>
      );
    }
  }

  return (
    <>
      {header}
      {ownLines === 'no-price' ? (
        <Alert tone="warning" className="mb-6" title={t('fin.quotations.form.noPriceTitle')}>
          {t('fin.quotations.form.noPriceText')}
        </Alert>
      ) : null}
      <LinesForm quotationId={quotationId} request={forRequest ? request.data : undefined} customerId={customerId} />
    </>
  );
}

// ---------------------------------------------------------------- from a request

const fromRequestSchema = quotationFromRequestSchema.pick({ notes: true, serviceFeeDiscount: true, discountReason: true }).extend({ validUntil: isoDate.optional() });

function RequestSummary({ request }: { request: RequestBrief }) {
  const { t, pick } = useI18n();
  return (
    <DescriptionList
      columns={3}
      items={[
        {
          label: t('fin.common.request'),
          value: (
            <>
              <TextLink href={`/requests/${request.id}`} className="tabular">
                {request.requestNo}
              </TextLink>
              <span className="ms-2 inline-flex align-middle">
                <StatusBadge kind="request" status={request.status} label={request.statusLabel} />
              </span>
            </>
          ),
        },
        { label: t('fin.common.customer'), value: request.customer ? <TextLink href={`/customers/${request.customer.id}`}>{request.customer.fullName}</TextLink> : null },
        { label: t('fin.quotations.form.service'), value: request.service ? pick(request.service.name, request.service.nameAr) : null },
        { label: t('fin.common.branch'), value: request.branch ? pick(request.branch.name, request.branch.nameAr) : null },
        ...(request.corporateAccount ? [{ label: t('fin.common.company'), value: request.corporateAccount.companyName }] : []),
      ]}
    />
  );
}

function ValidUntilField() {
  const { t, today } = useI18n();
  const api = useFinApi();
  const tenant = useQuery({ queryKey: finKeys.tenant, queryFn: ({ signal }) => api.tenant(signal), staleTime: 5 * 60_000 });
  const days = tenant.data?.settings.quotationValidityDays ?? 14;
  return (
    <FormField name="validUntil" label={t('fin.quotations.form.validUntil')} optional hint={t('fin.quotations.form.validUntilHint', { days })}>
      {(field) => <DatePicker {...field} value={field.value} onChange={field.onChange} min={addDays(today(), 1)} />}
    </FormField>
  );
}

function FromRequestForm({ request, onOwnLines }: { request: RequestBrief; onOwnLines: (why: 'chosen' | 'no-price') => void }) {
  const { t, timeZone } = useI18n();
  const api = useFinApi();
  const router = useRouter();
  const toasts = useToast();
  const session = useSession();
  const queryClient = useQueryClient();
  const form = useZodForm(fromRequestSchema, { defaultValues: { serviceFeeDiscount: '', discountReason: '', validUntil: '', notes: '' } });
  const discount = form.watch('serviceFeeDiscount') as string;
  const hasDiscount = Number(discount) > 0;
  const currency = session.tenant?.currency ?? 'AED';

  return (
    <Form
      form={form}
      className="space-y-6"
      onSubmit={async (values) => {
        const withDiscount = Number(values.serviceFeeDiscount ?? 0) > 0;
        if (withDiscount && !values.discountReason) {
          form.setError('discountReason', { type: 'required', message: t('fin.quotations.form.discountReasonRequired') });
          return;
        }
        try {
          const quotation = await api.quotations.fromRequest(request.id, {
            ...(withDiscount ? { serviceFeeDiscount: values.serviceFeeDiscount, discountReason: values.discountReason } : {}),
            ...(values.validUntil ? { validUntil: zonedToIso(values.validUntil, '23:59:59', timeZone) } : {}),
            notes: values.notes ?? null,
          });
          toasts.success(t('fin.quotations.form.created', { number: quotation.quotationNo }), t('fin.quotations.form.createdNext'));
          await queryClient.invalidateQueries({ queryKey: finKeys.quotations.all });
          router.push(`/quotations/${quotation.id}`);
        } catch (error) {
          // The service has no price for this branch: the lines have to be written by hand.
          if (isApiError(error) && error.code === 'NO_PRICE') {
            onOwnLines('no-price');
            return;
          }
          throw error;
        }
      }}
    >
      <Card>
        <CardHeader className="pb-0">
          <CardTitle>{t('fin.quotations.form.forRequest')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <RequestSummary request={request} />
          <Alert tone="info">{t('fin.quotations.form.fromRequestNote')}</Alert>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-0">
          <CardTitle>{t('fin.quotations.form.options')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-5 sm:grid-cols-2">
            <FormField name="serviceFeeDiscount" label={t('fin.quotations.form.serviceFeeDiscount')} optional hint={t('fin.quotations.form.serviceFeeDiscountHint')}>
              {(field) => <MoneyInput {...field} currency={currency} />}
            </FormField>
            <ValidUntilField />
          </div>
          {hasDiscount ? (
            <>
              <FormField name="discountReason" label={t('fin.quotations.form.discountReason')} required hint={t('fin.quotations.form.discountReasonHint')}>
                {(field) => <Textarea {...field} rows={2} maxLength={500} />}
              </FormField>
              <Alert tone="warning">{t('fin.quotations.discount.needsApproval')}</Alert>
            </>
          ) : null}
          <FormField name="notes" label={t('fin.quotations.form.notes')} optional hint={t('fin.quotations.form.notesHint')}>
            {(field) => <Textarea {...field} rows={3} maxLength={2000} />}
          </FormField>
        </CardContent>
      </Card>

      <FormError />
      <FormActions className="sm:items-center">
        <Button variant="link" className="sm:me-auto" onClick={() => onOwnLines('chosen')}>
          {t('fin.quotations.form.writeOwnLines')}
        </Button>
        <Button asChild variant="outline">
          <Link href={`/requests/${request.id}`}>{t('common.cancel')}</Link>
        </Button>
        <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
          {t('fin.quotations.form.createFromRequest')}
        </Button>
      </FormActions>
    </Form>
  );
}

// ---------------------------------------------------------------- free-form / edit

const linesSchema = createQuotationSchema.pick({ customerId: true, branchId: true, notes: true, discountReason: true, items: true }).extend({ validUntil: isoDate.optional() });

function LinesForm({ quotationId, request, customerId }: { quotationId?: string; request?: RequestBrief; customerId?: string }) {
  const { t, pick, timeZone } = useI18n();
  const api = useFinApi();
  const router = useRouter();
  const toasts = useToast();
  const session = useSession();
  const queryClient = useQueryClient();
  const { branchId: currentBranch } = useBranch();
  const branches = useBranches();
  const { rates, centreRate } = useDefaultTaxRates();
  const editing = !!quotationId;

  const quotation = useQuery({ queryKey: finKeys.quotations.detail(quotationId ?? ''), queryFn: ({ signal }) => api.quotations.get(quotationId as string, signal), enabled: editing });
  const customer = useQuery({
    queryKey: finKeys.customerBrief(customerId ?? ''),
    queryFn: ({ signal }) => api.customerBrief(customerId as string, signal),
    enabled: !editing && !request && !!customerId && session.hasPermission('customer.read'),
  });

  const form = useZodForm(linesSchema, {
    defaultValues: { customerId: request?.customer?.id ?? customerId ?? '', branchId: request?.branch?.id ?? '', validUntil: '', notes: '', discountReason: '', items: [emptyLine()] as LineFormValue[] },
  });
  const [customerName, setCustomerName] = React.useState<string | null>(request?.customer?.fullName ?? null);

  const filled = React.useRef(false);
  React.useEffect(() => {
    if (filled.current) return;
    if (editing && quotation.data) {
      filled.current = true;
      const q = quotation.data;
      form.reset({ customerId: q.customerId, branchId: q.branchId, validUntil: isoToZonedDate(q.validUntil, timeZone), notes: q.notes ?? '', discountReason: q.discountReason ?? '', items: linesToForm(q.quotationItems) });
      setCustomerName(q.customer.fullName);
    } else if (customer.data) {
      filled.current = true;
      setCustomerName(customer.data.fullName);
    }
  }, [editing, quotation.data, customer.data, form, timeZone]);

  React.useEffect(() => {
    if (editing || request || form.getValues('branchId') || !branches.data?.length) return;
    const fallback = branches.data.find((b) => b.id === currentBranch) ?? (branches.data.length === 1 ? branches.data[0] : branches.data.find((b) => b.isHeadOffice));
    if (fallback) form.setValue('branchId', fallback.id);
  }, [editing, request, branches.data, currentBranch, form]);

  const currency = quotation.data?.currency ?? session.tenant?.currency ?? 'AED';
  const backHref = editing ? `/quotations/${quotationId}` : request ? `/requests/${request.id}` : '/quotations';

  if (editing && quotation.isPending) return <DetailSkeleton />;
  if (editing && quotation.isError) return <LoadError error={quotation.error} onRetry={() => void quotation.refetch()} />;
  if (editing && quotation.data && quotation.data.status !== 'DRAFT') {
    return (
      <Card>
        <CardContent className="space-y-4">
          <ImmutableNote>{t('fin.quotations.immutable')}</ImmutableNote>
          <Button asChild variant="outline">
            <Link href={backHref}>{t('fin.quotations.form.backToQuotation')}</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  const approvedBefore = editing && quotation.data?.discountApproval === 'APPROVED';

  return (
    <Form
      form={form}
      className="space-y-6"
      onSubmit={async (values) => {
        const items = linesToApi(values.items as Parameters<typeof linesToApi>[0]);
        const withDiscount = items.some((item) => Number(item.discountAmount) > 0);
        if (withDiscount && !values.discountReason) {
          form.setError('discountReason', { type: 'required', message: t('fin.quotations.form.discountReasonRequired') });
          form.setFocus('discountReason');
          return;
        }
        const shared = {
          ...(values.validUntil ? { validUntil: zonedToIso(values.validUntil, '23:59:59', timeZone) } : {}),
          notes: values.notes ?? null,
          discountReason: withDiscount ? values.discountReason : null,
          items,
        };
        const saved = editing
          ? await api.quotations.update(quotationId as string, shared)
          : await api.quotations.create({
              customerId: values.customerId,
              ...(values.branchId ? { branchId: values.branchId } : {}),
              ...(request ? { requestId: request.id, ...(request.corporateAccount ? { corporateAccountId: request.corporateAccount.id } : {}) } : {}),
              ...shared,
            });
        toasts.success(editing ? t('fin.quotations.form.updated', { number: saved.quotationNo }) : t('fin.quotations.form.created', { number: saved.quotationNo }), t('fin.quotations.form.createdNext'));
        await queryClient.invalidateQueries({ queryKey: finKeys.quotations.all });
        router.push(`/quotations/${saved.id}`);
      }}
    >
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader className="pb-0">
              <CardTitle>{t('fin.quotations.form.who')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              {request ? <RequestSummary request={request} /> : null}
              <div className="grid gap-5 sm:grid-cols-2">
                {!request ? (
                  <FormField name="customerId" label={t('fin.common.customer')} required>
                    {(field) => (
                      <CustomerPicker
                        {...field}
                        value={field.value}
                        disabled={editing}
                        selectedLabel={customerName}
                        onChange={(id, picked) => {
                          field.onChange(id);
                          setCustomerName(picked?.fullName ?? null);
                        }}
                      />
                    )}
                  </FormField>
                ) : null}
                {!request && branches.data && branches.data.length > 1 ? (
                  <FormField name="branchId" label={t('fin.common.branch')} required>
                    {(field) => <FieldSelect {...field} disabled={editing} onValueChange={field.onChange} placeholder={t('common.selectPlaceholder')} options={branches.data.map((b) => ({ value: b.id, label: pick(b.name, b.nameAr) }))} />}
                  </FormField>
                ) : null}
                <ValidUntilField />
              </div>
            </CardContent>
          </Card>

          <section aria-labelledby="quotation-lines" className="space-y-4">
            <div>
              <h2 id="quotation-lines" className="text-md font-semibold text-foreground">
                {t('fin.lines.title')}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">{t('fin.lines.help')}</p>
            </div>
            <LineEditor currency={currency} rates={rates} />
          </section>

          <DiscountReason rates={rates} approvedBefore={!!approvedBefore} />

          <Card>
            <CardContent>
              <FormField name="notes" label={t('fin.quotations.form.notes')} optional hint={t('fin.quotations.form.notesHint')}>
                {(field) => <Textarea {...field} rows={3} maxLength={2000} />}
              </FormField>
            </CardContent>
          </Card>
        </div>

        <Card className="lg:sticky lg:top-20">
          <CardHeader className="pb-0">
            <CardTitle>{t('fin.lines.previewTitle')}</CardTitle>
          </CardHeader>
          <CardContent>
            <LinesPreview currency={currency} rates={rates} centreRate={centreRate} />
          </CardContent>
        </Card>
      </div>

      <FormError />
      <FormActions>
        <Button asChild variant="outline">
          <Link href={backHref}>{t('common.cancel')}</Link>
        </Button>
        <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
          {editing ? t('fin.quotations.form.saveChanges') : t('fin.quotations.form.saveDraft')}
        </Button>
      </FormActions>
    </Form>
  );
}

/** The reason field appears as soon as a line carries a discount, with what will happen to the quotation. */
function DiscountReason({ rates, approvedBefore }: { rates: Parameters<typeof useLinesPreview>[0]; approvedBefore: boolean }) {
  const { t } = useI18n();
  const totals = useLinesPreview(rates);
  if (!totals.hasDiscount) return null;
  return (
    <Card>
      <CardContent className="space-y-4">
        <FormField name="discountReason" label={t('fin.quotations.form.discountReason')} required hint={t('fin.quotations.form.discountReasonHint')}>
          {(field) => <Textarea {...field} rows={2} maxLength={500} />}
        </FormField>
        <Alert tone="warning">{approvedBefore ? t('fin.quotations.discount.restarts') : t('fin.quotations.discount.needsApproval')}</Alert>
      </CardContent>
    </Card>
  );
}
