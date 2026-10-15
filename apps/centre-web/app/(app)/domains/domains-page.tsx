'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { isApiError } from '@typease/api-client';
import { ArrowUpCircle, CalendarClock, ExternalLink, Globe, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { domainSchema } from '@typease/validation';
import {
  Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, ConfirmDialog, CopyButton, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle, EmptyState, Form, FormError, FormField, Input, PageHeader, RequirePermission, Skeleton, useApi, useI18n, useToast, useZodForm, type Tone,
} from '@typease/ui';
import { usePortalUrl } from '@/components/adm/portal-url';
import { ActionError, LoadError, PlanLimitAlert, isPlanLimit, useFailToast } from '@/components/adm/shared';
import type { DnsInstructions, DomainRow, DomainVerifyResult, DomainsState } from '@/components/adm/types';
import { admKeys } from '@/lib/keys/adm';

const STATUS_TONE: Record<string, Tone> = { PENDING: 'warning', VERIFIED: 'success', FAILED: 'danger', DISABLED: 'neutral', SUSPENDED_BY_PLAN: 'warning' };
/** Answers of POST /domains that belong to the domain field; worded by the dictionary (the API's sentence is English only). */
const FIELD_ERRORS = ['DOMAIN_ALREADY_ADDED', 'DOMAIN_IN_USE', 'DOMAIN_NOT_ALLOWED'];

export function DomainsPage() {
  return (
    <RequirePermission anyOf={['domain.manage']}>
      <Domains />
    </RequirePermission>
  );
}

function Domains() {
  const { t } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const portalUrl = usePortalUrl();
  const domains = useQuery({ queryKey: admKeys.domains.all, queryFn: () => api.client.get<DomainsState>('/domains') });
  const [adding, setAdding] = React.useState(false);
  const [removing, setRemoving] = React.useState<DomainRow | null>(null);
  const [removeError, setRemoveError] = React.useState<unknown>(null);

  const add = (
    <Button variant="accent" onClick={() => setAdding(true)} disabled={!domains.data}>
      <Plus aria-hidden="true" />
      {t('adm.domains.add')}
    </Button>
  );

  return (
    <>
      <PageHeader title={t('adm.domains.title')} description={t('adm.domains.description')} action={add} />

      {domains.isPending ? (
        <div className="space-y-6">
          <Skeleton className="h-28" />
          <Skeleton className="h-64" />
        </div>
      ) : domains.isError ? (
        <LoadError error={domains.error} onRetry={() => void domains.refetch()} />
      ) : (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <div>
                <CardTitle>{t('adm.domains.platform.title')}</CardTitle>
                <CardDescription>{t('adm.domains.platform.text')}</CardDescription>
              </div>
              <Badge tone="success">{t('adm.domains.platform.always')}</Badge>
            </CardHeader>
            <CardContent className="flex flex-wrap items-center gap-2">
              <span className="ltr-value tabular break-all rounded-md bg-muted px-3 py-2 text-base font-medium">{domains.data.platformDomain}</span>
              <CopyButton value={domains.data.platformDomain} label={t('adm.domains.copyAddress')} />
              {portalUrl ? (
                <Button asChild variant="link">
                  <a href={portalUrl} target="_blank" rel="noreferrer">
                    <ExternalLink aria-hidden="true" />
                    {t('adm.domains.openPortal')}
                  </a>
                </Button>
              ) : null}
            </CardContent>
          </Card>

          {/* A centre that still holds verified domains gets the precise sentence on each of them instead. */}
          {domains.data.customDomainsIncluded || domains.data.domains.some((d) => d.status === 'SUSPENDED_BY_PLAN') ? null : <PlanLimitAlert message={t('adm.domains.notIncluded')} />}

          <section aria-labelledby="custom-domains" className="space-y-4">
            <h2 id="custom-domains" className="text-lg font-semibold">
              {t('adm.domains.customTitle')}
            </h2>
            {domains.data.domains.length === 0 ? (
              <Card>
                <EmptyState icon={<Globe />} title={t('adm.domains.emptyTitle')} description={t('adm.domains.emptyText')} action={add} />
              </Card>
            ) : (
              domains.data.domains.map((d) => (
                <DomainCard
                  key={d.id}
                  domain={d}
                  onRemove={() => {
                    setRemoveError(null);
                    setRemoving(d);
                  }}
                />
              ))
            )}
          </section>

          <Card>
            <CardHeader>
              <CardTitle>{t('adm.domains.how.title')}</CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="list-decimal space-y-2 ps-5 text-base">
                <li>{t('adm.domains.how.step1')}</li>
                <li>{t('adm.domains.how.step2')}</li>
                <li>{t('adm.domains.how.step3')}</li>
                <li>{t('adm.domains.how.step4')}</li>
              </ol>
              <p className="mt-4 text-sm text-muted-foreground">{t('adm.domains.how.scope')}</p>
            </CardContent>
          </Card>
        </div>
      )}

      <AddDomainDialog open={adding} onOpenChange={setAdding} />
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={t('adm.domains.removeTitle', { domain: removing?.domain ?? '' })}
        description={removing?.verifiedAt ? t('adm.domains.removeTextVerified') : t('adm.domains.removeText')}
        confirmLabel={t('adm.domains.remove')}
        onConfirm={async () => {
          if (!removing) return;
          setRemoveError(null);
          try {
            await api.client.delete(`/domains/${removing.id}`);
            toasts.success(t('adm.domains.removed'), removing.domain);
            await queryClient.invalidateQueries({ queryKey: admKeys.domains.all });
          } catch (error) {
            setRemoveError(error);
            throw error;
          }
        }}
      >
        {removeError ? <ActionError error={removeError} /> : null}
      </ConfirmDialog>
    </>
  );
}

/** The two DNS records to create, each value with its own copy button. */
function DnsRecords({ dns }: { dns: DnsInstructions }) {
  const { t } = useI18n();
  const rows = [
    { type: 'TXT', purpose: t('adm.domains.dns.txtPurpose'), ...dns.txt },
    { type: 'CNAME', purpose: t('adm.domains.dns.cnamePurpose'), ...dns.cname },
  ];
  return (
    <div className="space-y-3">
      <p className="text-sm font-medium">{t('adm.domains.dns.title')}</p>
      <ul className="space-y-3">
        {rows.map((r) => (
          <li key={r.type} className="rounded-lg border">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-muted/40 px-3 py-2">
              <Badge tone="outline" className="tabular">
                {r.type}
              </Badge>
              <span className="text-sm text-muted-foreground">{r.purpose}</span>
            </div>
            <dl className="grid gap-x-6 gap-y-2 p-3 md:grid-cols-2">
              <div className="min-w-0">
                <dt className="text-sm text-muted-foreground">{t('adm.domains.dns.name')}</dt>
                <dd className="flex items-center gap-1">
                  <code className="ltr-value min-w-0 break-all text-sm">{r.name}</code>
                  <CopyButton value={r.name} label={t('adm.domains.dns.copyName', { type: r.type })} />
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-sm text-muted-foreground">{t('adm.domains.dns.value')}</dt>
                <dd className="flex items-center gap-1">
                  <code className="ltr-value min-w-0 break-all text-sm">{r.value}</code>
                  <CopyButton value={r.value} label={t('adm.domains.dns.copyValue', { type: r.type })} />
                </dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DomainCard({ domain, onRemove }: { domain: DomainRow; onRemove: () => void }) {
  const { t, formatDate, formatDateTime } = useI18n();
  const api = useApi();
  const fail = useFailToast();
  const queryClient = useQueryClient();
  const [checking, setChecking] = React.useState(false);
  const [result, setResult] = React.useState<DomainVerifyResult | null>(null);

  const verify = async () => {
    setChecking(true);
    try {
      const reply = await api.client.post<DomainVerifyResult>(`/domains/${domain.id}/verify`);
      setResult(reply);
      await queryClient.invalidateQueries({ queryKey: admKeys.domains.all });
    } catch (error) {
      fail(error);
    } finally {
      setChecking(false);
    }
  };

  // "Suspended by the plan" is a verified domain that the current plan does not serve: nothing has to be proved again.
  const suspended = domain.status === 'SUSPENDED_BY_PLAN';
  const verified = domain.status === 'VERIFIED' || suspended;
  const claim = !verified ? domain.claim : null;
  const stillReserved = claim ? new Date(claim.releasableAt).getTime() > Date.now() : false;
  return (
    <Card>
      <CardHeader className="items-center">
        <div className="min-w-0">
          <CardTitle className="ltr-value break-all">{domain.domain}</CardTitle>
          <CardDescription>{t('adm.domains.servesPortal')}</CardDescription>
        </div>
        <span className="flex flex-wrap items-center gap-1.5">
          <Badge tone={STATUS_TONE[domain.status] ?? 'neutral'}>{t(`adm.domains.status.${domain.status}`)}</Badge>
          {domain.isPrimary ? <Badge tone="brand">{t('adm.domains.primary')}</Badge> : null}
        </span>
      </CardHeader>
      <CardContent className="space-y-4">
        {suspended ? (
          <Alert
            tone="warning"
            title={t('adm.domains.suspended.title')}
            action={
              <Button asChild size="sm" variant="outline">
                <Link href="/subscription">
                  <ArrowUpCircle aria-hidden="true" />
                  {t('adm.domains.suspended.action')}
                </Link>
              </Button>
            }
          >
            {t('adm.domains.suspended.text', { date: formatDateTime(domain.verifiedAt) })}
          </Alert>
        ) : verified ? (
          <p className="text-base">
            {domain.isPrimary ? t('adm.domains.verifiedPrimary', { date: formatDateTime(domain.verifiedAt) }) : t('adm.domains.verified', { date: formatDateTime(domain.verifiedAt) })}
            {domain.routed === false ? <span className="block text-sm text-muted-foreground">{t('adm.domains.notRouted')}</span> : null}
          </p>
        ) : domain.dns ? (
          <DnsRecords dns={domain.dns} />
        ) : null}

        {claim ? (
          <p className="flex items-start gap-2 rounded-md bg-muted/60 px-3 py-2 text-sm" data-claim="">
            <CalendarClock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span>
              <span className={stillReserved ? 'font-medium' : 'font-medium text-warning-text'}>
                {stillReserved ? t('adm.domains.claim.reserved', { date: formatDateTime(claim.releasableAt) }) : t('adm.domains.claim.released', { date: formatDateTime(claim.releasableAt) })}
              </span>{' '}
              <span className="text-muted-foreground">{stillReserved ? t('adm.domains.claim.reservedText', { date: formatDate(claim.expiresAt) }) : t('adm.domains.claim.releasedText', { date: formatDate(claim.expiresAt) })}</span>
            </span>
          </p>
        ) : null}

        {result ? (
          <Alert tone={result.verified ? 'success' : 'warning'} live title={result.verified ? t('adm.domains.verifyOk') : t('adm.domains.verifyFailed')}>
            <span dir="auto">{result.message}</span>
          </Alert>
        ) : !verified && domain.lastCheckError ? (
          <Alert tone="warning" title={t('adm.domains.lastCheck', { date: formatDateTime(domain.lastCheckedAt) })}>
            <span dir="auto">{domain.lastCheckError}</span>
          </Alert>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">{suspended ? t('adm.domains.suspended.kept') : verified ? t('adm.domains.certificate') : t('adm.domains.waitHint')}</p>
          <span className="flex flex-wrap gap-2">
            <Button variant="ghost" size="sm" className="text-destructive-text hover:bg-destructive-soft" onClick={onRemove}>
              <Trash2 aria-hidden="true" />
              {t('adm.domains.remove')}
            </Button>
            {suspended ? null : (
              <Button variant={verified ? 'outline' : 'default'} size="sm" loading={checking} loadingText={t('adm.domains.checking')} onClick={() => void verify()}>
                <RefreshCw aria-hidden="true" />
                {verified ? t('adm.domains.checkAgain') : t('adm.domains.verify')}
              </Button>
            )}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

function AddDomainDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const form = useZodForm(domainSchema, { defaultValues: { domain: '', app: 'customer' } });
  const [limit, setLimit] = React.useState<unknown>(null);

  React.useEffect(() => {
    if (open) {
      form.reset({ domain: '', app: 'customer' });
      setLimit(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <Form
          form={form}
          className="flex min-h-0 flex-1 flex-col space-y-0"
          onSubmit={async (values) => {
            setLimit(null);
            try {
              const created = await api.client.post<DomainRow>('/domains', values);
              toasts.success(t('adm.domains.added'), t('adm.domains.addedText', { domain: created.domain }));
              await queryClient.invalidateQueries({ queryKey: admKeys.domains.all });
              onOpenChange(false);
            } catch (error) {
              if (isPlanLimit(error)) {
                setLimit(error);
                return;
              }
              if (isApiError(error) && FIELD_ERRORS.includes(error.code)) {
                form.setError('domain', { type: 'server', message: t(`adm.domains.errors.${error.code}`) }, { shouldFocus: true });
                return;
              }
              throw error;
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('adm.domains.addTitle')}</DialogTitle>
            <DialogDescription>{t('adm.domains.addText')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            <FormField name="domain" label={t('adm.domains.domain')} required hint={t('adm.domains.domainHint')}>
              {(field) => <Input {...field} onChange={(e: React.ChangeEvent<HTMLInputElement>) => field.onChange(e.target.value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))} placeholder="portal.yourcentre.ae" autoComplete="off" autoCapitalize="none" spellCheck={false} dir="ltr" autoFocus />}
            </FormField>
            {limit ? <PlanLimitAlert error={limit} /> : null}
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {t('adm.domains.add')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
