'use client';

import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { createReminderSchema, updateReminderSchema } from '@typease/validation';
import {
  Button, Checkbox, ChoiceLabel, DatePicker, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Form, FormError, FormField, Input, Label, RadioGroup,
  RadioGroupItem, useApi, useI18n, useToast, useZodForm,
} from '@typease/ui';
import { CorporateAccountPicker, CustomerPicker, DocumentTypePicker } from '@/components/pickers';
import type { Reminder } from '@/components/ops/types';
import { opsKeys } from '@/lib/keys/ops';

const COMMON = [90, 60, 30, 15, 7];
/** The shared schema, with its "customer or company" rule also reported on the company field (the one shown for a company schedule). */
const createSchema = createReminderSchema.superRefine((v, ctx) => {
  if (!v.customerId && !v.corporateAccountId) ctx.addIssue({ code: 'custom', path: ['corporateAccountId'], message: 'Required' });
});

/** Days before expiry on which a reminder goes out: the usual ones as tick boxes, plus any other number. */
function OffsetsEditor({ value, onChange, disabled }: { value: number[]; onChange: (value: number[]) => void; disabled?: boolean }) {
  const { t, formatNumber } = useI18n();
  const id = React.useId();
  const [custom, setCustom] = React.useState('');
  const all = [...new Set([...COMMON, ...value])].sort((a, b) => b - a);
  const toggle = (days: number, on: boolean) => onChange((on ? [...value, days] : value.filter((d) => d !== days)).sort((a, b) => b - a));
  const add = () => {
    const n = Number(custom);
    if (custom.trim() === '' || !Number.isInteger(n) || n < 0 || n > 730) return;
    if (!value.includes(n)) onChange([...value, n].sort((a, b) => b - a));
    setCustom('');
  };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-x-5 gap-y-2">
        {all.map((days) => (
          <ChoiceLabel
            key={days}
            htmlFor={`${id}-${days}`}
            control={<Checkbox id={`${id}-${days}`} checked={value.includes(days)} disabled={disabled} onCheckedChange={(on) => toggle(days, on === true)} />}
            label={days === 0 ? t('ops.reminders.onTheDay') : t('ops.reminders.offsetOption', { days: formatNumber(days) })}
          />
        ))}
      </div>
      <div className="flex items-end gap-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-custom`}>{t('ops.reminders.customOffset')}</Label>
          <Input
            id={`${id}-custom`}
            type="number"
            min={0}
            max={730}
            inputMode="numeric"
            dir="ltr"
            className="tabular w-32"
            value={custom}
            disabled={disabled}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
          />
        </div>
        <Button variant="outline" onClick={add} disabled={disabled || custom.trim() === ''}>
          <Plus aria-hidden="true" />
          {t('common.add')}
        </Button>
      </div>
    </div>
  );
}

/** Create a schedule (for a customer or a company), or change its label, expiry date and reminder days. */
export function ReminderDialog({ target, onClose, defaultCustomerId, defaultCustomerLabel }: { target: Reminder | 'new' | null; onClose: () => void; defaultCustomerId?: string; defaultCustomerLabel?: string | null }) {
  const existing = target && target !== 'new' ? target : null;
  return (
    <Dialog open={!!target} onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="lg">{target ? existing ? <EditForm reminder={existing} onClose={onClose} /> : <CreateForm onClose={onClose} defaultCustomerId={defaultCustomerId} defaultCustomerLabel={defaultCustomerLabel} /> : null}</DialogContent>
    </Dialog>
  );
}

function CreateForm({ onClose, defaultCustomerId, defaultCustomerLabel }: { onClose: () => void; defaultCustomerId?: string; defaultCustomerLabel?: string | null }) {
  const { t, today } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const id = React.useId();
  const [owner, setOwner] = React.useState<'customer' | 'company'>('customer');
  const form = useZodForm(createSchema, { defaultValues: { customerId: defaultCustomerId ?? '', corporateAccountId: '', documentTypeKey: '', subjectLabel: '', expiryDate: '', offsetsDays: [90, 60, 30, 15, 7] } });
  return (
    <Form
      form={form}
      className="flex min-h-0 flex-1 flex-col space-y-0"
      onSubmit={async (values) => {
        const created = await api.client.post<Reminder>('/reminders', { ...values, customerId: owner === 'customer' ? values.customerId : undefined, corporateAccountId: owner === 'company' ? values.corporateAccountId : undefined });
        toasts.success(t('ops.reminders.added'), t('ops.reminders.addedText', { name: created.subjectLabel }));
        await queryClient.invalidateQueries({ queryKey: opsKeys.reminders.all });
        onClose();
      }}
    >
      <DialogHeader>
        <DialogTitle>{t('ops.reminders.add')}</DialogTitle>
        <DialogDescription>{t('ops.reminders.addText')}</DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-5">
        <div className="space-y-2">
          <Label id={`${id}-owner`}>{t('ops.reminders.owner')}</Label>
          <RadioGroup
            value={owner}
            aria-labelledby={`${id}-owner`}
            className="flex flex-wrap gap-x-8 gap-y-2"
            onValueChange={(v) => {
              setOwner(v as 'customer' | 'company');
              form.setValue(v === 'customer' ? 'corporateAccountId' : 'customerId', '');
              form.clearErrors();
            }}
          >
            <ChoiceLabel htmlFor={`${id}-c`} control={<RadioGroupItem id={`${id}-c`} value="customer" />} label={t('ops.reminders.ownerCustomer')} />
            <ChoiceLabel htmlFor={`${id}-b`} control={<RadioGroupItem id={`${id}-b`} value="company" />} label={t('ops.reminders.ownerCompany')} />
          </RadioGroup>
        </div>
        {owner === 'customer' ? (
          <FormField name="customerId" label={t('ops.common.customer')} required>
            {(field) => <CustomerPicker {...field} value={field.value} selectedLabel={field.value === defaultCustomerId ? defaultCustomerLabel : undefined} onChange={(value) => field.onChange(value)} />}
          </FormField>
        ) : (
          <FormField name="corporateAccountId" label={t('ops.common.company')} required>
            {(field) => <CorporateAccountPicker {...field} value={field.value} onChange={(value) => field.onChange(value)} />}
          </FormField>
        )}
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <FormField name="documentTypeKey" label={t('ops.reminders.columns.type')} required>
            {(field) => <DocumentTypePicker {...field} value={field.value} onChange={(key) => field.onChange(key)} />}
          </FormField>
          <FormField name="expiryDate" label={t('ops.reminders.expiryDate')} required hint={t('ops.reminders.expiryDateHint')}>
            {(field) => <DatePicker {...field} min={today()} />}
          </FormField>
        </div>
        <FormField name="subjectLabel" label={t('ops.reminders.subjectLabel')} optional hint={t('ops.reminders.subjectLabelHint')}>
          {(field) => <Input {...field} dir="auto" autoComplete="off" />}
        </FormField>
        <FormField name="offsetsDays" label={t('ops.reminders.offsets')} hint={t('ops.reminders.offsetsHint')}>
          {(field) => <OffsetsEditor value={Array.isArray(field.value) ? field.value : []} onChange={field.onChange} />}
        </FormField>
        <FormError />
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
          {t('ops.reminders.add')}
        </Button>
      </DialogFooter>
    </Form>
  );
}

function EditForm({ reminder, onClose }: { reminder: Reminder; onClose: () => void }) {
  const { t, today } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const form = useZodForm(updateReminderSchema.pick({ subjectLabel: true, expiryDate: true, offsetsDays: true }), { defaultValues: { subjectLabel: reminder.subjectLabel, expiryDate: reminder.expiryDate, offsetsDays: reminder.offsetsDays } });
  const expiryChanged = form.watch('expiryDate') !== reminder.expiryDate;
  return (
    <Form
      form={form}
      className="flex min-h-0 flex-1 flex-col space-y-0"
      onSubmit={async (values) => {
        await api.client.patch(`/reminders/${reminder.id}`, values);
        toasts.success(t('ops.reminders.saved'));
        await queryClient.invalidateQueries({ queryKey: opsKeys.reminders.all });
        onClose();
      }}
    >
      <DialogHeader>
        <DialogTitle>{t('ops.reminders.editTitle')}</DialogTitle>
        <DialogDescription>{reminder.corporateName ?? reminder.customerName ?? ''}</DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-5">
        <FormField name="subjectLabel" label={t('ops.reminders.subjectLabel')} hint={t('ops.reminders.subjectLabelHint')}>
          {(field) => <Input {...field} dir="auto" autoComplete="off" />}
        </FormField>
        <FormField name="expiryDate" label={t('ops.reminders.expiryDate')} required hint={expiryChanged ? t('ops.reminders.expiryChangedHint') : t('ops.reminders.expiryDateHint')} className="sm:max-w-xs">
          {(field) => <DatePicker {...field} min={today()} />}
        </FormField>
        <FormField name="offsetsDays" label={t('ops.reminders.offsets')} hint={t('ops.reminders.offsetsHint')}>
          {(field) => <OffsetsEditor value={Array.isArray(field.value) ? field.value : []} onChange={field.onChange} />}
        </FormField>
        <FormError />
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
          {t('common.save')}
        </Button>
      </DialogFooter>
    </Form>
  );
}
