'use client';

import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Input, Label, useI18n, useSession, useToast } from '@typease/ui';
import { usePlatformApi } from '@/lib/api';
import { keys } from '@/lib/query-keys';
import type { TenantRow } from '@/lib/types';
import { ConfirmAction, ConfirmReasonDialog } from './shared';

export type TenantActionId = 'approve' | 'reject' | 'suspend' | 'reactivate' | 'archive' | 'offboard' | 'cancelOffboarding' | 'resendInvitation';
export type TenantSubject = Pick<TenantRow, 'id' | 'name' | 'slug' | 'status' | 'suspensionReason' | 'offboardingAt'>;

const BILLING_SUSPENSION = 'SUBSCRIPTION_UNPAID';
const PLATFORM_PREFIX = 'PLATFORM: ';
const REJECTION_PREFIX = 'APPROVAL_REJECTED: ';

/** Why a centre is suspended, as the API stores it: by billing, by TypEase staff, or a rejected sign-up. */
export function suspensionOf(tenant: Pick<TenantRow, 'status' | 'suspensionReason'>): { kind: 'billing' | 'platform' | 'rejected' | 'other'; text: string } | null {
  if (tenant.status !== 'SUSPENDED' || !tenant.suspensionReason) return null;
  const reason = tenant.suspensionReason;
  if (reason === BILLING_SUSPENSION) return { kind: 'billing', text: '' };
  if (reason.startsWith(PLATFORM_PREFIX)) return { kind: 'platform', text: reason.slice(PLATFORM_PREFIX.length) };
  if (reason.startsWith(REJECTION_PREFIX)) return { kind: 'rejected', text: reason.slice(REJECTION_PREFIX.length) };
  return { kind: 'other', text: reason };
}

/**
 * The status changes that fit a centre's state (the rules of docs/api/modules/platform.md,
 * "Status changes"). The API checks them again; this only keeps impossible actions off the screen.
 */
export function availableTenantActions(tenant: TenantSubject, options: { manage: boolean; superAdmin: boolean; ownerInvited?: boolean }): TenantActionId[] {
  if (!options.manage) return [];
  const s = tenant.status;
  const billingSuspended = s === 'SUSPENDED' && tenant.suspensionReason === BILLING_SUSPENSION;
  const out: TenantActionId[] = [];
  if (s === 'PENDING_APPROVAL') out.push('approve', 'reject');
  if (options.ownerInvited) out.push('resendInvitation');
  if ((s === 'SUSPENDED' && !billingSuspended) || (s === 'ARCHIVED' && !tenant.offboardingAt)) out.push('reactivate');
  if (s !== 'ARCHIVED' && s !== 'CANCELLED' && (s !== 'SUSPENDED' || billingSuspended)) out.push('suspend');
  if (s !== 'ARCHIVED') out.push('archive');
  if (options.superAdmin) out.push(tenant.offboardingAt ? 'cancelOffboarding' : 'offboard');
  return out;
}

export const DESTRUCTIVE_ACTIONS: ReadonlySet<TenantActionId> = new Set(['reject', 'suspend', 'archive', 'offboard']);

/**
 * `ask(action, centre)` opens the confirmation of a lifecycle action; `dialogs` must be
 * rendered once by the page. Every action that the API takes a reason for asks for it.
 */
export function useTenantActions(onDone?: (action: TenantActionId) => void) {
  const { t, formatNumber } = useI18n();
  const api = usePlatformApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const [pending, setPending] = React.useState<{ action: TenantActionId; tenant: TenantSubject } | null>(null);
  const [days, setDays] = React.useState('30');
  const daysId = React.useId();

  const ask = React.useCallback((action: TenantActionId, tenant: TenantSubject) => {
    setDays('30');
    setPending({ action, tenant });
  }, []);
  const close = (open: boolean) => {
    if (!open) setPending(null);
  };
  const finished = async (action: TenantActionId, name: string) => {
    toasts.success(t(`tenants.actions.${action}.done`, { name }));
    await Promise.all([keys.tenants.all, keys.dashboard.all, keys.billing.all, keys.audit.all, keys.access.all].map((queryKey) => queryClient.invalidateQueries({ queryKey })));
    onDone?.(action);
  };

  const tenant = pending?.tenant;
  const action = pending?.action;
  const name = tenant?.name ?? '';
  const is = (id: TenantActionId) => action === id && !!tenant;
  const text = (id: TenantActionId, part: string, vars?: Record<string, string | number>) => t(`tenants.actions.${id}.${part}`, { name, ...vars });

  const dialogs = (
    <>
      <ConfirmReasonDialog
        open={is('approve')}
        onOpenChange={close}
        tone="default"
        required={false}
        minLength={1}
        maxLength={1000}
        title={text('approve', 'title')}
        description={text('approve', 'text')}
        confirmLabel={text('approve', 'label')}
        label={t('tenants.actions.noteLabel')}
        hint={t('tenants.actions.noteHint')}
        onConfirm={async (note) => {
          await api.tenants.approve(tenant!.id, note ? { note } : {});
          await finished('approve', name);
        }}
      />
      <ConfirmReasonDialog
        open={is('reject')}
        onOpenChange={close}
        title={text('reject', 'title')}
        description={text('reject', 'text')}
        confirmLabel={text('reject', 'label')}
        label={t('pc.reason')}
        hint={t('tenants.actions.reasonOwnerHint')}
        onConfirm={async (reason) => {
          await api.tenants.reject(tenant!.id, { reason });
          await finished('reject', name);
        }}
      />
      <ConfirmReasonDialog
        open={is('suspend')}
        onOpenChange={close}
        title={text('suspend', 'title')}
        description={text('suspend', 'text')}
        confirmLabel={text('suspend', 'label')}
        label={t('pc.reason')}
        hint={t('tenants.actions.reasonOwnerHint')}
        onConfirm={async (reason) => {
          await api.tenants.suspend(tenant!.id, { reason });
          await finished('suspend', name);
        }}
      />
      <ConfirmReasonDialog
        open={is('reactivate')}
        onOpenChange={close}
        tone="default"
        required={false}
        minLength={1}
        maxLength={1000}
        title={text('reactivate', 'title')}
        description={tenant?.status === 'ARCHIVED' ? text('reactivate', 'textArchived') : text('reactivate', 'text')}
        confirmLabel={text('reactivate', 'label')}
        label={t('tenants.actions.noteLabel')}
        hint={t('tenants.actions.noteHint')}
        onConfirm={async (note) => {
          await api.tenants.reactivate(tenant!.id, note ? { note } : {});
          await finished('reactivate', name);
        }}
      />
      <ConfirmReasonDialog
        open={is('archive')}
        onOpenChange={close}
        title={text('archive', 'title')}
        description={text('archive', 'text')}
        confirmLabel={text('archive', 'label')}
        label={t('pc.reason')}
        typedConfirmation={tenant?.slug}
        onConfirm={async (reason) => {
          await api.tenants.archive(tenant!.id, { reason });
          await finished('archive', name);
        }}
      />
      <ConfirmReasonDialog
        open={is('offboard')}
        onOpenChange={close}
        title={text('offboard', 'title')}
        description={text('offboard', 'text')}
        confirmLabel={text('offboard', 'label')}
        label={t('pc.reason')}
        hint={t('tenants.actions.offboard.reasonHint')}
        minLength={10}
        maxLength={1000}
        typedConfirmation={tenant?.slug}
        onConfirm={async (reason) => {
          const purgeAfterDays = Number(days);
          if (!Number.isInteger(purgeAfterDays) || purgeAfterDays < 30 || purgeAfterDays > 3650) throw new Error(t('tenants.actions.offboard.daysInvalid'));
          await api.tenants.offboard(tenant!.id, { confirmSlug: tenant!.slug, reason, purgeAfterDays, immediate: false });
          toasts.success(t('tenants.actions.offboard.done', { name, days: formatNumber(purgeAfterDays) }));
          await Promise.all([keys.tenants.all, keys.dashboard.all, keys.billing.all, keys.audit.all, keys.access.all].map((queryKey) => queryClient.invalidateQueries({ queryKey })));
          onDone?.('offboard');
        }}
      >
        <ul className="list-disc space-y-1 ps-5 text-sm text-foreground/90">
          <li>{t('tenants.actions.offboard.now1')}</li>
          <li>{t('tenants.actions.offboard.now2')}</li>
          <li>{t('tenants.actions.offboard.now3')}</li>
        </ul>
        <div className="space-y-1.5">
          <Label htmlFor={daysId} required>
            {t('tenants.actions.offboard.days')}
          </Label>
          <Input id={daysId} type="number" inputMode="numeric" dir="ltr" min={30} max={3650} step={1} value={days} onChange={(e) => setDays(e.target.value)} className="tabular w-32" />
          <p className="text-sm text-muted-foreground">{t('tenants.actions.offboard.daysHint')}</p>
        </div>
      </ConfirmReasonDialog>
      <ConfirmReasonDialog
        open={is('cancelOffboarding')}
        onOpenChange={close}
        tone="default"
        title={text('cancelOffboarding', 'title')}
        description={text('cancelOffboarding', 'text')}
        confirmLabel={text('cancelOffboarding', 'label')}
        label={t('pc.reason')}
        onConfirm={async (reason) => {
          await api.tenants.cancelOffboarding(tenant!.id, { reason });
          await finished('cancelOffboarding', name);
        }}
      />
      <ConfirmAction
        open={is('resendInvitation')}
        onOpenChange={close}
        tone="default"
        title={text('resendInvitation', 'title')}
        description={text('resendInvitation', 'text')}
        confirmLabel={text('resendInvitation', 'label')}
        onConfirm={async () => {
          const result = await api.tenants.resendOwnerInvitation(tenant!.id);
          toasts.success(t('tenants.actions.resendInvitation.done', { name: result.email }));
          await queryClient.invalidateQueries({ queryKey: keys.tenants.all });
          onDone?.('resendInvitation');
        }}
      />
    </>
  );

  return { ask, dialogs };
}

/** Whether the signed-in person may manage centres, and whether they are a super admin (offboarding). */
export function useTenantRights() {
  const session = useSession();
  return React.useMemo(
    () => ({ manage: session.hasPermission('platform.tenants.manage'), superAdmin: session.hasPermission('platform.tenants.manage') && session.user?.platformRole === 'SUPER_ADMIN' }),
    [session],
  );
}
