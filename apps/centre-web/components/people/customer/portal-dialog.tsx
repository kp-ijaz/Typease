'use client';

import { useQueryClient } from '@tanstack/react-query';
import { inviteCustomerPortalSchema } from '@typease/validation';
import { Alert, Button, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Form, FormError, FormField, Input, useApi, useI18n, useToast, useZodForm } from '@typease/ui';
import { peopleKeys } from '@/lib/keys/people';
import type { CustomerOverview } from '../types';

/**
 * Sends (or sends again) the invitation to the customer portal. The customer sets a password through the
 * emailed link and then sees this record with its history. Sending again makes the earlier link stop working.
 */
export function PortalInvitationDialog({ customer, open, onOpenChange }: { customer: CustomerOverview; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const again = customer.portalAccess.status === 'INVITED';
  const form = useZodForm(inviteCustomerPortalSchema, { defaultValues: { email: customer.portalAccess.email ?? customer.email ?? '' } });

  const send = async (values: { email?: string }) => {
    const result = await api.client.post<{ email: string }>(`/customers/${customer.id}/portal-invitation`, values);
    toasts.success(t('people.customer.portal.sent'), t('people.customer.portal.sentTo', { email: result.email }));
    await queryClient.invalidateQueries({ queryKey: peopleKeys.customers.all });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <Form form={form} onSubmit={send} className="flex min-h-0 flex-1 flex-col space-y-0">
          <DialogHeader>
            <DialogTitle>{again ? t('people.customer.portal.resendTitle') : t('people.customer.portal.inviteTitle')}</DialogTitle>
            <DialogDescription>{t('people.customer.portal.inviteText')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            <FormField name="email" label={t('customers.form.email')} required hint={customer.email ? undefined : t('people.customer.portal.emailHint')}>
              {(field) => <Input {...field} type="email" inputMode="email" autoComplete="off" autoCapitalize="none" spellCheck={false} dir="ltr" />}
            </FormField>
            {again ? <Alert tone="info">{t('people.customer.portal.resendNote')}</Alert> : null}
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.loading')}>
              {again ? t('people.customer.portal.resend') : t('people.customer.portal.invite')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
