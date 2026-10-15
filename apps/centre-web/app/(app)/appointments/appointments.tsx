'use client';

import * as React from 'react';
import { CalendarPlus, MapPinOff } from 'lucide-react';
import { Button, Card, EmptyState, PageHeader, PermissionGate, RequirePermission, Skeleton, Tabs, TabsContent, TabsList, TabsTrigger, useI18n } from '@typease/ui';
import { useUrlParam, useUrlState } from '@/components/ops/common';
import { WorkBranchSelect, useWorkBranch } from '@/components/ops/work-branch';
import { Agenda } from './agenda';
import { BookingDialog } from './booking-dialog';
import { CalendarSettings } from './calendar-settings';

export function Appointments() {
  return (
    <RequirePermission anyOf={['appointment.read', 'appointment.manage']}>
      <AppointmentsPage />
    </RequirePermission>
  );
}

/** Booked visits of one branch (day or week), and the branch calendar they are booked into. */
function AppointmentsPage() {
  const { t } = useI18n();
  const work = useWorkBranch();
  const [tab, setTab] = useUrlState('tab', 'agenda');
  const customerId = useUrlParam('customerId');
  const [booking, setBooking] = React.useState(false);

  return (
    <>
      <PageHeader
        title={t('ops.appointments.title')}
        description={t('ops.appointments.description')}
        secondary={<WorkBranchSelect work={work} />}
        action={
          <PermissionGate permission="appointment.manage">
            <Button variant="accent" onClick={() => setBooking(true)} disabled={!work.branchId}>
              <CalendarPlus aria-hidden="true" />
              {t('ops.appointments.book')}
            </Button>
          </PermissionGate>
        }
      />
      {work.isLoading ? (
        <Skeleton className="h-72 w-full" />
      ) : !work.branchId ? (
        <Card>
          <EmptyState size="page" icon={<MapPinOff />} title={t('ops.common.noBranchTitle')} description={t('ops.common.noBranchText')} />
        </Card>
      ) : (
        <Tabs value={tab === 'settings' ? 'settings' : 'agenda'} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="agenda">{t('ops.appointments.tabs.agenda')}</TabsTrigger>
            <TabsTrigger value="settings">{t('ops.appointments.tabs.settings')}</TabsTrigger>
          </TabsList>
          <TabsContent value="agenda">
            <Agenda branchId={work.branchId} customerId={customerId} onBook={() => setBooking(true)} />
          </TabsContent>
          <TabsContent value="settings">
            <CalendarSettings branchId={work.branchId} />
          </TabsContent>
        </Tabs>
      )}
      <BookingDialog open={booking} onOpenChange={setBooking} branchId={work.branchId} branches={work.branches} customerId={customerId} />
    </>
  );
}
