'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, Pencil, Plus, Trash2, Users } from 'lucide-react';
import { corporateRoleSchema } from '@typease/validation';
import {
  Alert, Badge, Button, Card, CardContent, CardFooter, Checkbox, ConfirmDialog, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Form, FormError,
  FormField, Input, PageHeader, Select, Skeleton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea, describeError, useI18n, useSession, useToast, useZodForm,
} from '@typease/ui';
import { Gate, LoadError, NoAccess, SectionTitle, isForbidden } from '@/components/portal/shared';
import { usePortalApi } from '@/lib/api';
import { keys } from '@/lib/query-keys';
import type { CompanyRole, CompanyUser, RolePermissionDef } from '@/lib/types';

export function Roles() {
  return (
    <Gate anyOf={['corp.account.read']}>
      <RolesPage />
    </Gate>
  );
}

/** The company's own top role: "corporate_admin", or the company's copy of it ("co_<company>_corporate_admin"). */
function useIsCompanyAdmin() {
  const key = useSession().membership?.roleKey ?? '';
  return key === 'corporate_admin' || /^co_[0-9a-f]{32}_corporate_admin$/.test(key);
}

/** Words for a permission or group: the dictionary in both languages, the API's English as the fallback. */
function usePermissionText() {
  const { t, has } = useI18n();
  return React.useMemo(
    () => ({
      group: (group: string) => (has(`roles.groups.${group}`) ? t(`roles.groups.${group}`) : group),
      describe: (p: RolePermissionDef) => (has(`roles.perm.${p.key.replace(/\./g, '_')}`) ? t(`roles.perm.${p.key.replace(/\./g, '_')}`) : p.description),
    }),
    [t, has],
  );
}

/**
 * Roles and access of the company. Everybody with the company account can see them; only the company
 * administrator creates, changes and deletes roles and gives people a role. The API enforces the same.
 */
function RolesPage() {
  const i18n = useI18n();
  const { t, tn } = i18n;
  const api = usePortalApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const isAdmin = useIsCompanyAdmin();
  const roles = useQuery({ queryKey: keys.roles, queryFn: api.roles });
  const catalogue = useQuery({ queryKey: keys.rolePermissions, queryFn: api.rolePermissions, staleTime: 10 * 60_000 });
  const users = useQuery({ queryKey: keys.users, queryFn: api.users });
  const [editing, setEditing] = React.useState<CompanyRole | 'new' | null>(null);
  const [deleting, setDeleting] = React.useState<CompanyRole | null>(null);
  const [deleteError, setDeleteError] = React.useState<string | null>(null);
  const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: keys.roles }), queryClient.invalidateQueries({ queryKey: keys.users })]);

  const error = roles.error ?? catalogue.error ?? users.error;
  const header = (
    <PageHeader
      title={t('nav.roles')}
      description={t('sections.roles')}
      action={
        isAdmin ? (
          <Button variant="accent" disabled={!catalogue.data} onClick={() => setEditing('new')}>
            <Plus aria-hidden="true" />
            {t('roles.new')}
          </Button>
        ) : null
      }
    />
  );
  if (error) {
    return (
      <>
        {header}
        {isForbidden(error) ? <NoAccess /> : <LoadError error={error} onRetry={() => void Promise.all([roles.refetch(), catalogue.refetch(), users.refetch()])} />}
      </>
    );
  }

  return (
    <>
      {header}
      <Alert tone="info" className="mb-6" title={t('roles.ruleTitle')}>
        {isAdmin ? t('roles.rule') : t('roles.viewOnly')}
      </Alert>

      <section aria-labelledby="roles-list" className="space-y-4">
        <SectionTitle id="roles-list">{t('roles.rolesTitle')}</SectionTitle>
        {!roles.data ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" role="status" aria-label={t('common.loading')}>
            <Skeleton className="h-40" />
            <Skeleton className="h-40" />
            <Skeleton className="h-40" />
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {roles.data.map((role) => (
              <Card key={role.id} className="flex flex-col">
                <CardContent className="flex-1 space-y-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <h3 className="text-md font-semibold" dir="auto">
                      {role.name}
                    </h3>
                    <span className="flex flex-wrap gap-1.5">
                      {role.permissionsFixed ? (
                        <Badge tone="neutral" icon={<Lock />}>
                          {t('roles.fixed')}
                        </Badge>
                      ) : null}
                      <Badge tone={role.builtIn ? 'neutral' : 'brand'}>{role.builtIn ? t('roles.builtIn') : t('roles.custom')}</Badge>
                    </span>
                  </div>
                  {role.description ? (
                    <p className="text-base text-muted-foreground" dir="auto">
                      {role.description}
                    </p>
                  ) : null}
                  <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
                    <span className="inline-flex items-center gap-1.5">
                      <Users className="size-4" aria-hidden="true" />
                      {tn('roles.members', role.memberCount)}
                    </span>
                    <span>{tn('roles.permissionCount', role.permissions.length)}</span>
                  </p>
                </CardContent>
                {isAdmin ? (
                  <CardFooter>
                    <Button variant="subtle" size="sm" disabled={!catalogue.data} onClick={() => setEditing(role)}>
                      <Pencil aria-hidden="true" />
                      {t('roles.edit')}
                    </Button>
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
                        {t('roles.delete')}
                      </Button>
                    ) : null}
                  </CardFooter>
                ) : null}
              </Card>
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="roles-people" className="mt-10 space-y-2">
        <SectionTitle id="roles-people">{t('roles.peopleTitle')}</SectionTitle>
        <p className="text-base text-muted-foreground">{t('roles.peopleText')}</p>
        {!users.data || !roles.data ? <Skeleton className="h-48" /> : <PeopleTable users={users.data} roles={roles.data} isAdmin={isAdmin} onChanged={refresh} />}
      </section>

      <RoleEditor target={editing} catalogue={catalogue.data ?? []} onClose={() => setEditing(null)} onSaved={refresh} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t('roles.deleteTitle', { name: deleting?.name ?? '' })}
        description={deleting && deleting.memberCount > 0 ? tn('roles.deleteInUse', deleting.memberCount) : t('roles.deleteText')}
        confirmLabel={t('roles.deleteConfirm')}
        onConfirm={async () => {
          if (!deleting) return;
          setDeleteError(null);
          try {
            await api.deleteRole(deleting.id);
            toasts.success(t('roles.deleted'), deleting.name);
            await refresh();
          } catch (e) {
            setDeleteError(describeError(e, i18n));
            throw e;
          }
        }}
      >
        {deleteError ? (
          <Alert tone="danger" live>
            {deleteError}
          </Alert>
        ) : null}
      </ConfirmDialog>
    </>
  );
}

function PeopleTable({ users, roles, isAdmin, onChanged }: { users: CompanyUser[]; roles: CompanyRole[]; isAdmin: boolean; onChanged: () => Promise<unknown> }) {
  const { t } = useI18n();
  const api = usePortalApi();
  const toasts = useToast();
  const [busy, setBusy] = React.useState<string | null>(null);
  const options = roles.map((r) => ({ value: r.id, label: r.name }));
  return (
    <Card>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('roles.columns.name')}</TableHead>
            <TableHead>{t('roles.columns.type')}</TableHead>
            <TableHead>{t('roles.columns.status')}</TableHead>
            <TableHead className="w-64">{t('roles.columns.role')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.map((u) => (
            <TableRow key={u.id}>
              <TableCell>
                <span className="block font-medium" dir="auto">
                  {u.fullName}
                  {u.isMe ? <span className="ms-2 text-sm font-normal text-muted-foreground">({t('roles.you')})</span> : null}
                </span>
                <span className="ltr-value block text-sm text-muted-foreground">{u.email}</span>
              </TableCell>
              <TableCell>{t(`roles.type.${u.type}`)}</TableCell>
              <TableCell>{t(`roles.status.${u.status}`)}</TableCell>
              <TableCell>
                {isAdmin && !u.isMe ? (
                  <Select
                    aria-label={t('roles.changeRoleFor', { name: u.fullName })}
                    value={u.roleId}
                    disabled={busy === u.id}
                    options={options.some((o) => o.value === u.roleId) ? options : [{ value: u.roleId, label: u.roleName }, ...options]}
                    onValueChange={async (roleId) => {
                      if (roleId === u.roleId) return;
                      setBusy(u.id);
                      try {
                        await api.setUserRole(u.id, roleId);
                        toasts.success(t('roles.roleChanged'), t('roles.roleChangedText', { name: u.fullName }));
                        await onChanged();
                      } catch (e) {
                        toasts.error(e);
                      } finally {
                        setBusy(null);
                      }
                    }}
                  />
                ) : (
                  <span dir="auto">{u.roleName}</span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

const schema = corporateRoleSchema;

function RoleEditor({ target, catalogue, onClose, onSaved }: { target: CompanyRole | 'new' | null; catalogue: RolePermissionDef[]; onClose: () => void; onSaved: () => Promise<unknown> }) {
  const { t, tn } = useI18n();
  const api = usePortalApi();
  const toasts = useToast();
  const text = usePermissionText();
  const idBase = React.useId();
  const editing = target && target !== 'new' ? target : null;
  const fixed = !!editing?.permissionsFixed;
  const form = useZodForm(schema, { emptyAs: 'null', defaultValues: { name: '', description: '', permissions: [] } });
  React.useEffect(() => {
    if (!target) return;
    form.reset(editing ? { name: editing.name, description: editing.description ?? '', permissions: editing.permissions } : { name: '', description: '', permissions: [] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);
  const selected: string[] = form.watch('permissions') ?? [];
  const set = new Set(selected);
  const toggle = (key: string, on: boolean) => form.setValue('permissions', on ? [...selected, key] : selected.filter((k) => k !== key), { shouldDirty: true });
  const groups: Array<{ group: string; items: RolePermissionDef[] }> = [];
  for (const p of catalogue) {
    const g = groups.find((x) => x.group === p.group);
    if (g) g.items.push(p);
    else groups.push({ group: p.group, items: [p] });
  }

  return (
    <Dialog open={!!target} onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="lg">
        <Form
          form={form}
          className="flex min-h-0 flex-1 flex-col space-y-0"
          onSubmit={async (values) => {
            if (editing) {
              await api.updateRole(editing.id, values);
              toasts.success(t('roles.editor.saved'), values.name);
            } else {
              await api.createRole(values);
              toasts.success(t('roles.editor.created'), values.name);
            }
            await onSaved();
            onClose();
          }}
        >
          <DialogHeader>
            <DialogTitle>{editing ? t('roles.editor.editTitle', { name: editing.name }) : t('roles.editor.newTitle')}</DialogTitle>
            <DialogDescription>{t('roles.editor.description')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            <FormField name="name" label={t('roles.editor.name')} required>
              {(field) => <Input {...field} autoComplete="off" placeholder={t('roles.editor.namePlaceholder')} />}
            </FormField>
            <FormField name="description" label={t('roles.editor.roleDescription')} optional>
              {(field) => <Textarea {...field} rows={2} />}
            </FormField>
            {fixed ? <Alert tone="info">{t('roles.editor.fixedNote')}</Alert> : editing?.builtIn ? <Alert tone="info">{t('roles.editor.builtInNote')}</Alert> : null}
            <fieldset className="space-y-3">
              <legend className="text-md font-semibold">
                {t('roles.editor.permissions')} <span className="text-sm font-normal text-muted-foreground">({tn('roles.permissionCount', selected.length)})</span>
              </legend>
              {groups.map((g) => (
                <section key={g.group} className="rounded-lg border">
                  <h4 className="border-b bg-muted/40 px-3 py-2 text-base font-semibold">{text.group(g.group)}</h4>
                  <ul className="grid gap-x-6 sm:grid-cols-2">
                    {g.items.map((p) => {
                      const id = `${idBase}-${p.key}`;
                      return (
                        <li key={p.key} className="flex items-start gap-3 px-3 py-2">
                          <span className="flex h-6 items-center">
                            <Checkbox id={id} checked={set.has(p.key)} disabled={fixed} onCheckedChange={(on) => toggle(p.key, on === true)} />
                          </span>
                          <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer text-base leading-6">
                            {text.describe(p)}
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </fieldset>
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {editing ? t('common.saveChanges') : t('roles.editor.create')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
