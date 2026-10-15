'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Upload, X } from 'lucide-react';
import { Button, PageHeader, PermissionGate, RequirePermission, cn, focusRing, useApi, useI18n, useSession } from '@typease/ui';
import { CustomerPicker } from '@/components/pickers';
import { DocumentsTable } from '@/components/people/documents/documents-table';
import { UploadDocumentDialog } from '@/components/people/documents/upload-dialog';
import { useCustomerName } from '@/components/people/shared';
import type { CorporateAccountDetail } from '@/components/people/types';
import { peopleKeys } from '@/lib/keys/people';

interface Scope {
  customerId?: string;
  requestId?: string;
  corporateAccountId?: string;
}
const SCOPE_KEYS = ['customerId', 'requestId', 'corporateAccountId'] as const;

/** The owner filters of the vault (`/documents?customerId=&requestId=`), kept in the URL next to the table's own state. */
function useScope(): [Scope, boolean, (change: Partial<Scope>) => void] {
  const [scope, setScope] = React.useState<Scope>({});
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => {
    const read = () => {
      const params = new URLSearchParams(window.location.search);
      const next: Scope = {};
      for (const key of SCOPE_KEYS) {
        const value = params.get(key);
        if (value && /^[0-9a-f-]{36}$/i.test(value)) next[key] = value;
      }
      setScope(next);
      setReady(true);
    };
    read();
    window.addEventListener('popstate', read);
    return () => window.removeEventListener('popstate', read);
  }, []);
  const latest = React.useRef(scope);
  latest.current = scope;
  const update = React.useCallback((change: Partial<Scope>) => {
    const next: Scope = { ...latest.current, ...change };
    const url = new URL(window.location.href);
    for (const key of SCOPE_KEYS) {
      if (next[key]) url.searchParams.set(key, next[key] as string);
      else {
        url.searchParams.delete(key);
        delete next[key];
      }
    }
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    setScope(next);
  }, []);
  return [scope, ready, update];
}

function Chip({ label, onClear, clearLabel }: { label: React.ReactNode; onClear: () => void; clearLabel: string }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border bg-card py-1 pe-1 ps-3 text-sm text-foreground">
      <span className="truncate">{label}</span>
      <button type="button" onClick={onClear} aria-label={clearLabel} title={clearLabel} className={cn('inline-flex size-6 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground', focusRing)}>
        <X className="size-3.5" aria-hidden="true" />
      </button>
    </span>
  );
}

/** The document vault of the centre. */
export function DocumentsList() {
  return (
    <RequirePermission anyOf={['document.read']}>
      <Vault />
    </RequirePermission>
  );
}

function Vault() {
  const { t } = useI18n();
  const api = useApi();
  const session = useSession();
  const [scope, ready, setScope] = useScope();
  const [uploading, setUploading] = React.useState(false);

  const customer = useCustomerName(scope.customerId);
  const request = useQuery({
    queryKey: ['requests', 'number', scope.requestId],
    queryFn: () => api.client.get<{ id: string; requestNo: string }>(`/requests/${scope.requestId}`),
    enabled: !!scope.requestId,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const company = useQuery({
    queryKey: peopleKeys.corporate.detail(scope.corporateAccountId ?? ''),
    queryFn: () => api.client.get<CorporateAccountDetail>(`/corporate-accounts/${scope.corporateAccountId}`),
    enabled: !!scope.corporateAccountId && session.hasPermission('corporate.read'),
    staleTime: 60_000,
    retry: false,
  });

  const upload = (
    <PermissionGate permission="document.upload">
      <Button variant="accent" onClick={() => setUploading(true)}>
        <Upload aria-hidden="true" />
        {t('people.documents.upload.action')}
      </Button>
    </PermissionGate>
  );
  const scoped = !!(scope.customerId || scope.requestId || scope.corporateAccountId);

  return (
    <>
      <PageHeader title={t('nav.documents')} description={t('people.documents.description')} action={upload} />

      {scoped ? (
        <div className="mb-4 flex flex-wrap items-center gap-2" aria-label={t('people.documents.filters.showing')}>
          <span className="text-sm text-muted-foreground">{t('people.documents.filters.showing')}</span>
          {scope.customerId ? <Chip label={t('people.documents.filters.customerChip', { name: customer.data ? `${customer.data.fullName} (${customer.data.customerNo})` : '…' })} onClear={() => setScope({ customerId: undefined })} clearLabel={t('people.documents.filters.clearCustomer')} /> : null}
          {scope.requestId ? <Chip label={t('people.documents.filters.requestChip', { number: request.data?.requestNo ?? '…' })} onClear={() => setScope({ requestId: undefined })} clearLabel={t('people.documents.filters.clearRequest')} /> : null}
          {scope.corporateAccountId ? <Chip label={t('people.documents.filters.companyChip', { name: company.data?.companyName ?? '…' })} onClear={() => setScope({ corporateAccountId: undefined })} clearLabel={t('people.documents.filters.clearCompany')} /> : null}
        </div>
      ) : null}

      {ready ? (
        <DocumentsTable
          queryKey={peopleKeys.documents.all}
          fixedParams={scope as Record<string, string | undefined>}
          toolbar={
            session.hasPermission('customer.read') ? (
              <div className="w-56 sm:w-64">
                <CustomerPicker aria-label={t('people.documents.filters.customer')} placeholder={t('people.documents.filters.customer')} value={scope.customerId ?? ''} selectedLabel={customer.data?.fullName} onChange={(id) => setScope({ customerId: id || undefined })} />
              </div>
            ) : undefined
          }
          emptyAction={upload}
        />
      ) : null}

      {uploading ? (
        <UploadDocumentDialog
          open
          onOpenChange={setUploading}
          owner={{ customerId: scope.customerId, customerName: customer.data?.fullName, corporateAccountId: scope.corporateAccountId, corporateName: company.data?.companyName, requestId: scope.requestId }}
        />
      ) : null}
    </>
  );
}
