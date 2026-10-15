'use client';

import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { branchSchema } from '@typease/validation';
import {
  Button, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Form, FormError, FormField, FormSection, Input, PhoneInput, Select, Textarea,
  useApi, useI18n, useToast, useZodForm,
} from '@typease/ui';
import { admKeys } from '@/lib/keys/adm';
import { PlanLimitAlert, SettingSwitch, WorkingHoursEditor, isPlanLimit, useEmirateOptions, workingHoursValid } from './shared';
import type { BranchRow, WorkingHours } from './types';

const schema = branchSchema.omit({ workingHours: true, isActive: true });
const DEFAULT_HOURS: WorkingHours = { '0': { open: '09:00', close: '18:00' }, '1': { open: '09:00', close: '18:00' }, '2': { open: '09:00', close: '18:00' }, '3': { open: '09:00', close: '18:00' }, '4': { open: '09:00', close: '18:00' }, '5': null, '6': { open: '09:00', close: '18:00' } };
const EMPTY = { code: '', name: '', nameAr: '', address: '', emirate: '', phone: '', email: '', isHeadOffice: false };

/** Add or edit a branch (POST /branches, PATCH /branches/:id). The plan limit (402) is explained in place. */
export function BranchDialog({ open, onOpenChange, branch, first }: { open: boolean; onOpenChange: (open: boolean) => void; branch: BranchRow | null; first?: boolean }) {
  const { t } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const emirates = useEmirateOptions();
  const form = useZodForm(schema, { emptyAs: 'null', defaultValues: EMPTY });
  const [hours, setHours] = React.useState<WorkingHours>(DEFAULT_HOURS);
  const [limit, setLimit] = React.useState<unknown>(null);
  const headId = React.useId();

  React.useEffect(() => {
    if (!open) return;
    setLimit(null);
    if (branch) {
      form.reset({ code: branch.code, name: branch.name, nameAr: branch.nameAr ?? '', address: branch.address ?? '', emirate: branch.emirate ?? '', phone: branch.phone ?? '', email: branch.email ?? '', isHeadOffice: branch.isHeadOffice });
      setHours(branch.workingHours ?? {});
    } else {
      form.reset({ ...EMPTY, isHeadOffice: !!first });
      setHours(DEFAULT_HOURS);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, branch]);

  const isHeadOffice = form.watch('isHeadOffice');
  const hoursOk = workingHoursValid(hours);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <Form
          form={form}
          className="flex min-h-0 flex-1 flex-col space-y-0"
          onSubmit={async (values) => {
            setLimit(null);
            if (!hoursOk) return;
            const body = { ...values, workingHours: hours };
            try {
              if (branch) {
                // "Head office" can only be moved TO a branch; the API refuses to simply remove it.
                const { isHeadOffice: head, ...rest } = body;
                await api.client.patch(`/branches/${branch.id}`, { ...rest, ...(head && !branch.isHeadOffice ? { isHeadOffice: true } : {}) });
                toasts.success(t('adm.branches.saved'), values.name);
              } else {
                await api.client.post('/branches', body);
                toasts.success(t('adm.branches.added'), values.name);
              }
              await queryClient.invalidateQueries({ queryKey: admKeys.branches.all });
              await queryClient.invalidateQueries({ queryKey: admKeys.tenant.usage });
              onOpenChange(false);
            } catch (error) {
              if (isPlanLimit(error)) {
                setLimit(error);
                return;
              }
              throw error;
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{branch ? t('adm.branches.editTitle', { name: branch.name }) : t('adm.branches.addTitle')}</DialogTitle>
            <DialogDescription>{t('adm.branches.dialogText')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-6">
            <div className="grid gap-5 sm:grid-cols-2">
              <FormField name="name" label={t('adm.branches.fields.name')} required>
                {(field) => <Input {...field} autoComplete="off" dir="ltr" lang="en" autoFocus={!branch} />}
              </FormField>
              <FormField name="nameAr" label={t('adm.branches.fields.nameAr')} optional>
                {(field) => <Input {...field} autoComplete="off" dir="rtl" lang="ar" />}
              </FormField>
              <FormField name="code" label={t('adm.branches.fields.code')} required hint={t('adm.branches.fields.codeHint')}>
                {(field) => <Input {...field} onChange={(e: React.ChangeEvent<HTMLInputElement>) => field.onChange(e.target.value.toUpperCase())} autoComplete="off" dir="ltr" className="tabular sm:max-w-40" maxLength={12} />}
              </FormField>
              <FormField name="emirate" label={t('adm.branches.fields.emirate')}>
                {(field) => <Select {...field} onValueChange={field.onChange} options={emirates} placeholder={t('common.selectPlaceholder')} />}
              </FormField>
              <FormField name="address" label={t('adm.branches.fields.address')} className="sm:col-span-2">
                {(field) => <Textarea {...field} rows={2} dir="auto" />}
              </FormField>
            </div>

            <FormSection title={t('adm.branches.contact')}>
              <div className="grid gap-5 sm:grid-cols-2">
                <FormField name="phone" label={t('adm.branches.fields.phone')}>
                  {(field) => <PhoneInput {...field} />}
                </FormField>
                <FormField name="email" label={t('adm.branches.fields.email')}>
                  {(field) => <Input {...field} type="email" inputMode="email" autoComplete="off" autoCapitalize="none" spellCheck={false} dir="ltr" />}
                </FormField>
              </div>
            </FormSection>

            <FormSection title={t('adm.branches.hours')} description={t('adm.branches.hoursText')}>
              <WorkingHoursEditor value={hours} onChange={setHours} />
            </FormSection>

            <div className="rounded-lg border p-4">
              <SettingSwitch
                id={headId}
                label={t('adm.branches.fields.headOffice')}
                description={branch?.isHeadOffice ? t('adm.branches.headOfficeFixed') : t('adm.branches.headOfficeText')}
                checked={!!isHeadOffice}
                disabled={!!branch?.isHeadOffice || (!!branch && !branch.isActive)}
                onCheckedChange={(checked) => form.setValue('isHeadOffice', checked, { shouldDirty: true })}
              />
            </div>

            {limit ? <PlanLimitAlert error={limit} /> : null}
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={!hoursOk} loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {branch ? t('common.saveChanges') : t('adm.branches.add')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
