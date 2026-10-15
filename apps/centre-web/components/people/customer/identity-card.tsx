'use client';

import * as React from 'react';
import { Eye, EyeOff, ShieldAlert } from 'lucide-react';
import {
  Alert, Button, CopyButton, DescriptionList, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, PermissionGate, countryName, useApi, useErrorMessage, useI18n,
} from '@typease/ui';
import { Ltr, Section } from '../shared';
import type { CustomerIdentity, CustomerOverview } from '../types';

/** How long the full numbers stay on screen before they are hidden again. */
const VISIBLE_SECONDS = 30;

const formatEmiratesId = (value: string) => (/^\d{15}$/.test(value) ? `${value.slice(0, 3)}-${value.slice(3, 7)}-${value.slice(7, 14)}-${value.slice(14)}` : value);

/**
 * Identity documents of a customer. The numbers are masked everywhere; the full numbers are shown only
 * through the explicit "Show full numbers" action (permission `customer.sensitive.read`), for a short
 * time, and every time it is used the API writes an audit entry. The numbers live in this component's
 * state only: never in the query cache, never in the URL.
 */
export function IdentityCard({ customer }: { customer: CustomerOverview }) {
  const { t, locale, formatDate, today } = useI18n();
  const [revealing, setRevealing] = React.useState(false);
  const expired = (date: string | null) => !!date && date < today();
  const expiry = (date: string | null) =>
    date ? (
      <span className={expired(date) ? 'font-medium text-destructive-text' : undefined}>
        {formatDate(date)}
        {expired(date) ? ` (${t('people.common.expired')})` : ''}
      </span>
    ) : null;

  const nothing = !customer.hasEmiratesId && !customer.hasPassport;
  return (
    <Section
      title={t('people.customer.identity.title')}
      description={nothing ? undefined : t('people.customer.identity.maskedHint')}
      action={
        nothing ? null : (
          <PermissionGate permission="customer.sensitive.read">
            <Button variant="outline" size="sm" onClick={() => setRevealing(true)}>
              <Eye aria-hidden="true" />
              {t('people.customer.identity.reveal')}
            </Button>
          </PermissionGate>
        )
      }
    >
      {nothing ? (
        <p className="text-base text-muted-foreground">{t('people.customer.identity.none')}</p>
      ) : (
        <DescriptionList
          columns={2}
          items={[
            { label: t('people.customer.fields.emiratesId'), value: customer.emiratesIdMasked ? <Ltr>{customer.emiratesIdMasked}</Ltr> : null },
            { label: t('people.customer.fields.emiratesIdExpiry'), value: expiry(customer.emiratesIdExpiry) },
            { label: t('people.customer.fields.passportNo'), value: customer.passportNoMasked ? <Ltr>{customer.passportNoMasked}</Ltr> : null },
            { label: t('people.customer.fields.passportExpiry'), value: expiry(customer.passportExpiry) },
            { label: t('people.customer.fields.passportCountry'), value: countryName(customer.passportCountry, locale) || null },
          ]}
        />
      )}
      {revealing ? <RevealIdentityDialog customer={customer} open onOpenChange={setRevealing} /> : null}
    </Section>
  );
}

function RevealIdentityDialog({ customer, open, onOpenChange }: { customer: CustomerOverview; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t, tn, locale, formatDate } = useI18n();
  const api = useApi();
  const describe = useErrorMessage();
  const [state, setState] = React.useState<{ status: 'confirm' | 'loading' | 'shown' | 'hidden' | 'error'; identity?: CustomerIdentity; error?: string }>({ status: 'confirm' });
  const [secondsLeft, setSecondsLeft] = React.useState(VISIBLE_SECONDS);

  // Count down while the numbers are visible, then drop them from memory.
  React.useEffect(() => {
    if (state.status !== 'shown') return;
    if (secondsLeft <= 0) {
      setState({ status: 'hidden' });
      return;
    }
    const timer = window.setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [state.status, secondsLeft]);

  const reveal = async () => {
    setState({ status: 'loading' });
    try {
      const identity = await api.client.get<CustomerIdentity>(`/customers/${customer.id}/identity`);
      setSecondsLeft(VISIBLE_SECONDS);
      setState({ status: 'shown', identity });
    } catch (error) {
      setState({ status: 'error', error: describe(error) });
    }
  };

  const close = (next: boolean) => {
    if (!next) setState({ status: 'confirm' });
    onOpenChange(next);
  };

  const identity = state.identity;
  const row = (label: string, value: string | null, display?: string) => ({
    label,
    wide: true,
    value: value ? (
      <span className="inline-flex items-center gap-1">
        <Ltr className="whitespace-nowrap text-md font-semibold">{display ?? value}</Ltr>
        <CopyButton value={value} label={t('people.customer.identity.copy', { label })} />
      </span>
    ) : (
      <span className="text-muted-foreground">{t('people.customer.identity.notOnFile')}</span>
    ),
  });

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{t('people.customer.identity.revealTitle')}</DialogTitle>
          <DialogDescription>
            {customer.fullName} · <span className="tabular">{customer.customerNo}</span>
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <Alert tone="warning" title={t('people.customer.identity.loggedTitle')}>
            {t('people.customer.identity.loggedText')}
          </Alert>

          {state.status === 'error' ? (
            <Alert tone="danger" live>
              {state.error}
            </Alert>
          ) : null}

          {state.status === 'shown' && identity ? (
            <div className="rounded-lg border bg-muted/40 p-4">
              <DescriptionList
                columns={2}
                items={[
                  row(t('people.customer.fields.emiratesId'), identity.emiratesId, identity.emiratesId ? formatEmiratesId(identity.emiratesId) : undefined),
                  row(t('people.customer.fields.passportNo'), identity.passportNo),
                  { label: t('people.customer.fields.emiratesIdExpiry'), value: identity.emiratesIdExpiry ? formatDate(identity.emiratesIdExpiry) : null },
                  { label: t('people.customer.fields.passportExpiry'), value: identity.passportExpiry ? formatDate(identity.passportExpiry) : null },
                  { label: t('people.customer.fields.passportCountry'), value: countryName(identity.passportCountry, locale) || null },
                ]}
              />
              <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground" role="timer" aria-live="off">
                <EyeOff className="size-4" aria-hidden="true" />
                {tn('people.customer.identity.hidesIn', secondsLeft)}
              </p>
              <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                <div className="h-full rounded-full bg-warning transition-[width] duration-1000 ease-linear" style={{ width: `${(secondsLeft / VISIBLE_SECONDS) * 100}%` }} />
              </div>
            </div>
          ) : null}

          {state.status === 'hidden' ? (
            <p className="flex items-center gap-2 rounded-lg border bg-muted/40 p-4 text-base text-muted-foreground" role="status">
              <ShieldAlert className="size-5 shrink-0" aria-hidden="true" />
              {t('people.customer.identity.hiddenAgain')}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)}>
            {state.status === 'shown' ? t('people.customer.identity.hideNow') : t('common.close')}
          </Button>
          {state.status !== 'shown' ? (
            <Button onClick={reveal} loading={state.status === 'loading'} loadingText={t('common.loading')}>
              <Eye aria-hidden="true" />
              {state.status === 'hidden' ? t('people.customer.identity.revealAgain') : t('people.customer.identity.revealConfirm')}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
