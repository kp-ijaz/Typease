'use client';

import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Mail, MessageCircle, MoreHorizontal, Pencil, Phone, Plus, Star, Trash2 } from 'lucide-react';
import { customerContactSchema } from '@typease/validation';
import {
  Badge, Button, ConfirmDialog, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, Form,
  FormError, FormField, Input, PhoneInput, Select, formatPhone, useApi, useI18n, useSession, useToast, useZodForm,
} from '@typease/ui';
import { peopleKeys } from '@/lib/keys/people';
import { BooleanField } from '../form-bits';
import { Ltr, Section } from '../shared';
import type { ContactType, CustomerContact, CustomerOverview } from '../types';

const ICONS: Record<ContactType, typeof Mail> = { EMAIL: Mail, PHONE: Phone, WHATSAPP: MessageCircle };
const TYPES: ContactType[] = ['PHONE', 'WHATSAPP', 'EMAIL'];

/** Main mobile and email of the profile, plus the additional contacts (one primary per type). */
export function ContactsCard({ customer, readOnly }: { customer: CustomerOverview; readOnly: boolean }) {
  const { t } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const session = useSession();
  const queryClient = useQueryClient();
  const canWrite = !readOnly && session.hasPermission('customer.update');
  const [editing, setEditing] = React.useState<CustomerContact | 'new' | null>(null);
  const [deleting, setDeleting] = React.useState<CustomerContact | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: peopleKeys.customers.detail(customer.id) });
  const makePrimary = useMutation({
    mutationFn: (contact: CustomerContact) => api.client.patch<CustomerContact>(`/customers/${customer.id}/contacts/${contact.id}`, { isPrimary: true }),
    onSuccess: async () => {
      toasts.success(t('people.customer.contacts.madePrimary'));
      await refresh();
    },
    onError: (error) => toasts.error(error),
  });
  const remove = async (contact: CustomerContact) => {
    try {
      await api.client.delete(`/customers/${customer.id}/contacts/${contact.id}`);
      toasts.success(t('people.customer.contacts.deleted'));
      await refresh();
    } catch (error) {
      toasts.error(error);
      throw error;
    }
  };

  const value = (contact: Pick<CustomerContact, 'type' | 'value'>) => <Ltr className="block truncate">{contact.type === 'EMAIL' ? contact.value : formatPhone(contact.value)}</Ltr>;

  return (
    <Section
      title={t('people.customer.contacts.title')}
      action={
        canWrite ? (
          <Button variant="outline" size="sm" onClick={() => setEditing('new')}>
            <Plus aria-hidden="true" />
            {t('people.customer.contacts.add')}
          </Button>
        ) : null
      }
    >
      <ul className="space-y-3">
        <li className="flex items-start gap-3">
          <Phone className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-sm text-muted-foreground">{t('people.customer.contacts.mainMobile')}</p>
            {customer.phone ? value({ type: 'PHONE', value: customer.phone }) : <p className="text-base text-muted-foreground">{t('common.notSet')}</p>}
          </div>
        </li>
        <li className="flex items-start gap-3">
          <Mail className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-sm text-muted-foreground">{t('people.customer.contacts.mainEmail')}</p>
            {customer.email ? value({ type: 'EMAIL', value: customer.email }) : <p className="text-base text-muted-foreground">{t('common.notSet')}</p>}
          </div>
        </li>
        {customer.contacts.map((contact) => {
          const Icon = ICONS[contact.type] ?? Phone;
          return (
            <li key={contact.id} className="flex items-start gap-3 border-t pt-3">
              <Icon className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                  <span>{t(`people.customer.contacts.types.${contact.type}`)}</span>
                  {contact.label ? <span dir="auto">· {contact.label}</span> : null}
                  {contact.isPrimary ? <Badge tone="info">{t('people.customer.contacts.primary')}</Badge> : null}
                </p>
                {value(contact)}
              </div>
              {canWrite ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label={t('common.moreActions')}>
                      <MoreHorizontal aria-hidden="true" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent>
                    <DropdownMenuItem onSelect={() => setEditing(contact)}>
                      <Pencil aria-hidden="true" />
                      {t('common.edit')}
                    </DropdownMenuItem>
                    {contact.isPrimary ? null : (
                      <DropdownMenuItem onSelect={() => makePrimary.mutate(contact)}>
                        <Star aria-hidden="true" />
                        {t('people.customer.contacts.makePrimary')}
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem destructive onSelect={() => setDeleting(contact)}>
                      <Trash2 aria-hidden="true" />
                      {t('common.delete')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </li>
          );
        })}
      </ul>

      {editing ? <ContactDialog customerId={customer.id} contact={editing === 'new' ? null : editing} open onOpenChange={(next) => !next && setEditing(null)} onSaved={refresh} /> : null}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(next) => !next && setDeleting(null)}
        title={t('people.customer.contacts.deleteTitle')}
        description={t('people.customer.contacts.deleteText')}
        confirmLabel={t('common.delete')}
        onConfirm={() => (deleting ? remove(deleting) : undefined)}
      />
    </Section>
  );
}

function ContactDialog({ customerId, contact, open, onOpenChange, onSaved }: { customerId: string; contact: CustomerContact | null; open: boolean; onOpenChange: (open: boolean) => void; onSaved: () => Promise<void> }) {
  const { t } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const form = useZodForm(customerContactSchema, { defaultValues: { type: contact?.type ?? 'PHONE', value: contact?.value ?? '', label: contact?.label ?? '', isPrimary: contact?.isPrimary ?? false }, emptyAs: 'null' });
  const type = form.watch('type');

  const save = async (values: { type: ContactType; value: string; label?: string | null; isPrimary: boolean }) => {
    if (contact) {
      // The type of a contact cannot change; the primary flag can only be switched on (the API promotes / demotes the others).
      await api.client.patch(`/customers/${customerId}/contacts/${contact.id}`, { value: values.value, label: values.label ?? null, ...(values.isPrimary && !contact.isPrimary ? { isPrimary: true } : {}) });
      toasts.success(t('people.customer.contacts.saved'));
    } else {
      await api.client.post(`/customers/${customerId}/contacts`, values);
      toasts.success(t('people.customer.contacts.added'));
    }
    await onSaved();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <Form form={form} onSubmit={save} className="flex min-h-0 flex-1 flex-col space-y-0">
          <DialogHeader>
            <DialogTitle>{contact ? t('people.customer.contacts.editTitle') : t('people.customer.contacts.addTitle')}</DialogTitle>
            <DialogDescription>{t('people.customer.contacts.dialogText')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            <FormField name="type" label={t('people.customer.contacts.type')}>
              {(field) => (
                <Select
                  {...field}
                  disabled={!!contact}
                  onValueChange={(next) => {
                    field.onChange(next);
                    form.setValue('value', '');
                    form.clearErrors('value');
                  }}
                  options={TYPES.map((v) => ({ value: v, label: t(`people.customer.contacts.types.${v}`) }))}
                />
              )}
            </FormField>
            <FormField name="value" label={type === 'EMAIL' ? t('customers.form.email') : t('people.customer.contacts.number')} required>
              {(field) => (type === 'EMAIL' ? <Input {...field} type="email" inputMode="email" autoComplete="off" autoCapitalize="none" spellCheck={false} dir="ltr" /> : <PhoneInput {...field} />)}
            </FormField>
            <FormField name="label" label={t('people.customer.contacts.label')} optional hint={t('people.customer.contacts.labelHint')}>
              {(field) => <Input {...field} autoComplete="off" maxLength={40} dir="auto" />}
            </FormField>
            <BooleanField name="isPrimary" disabled={!!contact?.isPrimary} label={t('people.customer.contacts.primaryChoice')} description={contact?.isPrimary ? t('people.customer.contacts.primaryLocked') : t('people.customer.contacts.primaryHint')} />
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {contact ? t('common.saveChanges') : t('people.customer.contacts.add')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
