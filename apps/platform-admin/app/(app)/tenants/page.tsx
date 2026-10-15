import * as React from 'react';
import { pageTitle } from '@/lib/metadata';
import { Tenants } from './tenants';

export const generateMetadata = () => pageTitle('nav.tenants');

export default function Page() {
  return (
    <React.Suspense fallback={null}>
      <Tenants />
    </React.Suspense>
  );
}
