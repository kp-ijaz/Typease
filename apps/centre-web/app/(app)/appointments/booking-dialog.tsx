'use client';

import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { createAppointmentSchema } from '@typease/validation';
import type { BranchSummary } from '@typease/api-client';
import {
  Button, ChoiceLabel, DatePicker, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Form, FormError, FormField, Input, Label, PhoneInput,
  RadioGroup, RadioGroupItem, Select, Textarea, useApi, useI18n, useToast, useZodForm,
} from '@typease/ui';
import { CustomerPicker, ServicePicker, StaffPicker } from '@/components/pickers';
import type { Appointment } from '@/components/ops/types';
import { opsKeys } from '@/lib/keys/ops';
import { SlotPicker } from './slot-picker';

/** The shared schema, with its "customer or visitor name" rule also reported on the visitor's name (the field a guest booking shows). */
const schema = createAppointmentSchema.superRefine((v, ctx) => {
  if (!v.customerId && !v.guestName) ctx.addIssue({ code: 'custom', path: ['guestName'], message: 'Required' });
});

/**
 * Books an appointment for a customer on file or for a guest (name and phone): service,
 * branch, day, a free slot from the availability endpoint, optionally a member of staff.
 */
export function BookingDialog({ open, onOpenChange, branchId, branches, customerId }: { open: boolean; onOpenChange: (open: boolean) => void; branchId: string | undefined; branches: BranchSummary[]; customerId?: string }) {
  const { t, pick, today, formatDate } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const id = React.useId();
  const form = useZodForm(schema);
  const [who, setWho] = React.useState<'customer' | 'guest'>('customer');
  const [date, setDate] = React.useState(today());

  React.useEffect(() => {
    if (open) {
      setWho('customer');
      setDate(today());
      form.reset({ branchId: branchId ?? '', customerId: customerId ?? '', guestName: '', guestPhone: '', serviceId: '', staffId: '', startsAt: '', notes: '' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const branch = form.watch('branchId');
  const service = form.watch('serviceId');
  const staff = form.watch('staffId');
  /** A change of branch, day, service or staff member changes the free slots: the chosen slot is dropped. */
  const resetSlot = () => form.setValue('startsAt', '');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <Form
          form={form}
          className="flex min-h-0 flex-1 flex-col space-y-0"
          onSubmit={async (values) => {
            const body = who === 'customer' ? { ...values, guestName: undefined, guestPhone: undefined } : { ...values, customerId: undefined };
            try {
              const created = await api.client.post<Appointment>('/appointments', body);
              toasts.success(t('ops.appointments.booked'), t('ops.appointments.bookedText', { name: created.customerName ?? created.guestName ?? '', date: formatDate(created.localDate, 'long'), time: created.localTime }));
              await queryClient.invalidateQueries({ queryKey: opsKeys.appointments.all });
              onOpenChange(false);
            } catch (error) {
              // Someone else may have taken the slot in the meantime: show what is free now.
              await queryClient.invalidateQueries({ queryKey: [...opsKeys.appointments.all, 'availability'] });
              throw error;
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('ops.appointments.book')}</DialogTitle>
            <DialogDescription>{t('ops.appointments.bookText')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            <div className="space-y-2">
              <Label id={`${id}-who`}>{t('ops.appointments.fields.who')}</Label>
              <RadioGroup
                value={who}
                onValueChange={(v) => {
                  setWho(v as 'customer' | 'guest');
                  // Only one of the two is sent: the other one is emptied.
                  if (v === 'guest') form.setValue('customerId', '');
                  else {
                    form.setValue('guestName', '');
                    form.setValue('guestPhone', '');
                  }
                  form.clearErrors();
                }} aria-labelledby={`${id}-who`} className="flex flex-wrap gap-x-8 gap-y-2">
                <ChoiceLabel htmlFor={`${id}-customer`} control={<RadioGroupItem id={`${id}-customer`} value="customer" />} label={t('ops.appointments.whoCustomer')} />
                <ChoiceLabel htmlFor={`${id}-guest`} control={<RadioGroupItem id={`${id}-guest`} value="guest" />} label={t('ops.appointments.whoGuest')} />
              </RadioGroup>
            </div>

            {who === 'customer' ? (
              <FormField name="customerId" label={t('ops.common.customer')} required>
                {(field) => <CustomerPicker {...field} value={field.value} onChange={(value) => field.onChange(value)} />}
              </FormField>
            ) : (
              <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                <FormField name="guestName" label={t('ops.appointments.fields.guestName')} required>
                  {(field) => <Input {...field} autoComplete="off" dir="auto" />}
                </FormField>
                <FormField name="guestPhone" label={t('ops.appointments.fields.guestPhone')} hint={t('ops.appointments.fields.guestPhoneHint')}>
                  {(field) => <PhoneInput {...field} />}
                </FormField>
              </div>
            )}

            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              <FormField name="serviceId" label={t('ops.appointments.fields.service')} optional>
                {(field) => (
                  <ServicePicker
                    {...field}
                    value={field.value}
                    clearable
                    onChange={(value) => {
                      field.onChange(value);
                      resetSlot();
                    }}
                  />
                )}
              </FormField>
              {branches.length > 1 ? (
                <FormField name="branchId" label={t('ops.common.branch')} required>
                  {(field) => (
                    <Select
                      {...field}
                      onValueChange={(value) => {
                        field.onChange(value);
                        resetSlot();
                      }}
                      options={branches.map((b) => ({ value: b.id, label: pick(b.name, b.nameAr) }))}
                    />
                  )}
                </FormField>
              ) : null}
              <div className="space-y-1.5">
                <Label htmlFor={`${id}-date`} required>
                  {t('ops.common.date')}
                </Label>
                <DatePicker
                  id={`${id}-date`}
                  value={date}
                  min={today()}
                  onChange={(v) => {
                    if (!v) return;
                    setDate(v);
                    resetSlot();
                  }}
                />
              </div>
              <FormField name="staffId" label={t('ops.appointments.fields.staff')} optional>
                {(field) => (
                  <StaffPicker
                    {...field}
                    value={field.value}
                    branchId={branch || undefined}
                    onChange={(value) => {
                      field.onChange(value);
                      resetSlot();
                    }}
                  />
                )}
              </FormField>
            </div>

            <FormField name="startsAt" label={t('ops.appointments.fields.slot')} required>
              {(field) => <SlotPicker id={field.id} aria-describedby={field['aria-describedby']} branchId={branch || undefined} date={date} serviceId={service} staffId={staff} value={field.value} onChange={field.onChange} />}
            </FormField>

            <FormField name="notes" label={t('ops.appointments.fields.notes')} optional hint={t('ops.appointments.fields.notesHint')}>
              {(field) => <Textarea {...field} rows={2} dir="auto" />}
            </FormField>
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {t('ops.appointments.book')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
