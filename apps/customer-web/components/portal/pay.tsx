'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { CreditCard, ShieldCheck } from 'lucide-react';
import { isApiError, newIdempotencyKey } from '@typease/api-client';
import {
  Alert, Button, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, useApiClient, useBranding, useErrorMessage, useI18n, type ButtonProps,
} from '@typease/ui';
import { usePortalApi } from '@/lib/api';
import { keys } from '@/lib/query-keys';
import type { CheckoutSession } from '@/lib/types';
import { Money } from './shared';

export interface PayableInvoice {
  id: string;
  invoiceNo: string;
  balanceDue: string;
  currency: string;
}

/** Where the payment provider sends the customer back to. The API adds `payment=<id>&result=...`. */
function returnUrl(slug: string | undefined, invoiceId: string): string {
  const url = new URL('/payments/return', window.location.origin);
  // On the shared portal address the centre travels in the link; on a centre's own domain the host decides.
  if (slug) url.searchParams.set('tenant', slug);
  url.searchParams.set('invoice', invoiceId);
  return url.toString();
}

/** Same-origin path of a URL the API returned, or null when it points elsewhere. */
function localPath(url: string): string | null {
  try {
    const u = new URL(url, window.location.origin);
    return u.origin === window.location.origin ? `${u.pathname}${u.search}` : null;
  } catch {
    return null;
  }
}

/**
 * "Pay online": opens a hosted checkout at the centre's payment provider for the
 * open balance of one invoice. Nothing is marked paid here: the invoice changes
 * only when the provider's signed confirmation reaches the API, and the return
 * page reads the result from the API.
 *
 * The TEST provider (sandbox) has no payment page of its own, so the portal shows
 * its two outcomes in a dialog that says clearly that no money moves.
 */
export function PayInvoiceButton({ invoice, children, ...button }: { invoice: PayableInvoice } & Omit<ButtonProps, 'onClick' | 'loading'>) {
  const { t } = useI18n();
  const api = usePortalApi();
  const { config } = useBranding();
  const describe = useErrorMessage();
  const [busy, setBusy] = React.useState(false);
  const [failure, setFailure] = React.useState<{ title?: string; text: string } | null>(null);
  const [session, setSession] = React.useState<CheckoutSession | null>(null);
  // One key per intent to pay: a double press or a retry after a timeout can not open two payments.
  const key = React.useRef<string | null>(null);

  const start = async () => {
    setBusy(true);
    setFailure(null);
    key.current ??= newIdempotencyKey();
    try {
      const checkout = await api.payInvoice(invoice.id, returnUrl(config?.slug, invoice.id), key.current);
      if (checkout.gateway === 'sandbox' && checkout.testMode) {
        setSession(checkout);
        setBusy(false);
        return;
      }
      // A real provider: the customer continues on its page and comes back to /payments/return.
      window.location.assign(checkout.checkoutUrl);
    } catch (error) {
      key.current = null;
      setBusy(false);
      if (isApiError(error) && error.code === 'INTEGRATION_NOT_CONFIGURED') setFailure({ title: t('my.pay.offlineTitle'), text: t('my.pay.offlineText') });
      else setFailure({ text: describe(error) });
    }
  };

  return (
    <>
      <Button {...button} loading={busy} loadingText={t('common.loading')} onClick={() => void start()}>
        {children ?? (
          <>
            <CreditCard aria-hidden="true" />
            {t('my.pay.payOnline')}
          </>
        )}
      </Button>
      {failure ? (
        <Dialog open onOpenChange={(open) => !open && setFailure(null)}>
          <DialogContent size="sm">
            <DialogHeader>
              <DialogTitle>{failure.title ?? t('my.pay.failedTitle')}</DialogTitle>
              <DialogDescription>{failure.text}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button onClick={() => setFailure(null)}>{t('common.close')}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
      {session ? (
        <TestCheckoutDialog
          session={session}
          invoice={invoice}
          onClose={() => {
            setSession(null);
            key.current = null;
          }}
        />
      ) : null}
    </>
  );
}

/** The sandbox provider's "payment page": complete or decline the test payment. No money moves. */
function TestCheckoutDialog({ session, invoice, onClose }: { session: CheckoutSession; invoice: PayableInvoice; onClose: () => void }) {
  const { t, formatMoney } = useI18n();
  const client = useApiClient();
  const router = useRouter();
  const queryClient = useQueryClient();
  const describe = useErrorMessage();
  const [busy, setBusy] = React.useState<'complete' | 'fail' | null>(null);
  const [failure, setFailure] = React.useState<string | null>(null);
  // The session lives on the API (`.../api/v1/public/payments/sandbox/checkout/<ref>`): call it through the client,
  // whichever origin the browser reaches the API on (directly, or through this portal's own address).
  const at = session.checkoutUrl.indexOf('/api/v1/');
  const sessionPath = at >= 0 ? session.checkoutUrl.slice(at + '/api/v1'.length) : null;
  const reachable = sessionPath !== null;

  const finish = async (outcome: 'complete' | 'fail') => {
    if (!reachable) return;
    setBusy(outcome);
    setFailure(null);
    try {
      const path = `${sessionPath}/${outcome}`;
      // The test gateway answers by sending its signed webhook to the API, exactly like a real payment.
      const result = await client.post<{ outcome: string; returnUrl?: string }>(path, outcome === 'fail' ? { reason: t('my.pay.test.declinedReason') } : undefined, { auth: false });
      await Promise.all([queryClient.invalidateQueries({ queryKey: keys.invoices.all }), queryClient.invalidateQueries({ queryKey: keys.payments.all }), queryClient.invalidateQueries({ queryKey: keys.requests.all })]);
      const back = result.returnUrl ? localPath(result.returnUrl) : null;
      router.push(back ?? `/payments/return?payment=${session.paymentId}&invoice=${invoice.id}`);
    } catch (error) {
      setFailure(describe(error));
      setBusy(null);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{t('my.pay.test.title')}</DialogTitle>
          <DialogDescription>{t('my.pay.test.description', { number: invoice.invoiceNo })}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <Alert tone="warning">{t('my.pay.test.notice')}</Alert>
          <div className="flex items-center justify-between rounded-md bg-muted/60 px-3.5 py-3 text-base">
            <span>{t('my.pay.amount')}</span>
            <Money amount={session.amount} currency={session.currency} className="text-md font-semibold" />
          </div>
          <p className="flex gap-2 text-sm text-muted-foreground">
            <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            {t('my.pay.test.hint')}
          </p>
          {failure ? (
            <Alert tone="danger" live>
              {failure}
            </Alert>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" disabled={!!busy || !reachable} loading={busy === 'fail'} loadingText={t('common.loading')} onClick={() => void finish('fail')} data-test-pay="fail">
            {t('my.pay.test.decline')}
          </Button>
          <Button disabled={!!busy || !reachable} loading={busy === 'complete'} loadingText={t('common.loading')} onClick={() => void finish('complete')} data-test-pay="complete">
            {t('my.pay.test.complete', { amount: formatMoney(session.amount, session.currency) })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
