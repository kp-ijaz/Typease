import * as React from 'react';
import { pageTitle } from '@/lib/metadata';
import { RequestWizard } from './request-wizard';

export const generateMetadata = () => pageTitle('requests.new');

export default function Page() {
  return (
    <React.Suspense fallback={null}>
      <RequestWizard />
    </React.Suspense>
  );
}
