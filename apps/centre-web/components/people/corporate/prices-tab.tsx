'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Tag, Trash2 } from 'lucide-react';
import { corporatePriceSchema } from '@typease/validation';
import {
  Badge, Button, Card, ConfirmDialog, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, EmptyState, Form, FormError, FormField, MoneyInput, Skeleton, Table, TableBody,
  TableCell, TableHead, TableHeader, TableRow, useApi, useI18n, useSession, useToast, useZodForm,
} from '@typease/ui';
import { ServicePicker } from '@/components/pickers';
import { peopleKeys } from '@/lib/keys/people';
import { LoadError, RecordLink } from '../shared';
import type { ContractPrice, CorporateAccountDetail } from '../types';

interface ResolvedPrice {
  currency: string;
  listServiceFee: string;
  governmentFeeEstimate: string;
  thirdPartyFeeEstimate: string;
}

/**
 * Contract prices: per service, the SERVICE FEE this company pays instead of the catalogue fee.
 * Government and third-party amounts are never part of a contract price. The saving is the difference
 * the API reports between the two fees; nothing is calculated from parsed numbers except that label.
 */
export function PricesTab({ account }: { account: CorporateAccountDetail }) {
  const { t, pick, formatMoney } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const session = useSession();
  const queryClient = useQueryClient();
  const canManage = session.hasPermission('corporate.manage') && account.status !== 'ARCHIVED';
  const [editing, setEditing] = React.useState<ContractPrice | 'new' | null>(null);
  const [deleting, setDeleting] = React.useState<ContractPrice | null>(null);

  const prices = useQuery({ queryKey: peopleKeys.corporate.prices(account.id), queryFn: () => api.client.get<ContractPrice[]>(`/corporate-accounts/${account.id}/prices`) });
  const refresh = () => queryClient.invalidateQueries({ queryKey: peopleKeys.corporate.prices(account.id) });
  const remove = async (price: ContractPrice) => {
    try {
      await api.client.delete(`/corporate-accounts/${account.id}/prices/${price.id}`);
      toasts.success(t('people.corporate.prices.deleted'), pick(price.serviceName, price.serviceNameAr));
      await refresh();
    } catch (error) {
      toasts.error(error);
      throw error;
    }
  };

  const add = canManage ? (
    <Button variant="outline" onClick={() => setEditing('new')}>
      <Plus aria-hidden="true" />
      {t('people.corporate.prices.add')}
    </Button>
  ) : null;
  const list = prices.data ?? [];

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <p className="max-w-2xl text-base text-muted-foreground">{t('people.corporate.prices.text')}</p>
        {add}
      </div>
      <Card>
        {prices.isPending ? (
          <div className="space-y-3 p-5" role="status" aria-label={t('common.loading')}>
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : prices.isError ? (
          <div className="p-4">
            <LoadError error={prices.error} onRetry={() => void prices.refetch()} />
          </div>
        ) : list.length === 0 ? (
          <EmptyState icon={<Tag />} title={t('people.corporate.prices.empty')} description={t('people.corporate.prices.emptyText')} action={add} />
        ) : (
          <Table>
            <caption className="sr-only">{t('people.corporate.tabs.prices')}</caption>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>{t('requests.columns.service')}</TableHead>
                <TableHead className="text-end">{t('people.corporate.prices.catalogue')}</TableHead>
                <TableHead className="text-end">{t('people.corporate.prices.contract')}</TableHead>
                {canManage ? (
                  <TableHead className="w-24">
                    <span className="sr-only">{t('common.actions')}</span>
                  </TableHead>
                ) : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((price) => {
                const name = pick(price.serviceName, price.serviceNameAr);
                const lower = price.catalogueServiceFee !== null && Number(price.contractServiceFee) < Number(price.catalogueServiceFee);
                const higher = price.catalogueServiceFee !== null && Number(price.contractServiceFee) > Number(price.catalogueServiceFee);
                return (
                  <TableRow key={price.id}>
                    <TableCell>
                      {session.hasPermission('service.read') ? <RecordLink href={`/services/${price.serviceId}`}>{name}</RecordLink> : <span className="font-medium text-foreground">{name}</span>}
                      <span className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                        <span className="ltr-value tabular">{price.serviceCode}</span>
                        {price.serviceActive ? null : <Badge tone="neutral">{t('people.corporate.prices.inactive')}</Badge>}
                      </span>
                    </TableCell>
                    <TableCell className="tabular whitespace-nowrap text-end text-muted-foreground">{price.catalogueServiceFee === null ? '–' : formatMoney(price.catalogueServiceFee, price.currency)}</TableCell>
                    <TableCell className="whitespace-nowrap text-end">
                      <span className="tabular block font-semibold text-foreground">{formatMoney(price.contractServiceFee, price.currency)}</span>
                      {lower ? <span className="block text-xs text-success-text">{t('people.corporate.prices.below')}</span> : null}
                      {higher ? <span className="block text-xs text-warning-text">{t('people.corporate.prices.above')}</span> : null}
                    </TableCell>
                    {canManage ? (
                      <TableCell className="text-end">
                        <div className="flex justify-end gap-1">
                          <Button variant="ghost" size="icon-sm" aria-label={`${t('people.corporate.prices.change')}: ${name}`} title={t('people.corporate.prices.change')} onClick={() => setEditing(price)}>
                            <Pencil aria-hidden="true" />
                          </Button>
                          <Button variant="ghost" size="icon-sm" aria-label={`${t('common.remove')}: ${name}`} title={t('common.remove')} onClick={() => setDeleting(price)}>
                            <Trash2 className="text-destructive-text" aria-hidden="true" />
                          </Button>
                        </div>
                      </TableCell>
                    ) : null}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>
      <p className="mt-3 text-sm text-muted-foreground">{t('people.corporate.prices.note')}</p>

      {editing ? <PriceDialog account={account} price={editing === 'new' ? null : editing} taken={list.map((p) => p.serviceId)} open onOpenChange={(next) => !next && setEditing(null)} onSaved={refresh} /> : null}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(next) => !next && setDeleting(null)}
        title={t('people.corporate.prices.deleteTitle')}
        description={t('people.corporate.prices.deleteText', { service: deleting ? pick(deleting.serviceName, deleting.serviceNameAr) : '' })}
        confirmLabel={t('common.remove')}
        onConfirm={() => (deleting ? remove(deleting) : undefined)}
      />
    </>
  );
}

function PriceDialog({ account, price, taken, open, onOpenChange, onSaved }: { account: CorporateAccountDetail; price: ContractPrice | null; taken: string[]; open: boolean; onOpenChange: (open: boolean) => void; onSaved: () => Promise<unknown> }) {
  const { t, pick, formatMoney } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const session = useSession();
  const form = useZodForm(corporatePriceSchema, { defaultValues: { serviceId: price?.serviceId ?? '', serviceFee: price?.contractServiceFee ?? '' } });
  const serviceId = form.watch('serviceId');

  // The catalogue price of the chosen service, for comparison (without the company, so it is the list price).
  const catalogue = useQuery({
    queryKey: ['services', 'price', serviceId],
    queryFn: () => api.client.get<ResolvedPrice>(`/services/${serviceId}/price`),
    enabled: !!serviceId && session.hasPermission('service.read'),
    staleTime: 60_000,
    retry: false,
  });
  const replaces = !price && !!serviceId && taken.includes(serviceId);

  const save = async (values: { serviceId: string; serviceFee: string }) => {
    const saved = await api.client.put<ContractPrice>(`/corporate-accounts/${account.id}/prices`, values);
    toasts.success(t('people.corporate.prices.saved'), `${pick(saved.serviceName, saved.serviceNameAr)}: ${formatMoney(saved.contractServiceFee, saved.currency)}`);
    await onSaved();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <Form form={form} onSubmit={save} className="flex min-h-0 flex-1 flex-col space-y-0">
          <DialogHeader>
            <DialogTitle>{price ? t('people.corporate.prices.editTitle') : t('people.corporate.prices.addTitle')}</DialogTitle>
            <DialogDescription>{t('people.corporate.prices.dialogText', { name: account.companyName })}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            <FormField name="serviceId" label={t('requests.columns.service')} required>
              {(field) => (price ? <p className="text-base font-medium text-foreground">{pick(price.serviceName, price.serviceNameAr)}</p> : <ServicePicker {...field} onChange={(id) => field.onChange(id)} />)}
            </FormField>

            {serviceId ? (
              <dl className="grid grid-cols-2 gap-x-6 gap-y-2 rounded-lg border bg-muted/40 p-4 text-base">
                <dt className="text-muted-foreground">{t('people.corporate.prices.catalogueFee')}</dt>
                <dd className="tabular text-end font-medium">
                  {catalogue.isPending && catalogue.fetchStatus !== 'idle' ? <Skeleton className="ms-auto h-5 w-24" /> : catalogue.data ? formatMoney(catalogue.data.listServiceFee, catalogue.data.currency) : price?.catalogueServiceFee ? formatMoney(price.catalogueServiceFee, price.currency) : '–'}
                </dd>
                {catalogue.data ? (
                  <>
                    <dt className="text-muted-foreground">{t('people.corporate.prices.governmentFee')}</dt>
                    <dd className="tabular text-end text-muted-foreground">{formatMoney(catalogue.data.governmentFeeEstimate, catalogue.data.currency)}</dd>
                    <dt className="text-muted-foreground">{t('people.corporate.prices.thirdPartyFee')}</dt>
                    <dd className="tabular text-end text-muted-foreground">{formatMoney(catalogue.data.thirdPartyFeeEstimate, catalogue.data.currency)}</dd>
                  </>
                ) : null}
              </dl>
            ) : null}

            <FormField name="serviceFee" label={t('people.corporate.prices.contractFee')} required hint={t('people.corporate.prices.contractFeeHint')}>
              {(field) => <MoneyInput {...field} currency={catalogue.data?.currency ?? price?.currency} className="sm:max-w-xs" />}
            </FormField>
            {replaces ? <p className="text-sm text-warning-text">{t('people.corporate.prices.replaces')}</p> : null}
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {t('people.corporate.prices.save')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
