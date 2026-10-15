'use client';

import * as React from 'react';
import Link from 'next/link';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CalendarClock, CheckCircle2, CreditCard, FileClock, XCircle } from 'lucide-react';
import { isApiError } from '@typease/api-client';
import { Alert, Button, Card, CardContent, Input, Label, Skeleton, useApiClient, useErrorMessage, useI18n } from '@typease/ui';
import { PublicPage } from '@/components/public-shell';
import { ROUTES } from '@/lib/config';

interface Offer {
  centreName: string;
  customerFirstName: string;
  status: 'SENT' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED' | 'SUPERSEDED' | 'DRAFT';
  quotationNo: string;
  requestNo: string | null;
  serviceName: string | null;
  serviceNameAr: string | null;
  documentName: string | null;
  documentNameAr: string | null;
  expiryDate: string | null;
  validUntil: string | null;
  currency: string;
  lines: Array<{ description: string; component: 'SERVICE_FEE' | 'GOVERNMENT_FEE' | 'THIRD_PARTY_FEE'; amount: string }>;
  taxTotal: string;
  total: string;
  payOnline: boolean;
  invoice: { invoiceNo: string; status: string; balanceDue: string } | null;
}

/** The page behind the one-tap renewal link: price, approve and pay, or decline. No sign-in: the signed link is the key. */
export function RenewalOffer({ token, returned }: { token: string; returned: boolean }) {
  const { t, pick, formatMoney, formatDate } = useI18n();
  const client = useApiClient();
  const describe = useErrorMessage();
  const [declining, setDeclining] = React.useState(false);
  const [reason, setReason] = React.useState('');
  const path = `/public/renewals/${encodeURIComponent(token)}`;
  const offer = useQuery({ queryKey: ['renewal', token], queryFn: () => client.get<Offer>(path), enabled: !!token, retry: false });
  const accept = useMutation({
    mutationFn: () => client.post<{ approved: boolean; checkoutUrl: string | null }>(`${path}/accept`, { returnUrl: `${window.location.origin}${window.location.pathname}${window.location.search.replace(/&?paid=1/, '')}&paid=1` }),
    onSuccess: (r) => (r.checkoutUrl ? window.location.assign(r.checkoutUrl) : void offer.refetch()),
  });
  const decline = useMutation({ mutationFn: () => client.post(`${path}/decline`, { reason: reason || null }), onSuccess: () => void offer.refetch() });

  const invalid = !token || (offer.error && isApiError(offer.error) && offer.error.status === 404);
  if (invalid) {
    return (
      <PublicPage narrow title={t('renew.title')}>
        <Alert tone="warning">{t('renew.invalid')}</Alert>
      </PublicPage>
    );
  }
  const o = offer.data;
  if (!o) {
    return (
      <PublicPage narrow title={t('renew.title')}>
        <Skeleton className="h-80 w-full" />
      </PublicPage>
    );
  }
  const paid = o.invoice?.status === 'PAID';
  const toPay = o.invoice && !paid ? o.invoice.balanceDue : o.total;
  return (
    <PublicPage narrow title={t('renew.heading', { name: o.customerFirstName })} description={t('renew.description', { centre: o.centreName })}>
      <Card>
        <CardContent className="space-y-6">
          {o.documentName ? (
            <div className="flex items-start gap-3 rounded-lg border bg-warning-soft/40 p-4">
              <FileClock aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-warning-text" />
              <div>
                <p className="font-semibold">{pick(o.documentName, o.documentNameAr)}</p>
                {o.expiryDate ? <p className="text-sm text-muted-foreground">{t('renew.expires', { date: formatDate(o.expiryDate) })}</p> : null}
              </div>
            </div>
          ) : null}

          <section aria-labelledby="price-h" className="space-y-3">
            <h2 id="price-h" className="text-md font-semibold">
              {pick(o.serviceName ?? '', o.serviceNameAr)}
            </h2>
            <ul className="divide-y rounded-lg border text-sm">
              {o.lines.map((l, i) => (
                <li key={i} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <span className="min-w-0">
                    <span className="block">{t(`renew.component.${l.component}`)}</span>
                    {l.component !== 'SERVICE_FEE' ? <span className="block text-xs text-muted-foreground">{t('renew.passThrough')}</span> : null}
                  </span>
                  <span className="tabular">{formatMoney(l.amount, o.currency)}</span>
                </li>
              ))}
              <li className="flex items-center justify-between gap-3 bg-muted/40 px-4 py-3 font-semibold">
                <span>{t('renew.total')}</span>
                <span className="text-lg tabular">{formatMoney(o.total, o.currency)}</span>
              </li>
            </ul>
            <p className="text-xs text-muted-foreground">
              {t('renew.quoteRef', { no: o.quotationNo })}
              {o.validUntil && o.status === 'SENT' ? ` · ${t('renew.validUntil', { date: formatDate(o.validUntil) })}` : ''}
            </p>
          </section>

          {paid || (returned && o.status === 'APPROVED') ? (
            <Alert tone="success" title={paid ? t('renew.paidTitle') : t('renew.returnedTitle')}>
              {paid ? t('renew.paidText', { centre: o.centreName }) : t('renew.returnedText')}
            </Alert>
          ) : o.status === 'SENT' || o.status === 'APPROVED' ? (
            <div className="space-y-3">
              {o.status === 'APPROVED' ? <Alert tone="info">{t('renew.approvedText', { invoice: o.invoice?.invoiceNo ?? '' })}</Alert> : null}
              {o.payOnline ? (
                <Button size="lg" className="w-full" loading={accept.isPending} onClick={() => accept.mutate()}>
                  <CreditCard aria-hidden="true" />
                  {o.status === 'SENT' ? t('renew.approvePay', { amount: formatMoney(toPay, o.currency) }) : t('renew.payNow', { amount: formatMoney(toPay, o.currency) })}
                </Button>
              ) : o.status === 'SENT' ? (
                <>
                  <Button size="lg" className="w-full" loading={accept.isPending} onClick={() => accept.mutate()}>
                    <CheckCircle2 aria-hidden="true" />
                    {t('renew.approve')}
                  </Button>
                  <p className="text-sm text-muted-foreground">{t('renew.payAtCentre')}</p>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">{t('renew.payAtCentre')}</p>
              )}
              {accept.error ? <Alert tone="danger">{describe(accept.error)}</Alert> : null}
              {o.status === 'SENT' ? (
                declining ? (
                  <div className="space-y-2 rounded-lg border p-4">
                    <Label htmlFor="decline-reason">{t('renew.declineReason')}</Label>
                    <Input id="decline-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
                    <div className="flex gap-2">
                      <Button variant="outline" onClick={() => setDeclining(false)}>
                        {t('common.cancel')}
                      </Button>
                      <Button variant="destructive" loading={decline.isPending} onClick={() => decline.mutate()}>
                        {t('renew.declineConfirm')}
                      </Button>
                    </div>
                    {decline.error ? <Alert tone="danger">{describe(decline.error)}</Alert> : null}
                  </div>
                ) : (
                  <Button variant="ghost" className="w-full" onClick={() => setDeclining(true)}>
                    <XCircle aria-hidden="true" />
                    {t('renew.decline')}
                  </Button>
                )
              ) : null}
            </div>
          ) : (
            <Alert tone={o.status === 'REJECTED' ? 'info' : 'warning'} title={t(`renew.closed.${o.status === 'REJECTED' ? 'REJECTED' : 'OTHER'}`)}>
              {t('renew.closedText', { centre: o.centreName })}
            </Alert>
          )}

          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <CalendarClock aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {t('renew.afterPayment')}
          </p>
        </CardContent>
      </Card>
      <p className="mt-6 text-sm text-muted-foreground">
        {t('renew.loginHint')}{' '}
        <Link href={ROUTES.login} className="font-medium text-secondary-text underline-offset-4 hover:underline">
          {t('nav.login')}
        </Link>
      </p>
    </PublicPage>
  );
}
