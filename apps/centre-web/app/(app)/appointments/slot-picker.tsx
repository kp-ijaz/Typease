'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Skeleton, cn, useApi, useErrorMessage, useI18n } from '@typease/ui';
import type { Availability } from '@/components/ops/types';
import { opsKeys } from '@/lib/keys/ops';

/**
 * The free slots of one branch day, from the availability endpoint. Full or past slots are shown
 * but cannot be chosen; a closed day says why. The value is the slot's `startsAt` (ISO, as the API expects).
 */
export function SlotPicker({ branchId, date, serviceId, staffId, value, onChange, id, 'aria-describedby': describedBy }: {
  branchId: string | undefined;
  date: string;
  serviceId?: string | null;
  staffId?: string | null;
  value: string | null | undefined;
  onChange: (startsAt: string) => void;
  id?: string;
  'aria-describedby'?: string;
}) {
  const { t, tn, formatDate } = useI18n();
  const api = useApi();
  const describe = useErrorMessage();
  const params = { branchId, date, serviceId: serviceId || undefined, staffId: staffId || undefined };
  const availability = useQuery({
    queryKey: opsKeys.appointments.availability(params),
    queryFn: () => api.client.get<Availability>('/appointments/availability', { query: params }),
    enabled: !!branchId && !!date,
    staleTime: 15_000,
  });

  if (!branchId || !date) return <p className="text-sm text-muted-foreground">{t('ops.appointments.slots.chooseFirst')}</p>;
  if (availability.isPending) return <Skeleton className="h-24 w-full" />;
  if (availability.isError) {
    return (
      <Alert
        tone="danger"
        action={
          <Button size="sm" variant="outline" onClick={() => void availability.refetch()}>
            {t('common.retry')}
          </Button>
        }
      >
        {describe(availability.error)}
      </Alert>
    );
  }
  const data = availability.data;
  if (data.closed) return <Alert tone="warning">{data.closedReason ? t('ops.appointments.slots.closedReason', { reason: data.closedReason }) : t('ops.appointments.slots.closed')}</Alert>;
  if (date > data.bookableUntil) return <Alert tone="warning">{t('ops.appointments.slots.tooFar', { date: formatDate(data.bookableUntil) })}</Alert>;
  if (data.slots.length === 0) return <Alert tone="info">{t('ops.appointments.slots.none')}</Alert>;
  const anyFree = data.slots.some((s) => s.available);

  return (
    <div id={id} role="radiogroup" aria-describedby={describedBy} aria-label={t('ops.appointments.slots.label')} className="space-y-2">
      {anyFree ? null : <Alert tone="warning">{t('ops.appointments.slots.full')}</Alert>}
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
        {data.slots.map((slot) => {
          const selected = value === slot.startsAt;
          return (
            <button
              key={slot.startsAt}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={!slot.available}
              onClick={() => onChange(slot.startsAt)}
              title={slot.available ? tn('ops.appointments.slots.remaining', slot.remaining) : t('ops.appointments.slots.taken')}
              className={cn(
                'tabular rounded-md border px-2 py-2 text-center text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                selected ? 'border-secondary bg-secondary text-secondary-foreground' : 'bg-card hover:bg-muted',
                !slot.available && 'cursor-not-allowed bg-muted text-muted-foreground line-through opacity-60 hover:bg-muted',
              )}
            >
              <span dir="ltr">{slot.localStart}</span>
            </button>
          );
        })}
      </div>
      <p className="text-sm text-muted-foreground">{t('ops.appointments.slots.hint', { timezone: data.timezone })}</p>
    </div>
  );
}
