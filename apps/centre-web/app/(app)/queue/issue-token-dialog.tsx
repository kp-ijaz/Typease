'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { issueTokenSchema } from '@typease/validation';
import {
  Button, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Form, FormError, FormField, Select, useApi, useI18n, useSession, useToast,
  useZodForm,
} from '@typease/ui';
import { CustomerPicker } from '@/components/pickers';
import type { QueueToken, ServiceCategory } from '@/components/ops/types';
import { opsKeys } from '@/lib/keys/ops';

const ANY = '__any__';

/** Issues a walk-in token: the service category decides the letter of the number; the customer is optional. */
export function IssueTokenDialog({ open, onOpenChange, branchId }: { open: boolean; onOpenChange: (open: boolean) => void; branchId: string | undefined }) {
  const { t, pick } = useI18n();
  const api = useApi();
  const session = useSession();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const form = useZodForm(issueTokenSchema);
  const [issued, setIssued] = React.useState<QueueToken | null>(null);
  const categories = useQuery({
    queryKey: opsKeys.categories.list(false),
    queryFn: () => api.client.get<ServiceCategory[]>('/service-categories'),
    enabled: open && session.hasPermission('service.read'),
    staleTime: 5 * 60_000,
  });

  React.useEffect(() => {
    if (open) {
      setIssued(null);
      form.reset({ branchId: branchId ?? '', categoryId: '', customerId: '' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, branchId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        {issued ? (
          <>
            <DialogHeader>
              <DialogTitle>{t('ops.queue.issuedTitle')}</DialogTitle>
              <DialogDescription>{t('ops.queue.issuedText')}</DialogDescription>
            </DialogHeader>
            <DialogBody className="text-center">
              <p className="ltr-value tabular text-5xl font-bold text-foreground" aria-live="polite">
                {issued.tokenNo}
              </p>
              <p className="mt-2 text-base text-muted-foreground">{[issued.categoryName, issued.customerName].filter(Boolean).join(' · ')}</p>
            </DialogBody>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t('common.done')}
              </Button>
              <Button
                onClick={() => {
                  setIssued(null);
                  form.reset({ branchId: branchId ?? '', categoryId: form.getValues('categoryId'), customerId: '' });
                }}
              >
                {t('ops.queue.issueAnother')}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <Form
            form={form}
            className="flex min-h-0 flex-1 flex-col space-y-0"
            onSubmit={async (values) => {
              const token = await api.client.post<QueueToken>('/queue/tokens', values);
              toasts.success(t('ops.queue.issued', { token: token.tokenNo }));
              await queryClient.invalidateQueries({ queryKey: opsKeys.queue.all });
              setIssued(token);
            }}
          >
            <DialogHeader>
              <DialogTitle>{t('ops.queue.issue')}</DialogTitle>
              <DialogDescription>{t('ops.queue.issueText')}</DialogDescription>
            </DialogHeader>
            <DialogBody className="space-y-5">
              <FormField name="categoryId" label={t('ops.queue.category')}>
                {(field) => (
                  <Select
                    {...field}
                    value={field.value || ANY}
                    onValueChange={(v) => field.onChange(v === ANY ? '' : v)}
                    options={[{ value: ANY, label: t('ops.queue.categoryAny') }, ...(categories.data ?? []).map((c) => ({ value: c.id, label: pick(c.name, c.nameAr) }))]}
                  />
                )}
              </FormField>
              {session.hasPermission('customer.read') ? (
                <FormField name="customerId" label={t('ops.common.customer')} optional hint={t('ops.queue.customerHint')}>
                  {(field) => <CustomerPicker {...field} value={field.value} onChange={(value) => field.onChange(value)} />}
                </FormField>
              ) : null}
              <FormError />
            </DialogBody>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
                {t('ops.queue.issue')}
              </Button>
            </DialogFooter>
          </Form>
        )}
      </DialogContent>
    </Dialog>
  );
}
