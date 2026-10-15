'use client';

import * as React from 'react';
import Link from 'next/link';
import { FolderOpen, Upload } from 'lucide-react';
import { Button, PermissionGate, useI18n } from '@typease/ui';
import { peopleKeys } from '@/lib/keys/people';
import { DocumentsTable } from '../documents/documents-table';
import { UploadDocumentDialog } from '../documents/upload-dialog';
import type { CustomerOverview } from '../types';

/** Documents of one customer: the vault list filtered by `customerId`, with upload for this customer. */
export function CustomerDocumentsTab({ customer }: { customer: CustomerOverview }) {
  const { t } = useI18n();
  const [uploading, setUploading] = React.useState(false);
  const upload =
    customer.status === 'ACTIVE' ? (
      <PermissionGate permission="document.upload">
        <Button variant="outline" onClick={() => setUploading(true)}>
          <Upload aria-hidden="true" />
          {t('people.documents.upload.action')}
        </Button>
      </PermissionGate>
    ) : null;
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <p className="max-w-2xl text-base text-muted-foreground">{t('people.customer.tabs.documentsText')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="ghost">
            <Link href={`/documents?customerId=${customer.id}`}>
              <FolderOpen aria-hidden="true" />
              {t('people.customer.tabs.openVault')}
            </Link>
          </Button>
          {upload}
        </div>
      </div>
      <DocumentsTable scope="owner" syncUrl={false} queryKey={[...peopleKeys.documents.all, 'customer', customer.id]} fixedParams={{ customerId: customer.id }} emptyAction={upload} emptyText={t('people.customer.tabs.documentsEmptyText')} />
      {uploading ? <UploadDocumentDialog open onOpenChange={setUploading} owner={{ customerId: customer.id, customerName: customer.fullName }} lockOwner /> : null}
    </>
  );
}
