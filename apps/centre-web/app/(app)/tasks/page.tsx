import * as React from 'react';
import { pageTitle } from '@/lib/metadata';
import { TasksPage } from './tasks-page';

export const generateMetadata = () => pageTitle('nav.tasks');

export default function Page() {
  return (
    <React.Suspense fallback={null}>
      <TasksPage />
    </React.Suspense>
  );
}
