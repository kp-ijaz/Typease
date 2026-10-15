'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Lock, Pencil, Plus, Printer, ShieldCheck, Trash2, Users } from 'lucide-react';
import { SYSTEM_ROLES } from '@typease/permissions';
import {
  Alert, Badge, Button, Card, CardContent, CardFooter, ConfirmDialog, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, EmptyState, PageHeader,
  RequirePermission, Skeleton, useApi, useBranding, useI18n, useSession, useToast,
} from '@typease/ui';
import { groupPermissions, usePermissionText } from '@/components/adm/permissions';
import { RoleEditorDialog, type RoleEditorTarget } from '@/components/adm/role-editor';
import { ActionError, LoadError } from '@/components/adm/shared';
import type { PermissionDef, RoleRow } from '@/components/adm/types';
import { admKeys } from '@/lib/keys/adm';

export function RolesPage() {
  return (
    <RequirePermission anyOf={['role.manage', 'staff.read']}>
      <Roles />
    </RequirePermission>
  );
}

function Roles() {
  const { t, tn } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const roles = useQuery({ queryKey: admKeys.roles.admin, queryFn: () => api.client.get<RoleRow[]>('/roles') });
  // The permissions each kind of role can hold: staff, customer portal, corporate portal.
  const catalogue = useQuery({
    queryKey: admKeys.roles.permissions,
    queryFn: async () => {
      const [STAFF, CUSTOMER, CORPORATE] = await Promise.all(['STAFF', 'CUSTOMER', 'CORPORATE'].map((kind) => api.client.get<PermissionDef[]>(`/roles/permissions?kind=${kind}`)));
      return { STAFF: STAFF!, CUSTOMER: CUSTOMER!, CORPORATE: CORPORATE! } as Record<string, PermissionDef[]>;
    },
    staleTime: 10 * 60_000,
  });
  // Roles are the owner's to change (the API checks this too).
  const isOwner = useSession().membership?.roleKey === 'owner';
  const [editor, setEditor] = React.useState<RoleEditorTarget | null>(null);
  const [viewing, setViewing] = React.useState<RoleRow | null>(null);
  const [deleting, setDeleting] = React.useState<RoleRow | null>(null);
  const [deleteError, setDeleteError] = React.useState<unknown>(null);
  const roleText = useRoleText();

  const list = roles.data ?? [];
  const builtIn = list.filter((r) => r.isSystem && r.kind === 'STAFF');
  const portal = list.filter((r) => r.kind !== 'STAFF');
  const custom = list.filter((r) => !r.isSystem && r.kind === 'STAFF');
  const ready = !!roles.data && !!catalogue.data;

  const newRole = isOwner ? (
    <Button variant="accent" disabled={!ready} onClick={() => setEditor({ role: null })}>
      <Plus aria-hidden="true" />
      {t('adm.roles.new')}
    </Button>
  ) : null;
  const actions = (role: RoleRow) =>
    isOwner ? (
      <>
        <Button variant="subtle" size="sm" onClick={() => setEditor({ role })}>
          <Pencil aria-hidden="true" />
          {t('common.edit')}
        </Button>
        {role.kind === 'STAFF' ? (
          <Button variant="ghost" size="sm" onClick={() => setEditor({ role: null, cloneFrom: role })}>
            <Copy aria-hidden="true" />
            {t('adm.roles.copy')}
          </Button>
        ) : null}
        {role.canDelete ? (
          <Button
            variant="ghost"
            size="sm"
            className="ms-auto text-destructive-text hover:bg-destructive-soft"
            onClick={() => {
              setDeleteError(null);
              setDeleting(role);
            }}
          >
            <Trash2 aria-hidden="true" />
            {t('common.delete')}
          </Button>
        ) : null}
      </>
    ) : null;

  return (
    <>
      <PageHeader
        title={t('adm.roles.title')}
        description={t('adm.roles.description')}
        action={newRole}
        secondary={
          <Button variant="outline" disabled={!ready} onClick={() => window.print()}>
            <Printer aria-hidden="true" />
            {t('adm.roles.print')}
          </Button>
        }
      />

      <Alert tone="info" className="mb-6" title={t('adm.roles.ruleTitle')}>
        {isOwner ? t('adm.roles.grantRule') : t('adm.roles.viewOnly')}
      </Alert>

      {roles.isError || catalogue.isError ? (
        <LoadError error={roles.error ?? catalogue.error} onRetry={() => void Promise.all([roles.refetch(), catalogue.refetch()])} />
      ) : !ready ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-44" />
          ))}
        </div>
      ) : (
        <div className="space-y-10">
          <section aria-labelledby="roles-custom">
            <h2 id="roles-custom" className="text-lg font-semibold">
              {t('adm.roles.customTitle')}
            </h2>
            <p className="mb-4 mt-1 text-base text-muted-foreground">{t('adm.roles.customText')}</p>
            {custom.length === 0 ? (
              <Card>
                <EmptyState icon={<ShieldCheck />} title={t('adm.roles.customEmptyTitle')} description={t('adm.roles.customEmptyText')} action={newRole} />
              </Card>
            ) : (
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {custom.map((role) => (
                  <RoleCard key={role.id} role={role} onView={() => setViewing(role)}>
                    {actions(role)}
                  </RoleCard>
                ))}
              </div>
            )}
          </section>

          <section aria-labelledby="roles-builtin">
            <h2 id="roles-builtin" className="text-lg font-semibold">
              {t('adm.roles.builtInTitle')}
            </h2>
            <p className="mb-4 mt-1 text-base text-muted-foreground">{t('adm.roles.builtInText')}</p>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {builtIn.map((role) => (
                <RoleCard key={role.id} role={role} onView={() => setViewing(role)}>
                  {actions(role)}
                </RoleCard>
              ))}
            </div>
          </section>

          {portal.length ? (
            <section aria-labelledby="roles-portal">
              <h2 id="roles-portal" className="text-lg font-semibold">
                {t('adm.roles.portalTitle')}
              </h2>
              <p className="mb-4 mt-1 text-base text-muted-foreground">{t('adm.roles.portalText')}</p>
              <Card>
                <ul className="divide-y">
                  {portal.map((role) => (
                    <li key={role.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-5 py-3">
                      <span className="min-w-0">
                        <span className="block font-medium">{roleText(role).name}</span>
                        <span className="block text-sm text-muted-foreground">{roleText(role).summary}</span>
                      </span>
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-sm text-muted-foreground">{tn('adm.roles.members', role.memberCount)}</span>
                        <button type="button" onClick={() => setViewing(role)} className="rounded-sm text-sm text-secondary-text underline-offset-4 hover:underline">
                          {tn('adm.roles.permissionCount', role.permissions.length)}
                        </button>
                        {role.permissionsFixed ? (
                          <Badge tone="neutral" icon={<Lock />}>
                            {t('adm.roles.permissionsFixed')}
                          </Badge>
                        ) : null}
                        {actions(role)}
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>
            </section>
          ) : null}
        </div>
      )}

      <RoleEditorDialog target={editor} onClose={() => setEditor(null)} roles={list} catalogues={catalogue.data ?? {}} />
      <RolePermissionsDialog role={viewing} catalogue={catalogue.data?.[viewing?.kind ?? 'STAFF'] ?? []} onClose={() => setViewing(null)} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t('adm.roles.deleteTitle', { name: deleting?.name ?? '' })}
        description={deleting && deleting.memberCount > 0 ? tn('adm.roles.deleteInUse', deleting.memberCount) : t('adm.roles.deleteText')}
        confirmLabel={t('adm.roles.deleteConfirm')}
        onConfirm={async () => {
          if (!deleting) return;
          setDeleteError(null);
          try {
            await api.client.delete(`/roles/${deleting.id}`);
            toasts.success(t('adm.roles.deleted'), deleting.name);
            await queryClient.invalidateQueries({ queryKey: admKeys.roles.all });
          } catch (error) {
            setDeleteError(error);
            throw error;
          }
        }}
      >
        {deleteError ? <ActionError error={deleteError} /> : null}
      </ConfirmDialog>

      {ready ? <PrintOverview roles={[...builtIn, ...custom]} catalogue={catalogue.data?.STAFF ?? []} /> : null}
    </>
  );
}

/** Name of a role: built-in roles the centre has not renamed are worded by the dictionary (both languages); everything else is data. */
function useRoleText() {
  const { t, has } = useI18n();
  return React.useCallback(
    (role: RoleRow) => {
      const original = role.isSystem ? SYSTEM_ROLES[role.key] : undefined;
      return {
        name: original?.name === role.name && has(`adm.roles.builtIn.${role.key}.name`) ? t(`adm.roles.builtIn.${role.key}.name`) : role.name,
        summary: original?.description === role.description && has(`adm.roles.builtIn.${role.key}.summary`) ? t(`adm.roles.builtIn.${role.key}.summary`) : role.description,
      };
    },
    [t, has],
  );
}

function RoleCard({ role, onView, children }: { role: RoleRow; onView: () => void; children?: React.ReactNode }) {
  const { t, tn } = useI18n();
  const text = useRoleText()(role);
  return (
    <Card className="flex flex-col">
      <CardContent className="flex-1 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h3 className="text-md font-semibold" dir="auto">
            {text.name}
          </h3>
          <span className="flex flex-wrap gap-1.5">
            {role.permissionsFixed ? (
              <Badge tone="neutral" icon={<Lock />}>
                {t('adm.roles.permissionsFixed')}
              </Badge>
            ) : null}
            {role.isSystem ? (
              <Badge tone="neutral">{t('adm.roles.builtInBadge')}</Badge>
            ) : (
              <Badge tone="brand">{t('adm.roles.customBadge')}</Badge>
            )}
            {role.requiresMfa ? <Badge tone="info">{t('adm.roles.requiresMfa')}</Badge> : null}
          </span>
        </div>
        {text.summary ? (
          <p className="text-base text-muted-foreground" dir="auto">
            {text.summary}
          </p>
        ) : null}
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <Users className="size-4" aria-hidden="true" />
            {tn('adm.roles.members', role.memberCount)}
          </span>
          <button type="button" onClick={onView} className="rounded-sm text-secondary-text underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
            {tn('adm.roles.permissionCount', role.permissions.length)}
          </button>
        </p>
      </CardContent>
      {children ? <CardFooter>{children}</CardFooter> : null}
    </Card>
  );
}

/** What a role can do, in plain words, grouped by area. Read-only. */
function RolePermissionsDialog({ role, catalogue, onClose }: { role: RoleRow | null; catalogue: PermissionDef[]; onClose: () => void }) {
  const { t } = useI18n();
  const text = usePermissionText();
  const roleText = useRoleText();
  const has = new Set(role?.permissions ?? []);
  const groups = groupPermissions(catalogue)
    .map((g) => ({ group: g.group, granted: g.permissions.filter((p) => has.has(p.key)) }))
    .filter((g) => g.granted.length);
  return (
    <Dialog open={!!role} onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{role ? t('adm.roles.canDoTitle', { name: roleText(role).name }) : ''}</DialogTitle>
          <DialogDescription>{role ? roleText(role).summary : ''}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-5">
          {groups.length === 0 ? <p className="text-base text-muted-foreground">{t('adm.roles.noPermissions')}</p> : null}
          {groups.map((g) => (
            <section key={g.group}>
              <h3 className="text-sm font-semibold text-muted-foreground">{text.group(g.group)}</h3>
              <ul className="mt-1.5 space-y-1">
                {g.granted.map((p) => (
                  <li key={p.key} className="flex items-start gap-2 text-base">
                    <Check className="mt-1 size-4 shrink-0 text-success-text" aria-hidden="true" />
                    {text.describe(p)}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('common.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const PRINT_ROOT = 'te-roles-print';

/**
 * The role / permission overview for printing: one table, permissions down, staff roles across.
 * It lives outside the app shell (a portal on <body>) and is the only thing on the printed page.
 */
function PrintOverview({ roles, catalogue }: { roles: RoleRow[]; catalogue: PermissionDef[] }) {
  const { t, formatDate, today } = useI18n();
  const branding = useBranding();
  const text = usePermissionText();
  const roleText = useRoleText();
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return createPortal(
    <div id={PRINT_ROOT} className="hidden bg-white p-2 text-[11px] leading-snug text-black print:block">
      <style>{`@media print { body > *:not(#${PRINT_ROOT}) { display: none !important; } @page { size: A4 landscape; margin: 12mm; } }`}</style>
      <h1 className="text-lg font-semibold">{t('adm.roles.printTitle', { centre: branding.name })}</h1>
      <p className="mb-3 text-neutral-600">{t('adm.roles.printDate', { date: formatDate(today(), 'long') })}</p>
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <th className="border border-neutral-400 p-1 text-start">{t('adm.roles.editor.permissions')}</th>
            {roles.map((r) => (
              <th key={r.id} className="border border-neutral-400 p-1 text-center align-bottom font-semibold">
                {roleText(r).name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {groupPermissions(catalogue).map((g) => (
            <React.Fragment key={g.group}>
              <tr>
                <th colSpan={roles.length + 1} className="border border-neutral-400 bg-neutral-200 p-1 text-start font-semibold">
                  {text.group(g.group)}
                </th>
              </tr>
              {g.permissions.map((p) => (
                <tr key={p.key} className="break-inside-avoid">
                  <td className="border border-neutral-400 p-1">{text.describe(p)}</td>
                  {roles.map((r) => (
                    <td key={r.id} className="border border-neutral-400 p-1 text-center">
                      {r.permissions.includes(p.key) ? '✓' : ''}
                    </td>
                  ))}
                </tr>
              ))}
            </React.Fragment>
          ))}
        </tbody>
      </table>
      <p className="mt-3 text-neutral-600">{t('adm.roles.grantRule')}</p>
    </div>,
    document.body,
  );
}
