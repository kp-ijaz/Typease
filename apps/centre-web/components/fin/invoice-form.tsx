'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createInvoiceSchema } from '@typease/validation';
import {
  Alert, Button, Card, CardContent, CardHeader, CardTitle, Checkbox, ChoiceLabel, Form, FormActions, FormError, FormField, PageHeader, RequirePermission, Textarea, useI18n, useSession,
  useToast, useZodForm,
} from '@typease/ui';
import { useBranch, useBranches } from '@/components/branch';
import { CustomerPicker } from '@/components/pickers';
import { finKeys } from '@/lib/keys/fin';
import { useFinApi } from './api';
import { LineEditor, LinesPreview, emptyLine, linesToApi, linesToForm, useDefaultTaxRates, useLinesPreview, type LineFormValue } from './line-editor';
import { DetailSkeleton, FieldSelect, ImmutableNote, LoadError } from './shared';

const schema = createInvoiceSchema.pick({ customerId: true, branchId: true, notes: true, items: true });

interface Props {
  /** Edit this draft ... */
  invoiceId?: string;
  /** ... or start a new one, optionally for a customer / request (links from other pages). */
  customerId?: string;
  requestId?: string;
}

/** Create a draft invoice or edit its lines. Issuing happens on the invoice page, after the API has calculated the totals. */
export function InvoiceForm(props: Props) {
  return (
    <RequirePermission anyOf={['invoice.manage']}>
      <InvoiceFormInner {...props} />
    </RequirePermission>
  );
}

function InvoiceFormInner({ invoiceId, customerId, requestId }: Props) {
  const { t, pick } = useI18n();
  const api = useFinApi();
  const router = useRouter();
  const toasts = useToast();
  const session = useSession();
  const queryClient = useQueryClient();
  const { branchId: currentBranch } = useBranch();
  const branches = useBranches();
  const { rates, centreRate } = useDefaultTaxRates();
  const editing = !!invoiceId;

  const invoice = useQuery({ queryKey: finKeys.invoices.detail(invoiceId ?? ''), queryFn: ({ signal }) => api.invoices.get(invoiceId as string, signal), enabled: editing });
  const request = useQuery({
    queryKey: finKeys.requestBrief(requestId ?? ''),
    queryFn: ({ signal }) => api.requestBrief(requestId as string, signal),
    enabled: !editing && !!requestId && session.hasAnyPermission(['request.read.all', 'request.read.assigned']),
  });
  const customer = useQuery({
    queryKey: finKeys.customerBrief(customerId ?? ''),
    queryFn: ({ signal }) => api.customerBrief(customerId as string, signal),
    enabled: !editing && !!customerId && !requestId && session.hasPermission('customer.read'),
  });

  const form = useZodForm(schema, { defaultValues: { customerId: customerId ?? '', branchId: '', notes: '', items: [emptyLine()] as LineFormValue[] } });
  const [customerName, setCustomerName] = React.useState<string | null>(null);
  const [company, setCompany] = React.useState<{ id: string; name: string | null } | null>(null);
  const [billCompany, setBillCompany] = React.useState(true);
  const billId = React.useId();

  // Prefill once from the record the page was opened for.
  const filled = React.useRef(false);
  React.useEffect(() => {
    if (filled.current) return;
    if (editing && invoice.data) {
      filled.current = true;
      form.reset({ customerId: invoice.data.customerId, branchId: invoice.data.branchId, notes: invoice.data.notes ?? '', items: linesToForm(invoice.data.invoiceItems) });
      setCustomerName(invoice.data.customer.fullName);
    } else if (!editing && request.data) {
      filled.current = true;
      if (request.data.customer) {
        form.setValue('customerId', request.data.customer.id);
        setCustomerName(request.data.customer.fullName);
      }
      if (request.data.branch) form.setValue('branchId', request.data.branch.id);
      if (request.data.corporateAccount) setCompany({ id: request.data.corporateAccount.id, name: request.data.corporateAccount.companyName });
    } else if (!editing && customer.data) {
      filled.current = true;
      setCustomerName(customer.data.fullName);
      if (customer.data.corporateAccountId) setCompany({ id: customer.data.corporateAccountId, name: null });
    }
  }, [editing, invoice.data, request.data, customer.data, form]);

  // The branch the person works in is the default for a new invoice.
  React.useEffect(() => {
    if (editing || requestId || form.getValues('branchId') || !branches.data?.length) return;
    const fallback = branches.data.find((b) => b.id === currentBranch) ?? (branches.data.length === 1 ? branches.data[0] : branches.data.find((b) => b.isHeadOffice));
    if (fallback) form.setValue('branchId', fallback.id);
  }, [editing, requestId, branches.data, currentBranch, form]);

  const currency = invoice.data?.currency ?? session.tenant?.currency ?? 'AED';
  const backHref = editing ? `/invoices/${invoiceId}` : '/invoices';

  if (editing && invoice.isPending) return <DetailSkeleton />;
  if (editing && invoice.isError) return <LoadError error={invoice.error} onRetry={() => void invoice.refetch()} />;

  const header = (
    <PageHeader
      title={editing ? t('fin.invoices.form.editTitle') : t('fin.invoices.form.newTitle')}
      description={t('fin.invoices.form.description')}
      breadcrumbs={[{ label: t('fin.invoices.title'), href: '/invoices' }, ...(editing && invoice.data ? [{ label: t('fin.invoices.draftNumber'), href: backHref }] : [])]}
    />
  );

  if (editing && invoice.data && invoice.data.status !== 'DRAFT') {
    return (
      <>
        {header}
        <Card>
          <CardContent className="space-y-4">
            <ImmutableNote>{t('fin.invoices.immutable')}</ImmutableNote>
            <Button asChild variant="outline">
              <Link href={backHref}>{t('fin.invoices.form.backToInvoice')}</Link>
            </Button>
          </CardContent>
        </Card>
      </>
    );
  }

  const save = async (values: { customerId: string; branchId?: string; notes?: string | null; items: Parameters<typeof linesToApi>[0] }) => {
    const items = linesToApi(values.items);
    const saved = editing
      ? await api.invoices.update(invoiceId as string, { notes: values.notes ?? null, items })
      : await api.invoices.create({
          customerId: values.customerId,
          ...(values.branchId ? { branchId: values.branchId } : {}),
          ...(requestId ? { requestId } : {}),
          ...(company && billCompany ? { corporateAccountId: company.id } : {}),
          notes: values.notes ?? null,
          items,
        });
    toasts.success(editing ? t('fin.invoices.form.updated') : t('fin.invoices.form.created'), t('fin.invoices.form.savedNext'));
    await queryClient.invalidateQueries({ queryKey: finKeys.invoices.all });
    router.push(`/invoices/${saved.id}`);
  };

  return (
    <>
      {header}
      <Form form={form} onSubmit={(values) => save(values as Parameters<typeof save>[0])} className="space-y-6">
        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            <Card>
              <CardHeader className="pb-0">
                <CardTitle>{t('fin.invoices.form.who')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-5">
                {request.data ? (
                  <Alert tone="info">
                    {t('fin.invoices.form.forRequest', { number: request.data.requestNo, service: request.data.service ? pick(request.data.service.name, request.data.service.nameAr) : '' })}{' '}
                    <Link href={`/quotations/new?requestId=${request.data.id}`} className="font-medium text-secondary-text hover:underline">
                      {t('fin.invoices.form.useQuotation')}
                    </Link>
                  </Alert>
                ) : null}
                <div className="grid gap-5 sm:grid-cols-2">
                  <FormField name="customerId" label={t('fin.common.customer')} required>
                    {(field) => (
                      <CustomerPicker
                        {...field}
                        value={field.value}
                        disabled={editing || !!requestId}
                        selectedLabel={customerName}
                        onChange={(id, picked) => {
                          field.onChange(id);
                          setCustomerName(picked?.fullName ?? null);
                          setCompany(picked?.corporateAccountId ? { id: picked.corporateAccountId, name: null } : null);
                          setBillCompany(true);
                        }}
                      />
                    )}
                  </FormField>
                  {branches.data && branches.data.length > 1 ? (
                    <FormField name="branchId" label={t('fin.common.branch')} required>
                      {(field) => (
                        <FieldSelect {...field} disabled={editing || !!requestId} onValueChange={field.onChange} placeholder={t('common.selectPlaceholder')} options={branches.data.map((b) => ({ value: b.id, label: pick(b.name, b.nameAr) }))} />
                      )}
                    </FormField>
                  ) : null}
                </div>
                {company && !editing ? (
                  <ChoiceLabel
                    htmlFor={billId}
                    control={<Checkbox id={billId} checked={billCompany} onCheckedChange={(v) => setBillCompany(v === true)} />}
                    label={company.name ? t('fin.invoices.form.billCompanyNamed', { company: company.name }) : t('fin.invoices.form.billCompany')}
                    description={t('fin.invoices.form.billCompanyHint')}
                  />
                ) : null}
                {editing && invoice.data?.corporateAccount ? <p className="text-sm text-muted-foreground">{t('fin.invoices.form.billedTo', { company: invoice.data.corporateAccount.companyName })}</p> : null}
              </CardContent>
            </Card>

            <section aria-labelledby="invoice-lines" className="space-y-4">
              <div>
                <h2 id="invoice-lines" className="text-md font-semibold text-foreground">
                  {t('fin.lines.title')}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">{t('fin.lines.help')}</p>
              </div>
              <LineEditor currency={currency} rates={rates} />
              <DiscountNote rates={rates} />
            </section>

            <Card>
              <CardContent>
                <FormField name="notes" label={t('fin.invoices.form.notes')} optional hint={t('fin.invoices.form.notesHint')}>
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
            {editing ? t('fin.invoices.form.saveChanges') : t('fin.invoices.form.saveDraft')}
          </Button>
        </FormActions>
      </Form>
    </>
  );
}

/** A discount on a directly created invoice needs a second person at issue time: say so while it is typed. */
function DiscountNote({ rates }: { rates: Parameters<typeof useLinesPreview>[0] }) {
  const { t } = useI18n();
  const totals = useLinesPreview(rates);
  if (!totals.hasDiscount) return null;
  return <Alert tone="warning">{t('fin.invoices.form.discountNote')}</Alert>;
}
