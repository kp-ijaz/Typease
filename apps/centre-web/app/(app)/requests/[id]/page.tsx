import * as React from 'react';
import { pageTitle } from '@/lib/metadata';
import { CasePage } from './case-page';

export const generateMetadata = () => pageTitle('cases.case.metaTitle');

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <React.Suspense fallback={null}>
      <CasePage id={id} />
    </React.Suspense>
  );
}
