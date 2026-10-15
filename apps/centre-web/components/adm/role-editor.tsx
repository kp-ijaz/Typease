'use client';

import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Lock, Search } from 'lucide-react';
import { roleSchema } from '@typease/validation';
import {
  Alert, Badge, Button, Checkbox, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Form, FormError, FormField, Input, Select, Textarea, cn,
  useApi, useI18n, useSession, useToast, useZodForm,
} from '@typease/ui';
import { admKeys } from '@/lib/keys/adm';
import { groupPermissions, roleKeyFrom, usePermissionText } from './permissions';
import type { PermissionDef, RoleRow } from './types';

const schema = roleSchema.omit({ key: true });
const NONE = '__none__';

export interface RoleEditorTarget {
  /** The role being edited (built-in or custom, staff or portal), or null for a new staff role. */
  role: RoleRow | null;
  /** A role whose permissions the new role starts with. */
  cloneFrom?: RoleRow | null;
}

/**
 * Create or edit a role: name, description and the permission matrix grouped by area, from the permissions
 * a role of its kind can hold. Staff permissions the signed-in person does not hold cannot be ticked (the API
 * refuses them too). The owner role keeps every permission: only its name and description change.
 */
export function RoleEditorDialog({ target, onClose, roles, catalogues }: { target: RoleEditorTarget | null; onClose: () => void; roles: RoleRow[]; catalogues: Record<string, PermissionDef[]> }) {
  const { t, tn } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const session = useSession();
  const queryClient = useQueryClient();
  const text = usePermissionText();
  const form = useZodForm(schema, { emptyAs: 'null', defaultValues: { name: '', description: '', permissions: [] } });
  const [query, setQuery] = React.useState('');
  const [source, setSource] = React.useState<string>(NONE);
  const [dropped, setDropped] = React.useState(0);
  const idBase = React.useId();
  const editing = target?.role ?? null;
  const kind = editing?.kind ?? 'STAFF';
  const catalogue = React.useMemo(() => catalogues[kind] ?? [], [catalogues, kind]);
  const fixed = !!editing?.permissionsFixed;
  const own = React.useMemo(() => new Set(session.permissions), [session.permissions]);
  const known = React.useMemo(() => new Set(catalogue.map((p) => p.key)), [catalogue]);

  /** Permissions of a source role that this person may hand out. */
  const grantable = React.useCallback((role: RoleRow) => role.permissions.filter((p) => known.has(p) && own.has(p)), [known, own]);

  React.useEffect(() => {
    if (!target) return;
    setQuery('');
    if (target.role) {
      form.reset({ name: target.role.name, description: target.role.description ?? '', permissions: target.role.permissions.filter((p) => known.has(p)) });
      setSource(NONE);
      setDropped(0);
    } else if (target.cloneFrom) {
      const allowed = grantable(target.cloneFrom);
      form.reset({ name: t('adm.roles.editor.copyName', { name: target.cloneFrom.name }), description: target.cloneFrom.description ?? '', permissions: allowed });
      setSource(target.cloneFrom.id);
      setDropped(target.cloneFrom.permissions.filter((p) => known.has(p)).length - allowed.length);
    } else {
      form.reset({ name: '', description: '', permissions: [] });
      setSource(NONE);
      setDropped(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  const selected: string[] = form.watch('permissions') ?? [];
  const selectedSet = new Set(selected);
  const setSelected = (next: string[]) => form.setValue('permissions', next, { shouldDirty: true });
  /** A permission already on the role stays removable even when the editor does not hold it. Portal permissions are nobody's own. */
  const locked = (key: string) => fixed || (kind === 'STAFF' && !own.has(key) && !selectedSet.has(key));

  const needle = query.trim().toLowerCase();
  const groups = groupPermissions(catalogue)
    .map((g) => ({ ...g, visible: needle ? g.permissions.filter((p) => `${p.key} ${p.description} ${text.describe(p)} ${text.group(g.group)}`.toLowerCase().includes(needle)) : g.permissions }))
    .filter((g) => g.visible.length);

  const applySource = (id: string) => {
    setSource(id);
    const role = roles.find((r) => r.id === id);
    if (!role) return;
    const allowed = grantable(role);
    setSelected(allowed);
    setDropped(role.permissions.filter((p) => known.has(p)).length - allowed.length);
  };

  return (
    <Dialog open={!!target} onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="xl">
        <Form
          form={form}
          className="flex min-h-0 flex-1 flex-col space-y-0"
          onSubmit={async (values) => {
            if (editing) {
              await api.client.patch(`/roles/${editing.id}`, values);
              toasts.success(t('adm.roles.editor.saved'), values.name);
            } else {
              await api.client.post('/roles', { ...values, key: roleKeyFrom(values.name) });
              toasts.success(t('adm.roles.editor.created'), values.name);
            }
            await queryClient.invalidateQueries({ queryKey: admKeys.roles.all });
            onClose();
          }}
        >
          <DialogHeader>
            <DialogTitle>{editing ? t('adm.roles.editor.editTitle', { name: editing.name }) : t('adm.roles.editor.newTitle')}</DialogTitle>
            <DialogDescription>{t('adm.roles.editor.description')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            <div className="grid gap-5 sm:grid-cols-2">
              <FormField name="name" label={t('adm.roles.editor.name')} required>
                {(field) => <Input {...field} autoComplete="off" autoFocus={!editing} placeholder={t('adm.roles.editor.namePlaceholder')} />}
              </FormField>
              {editing ? null : (
                <div className="space-y-1.5">
                  <label htmlFor={`${idBase}-source`} className="block text-sm font-medium leading-5">
                    {t('adm.roles.editor.startFrom')}
                  </label>
                  <Select
                    id={`${idBase}-source`}
                    value={source}
                    onValueChange={applySource}
                    options={[{ value: NONE, label: t('adm.roles.editor.startEmpty') }, ...roles.filter((r) => r.kind === 'STAFF').map((r) => ({ value: r.id, label: r.name }))]}
                  />
                  <p className="text-sm text-muted-foreground">{t('adm.roles.editor.startHint')}</p>
                </div>
              )}
              <FormField name="description" label={t('adm.roles.editor.roleDescription')} optional className="sm:col-span-2">
                {(field) => <Textarea {...field} rows={2} />}
              </FormField>
            </div>

            {fixed ? <Alert tone="info">{t('adm.roles.editor.fixedNote')}</Alert> : null}
            {dropped > 0 ? (
              <Alert tone="warning" live>
                {tn('adm.roles.editor.dropped', dropped)}
              </Alert>
            ) : null}

            <fieldset className="space-y-3">
              <legend className="text-md font-semibold">{t('adm.roles.editor.permissions')}</legend>
              <div className="flex flex-wrap items-center gap-3">
                <Input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('adm.roles.editor.search')}
                  aria-label={t('adm.roles.editor.search')}
                  startAdornment={<Search aria-hidden="true" />}
                  className="[&::-webkit-search-cancel-button]:hidden sm:w-80"
                />
                <span className="text-sm text-muted-foreground" role="status">
                  {tn('adm.roles.permissionCount', selected.length)}
                </span>
              </div>

              {groups.length === 0 ? <p className="rounded-lg border px-3 py-6 text-center text-sm text-muted-foreground">{t('common.noResultsFor', { query })}</p> : null}
              <div className="space-y-3">
                {groups.map((g) => {
                  const allowed = g.permissions.filter((p) => !locked(p.key));
                  const on = allowed.filter((p) => selectedSet.has(p.key)).length;
                  const state = on === 0 ? false : on === allowed.length ? true : 'indeterminate';
                  const groupId = `${idBase}-g-${g.group}`;
                  return (
                    <section key={g.group} className="rounded-lg border">
                      <div className="flex items-center gap-3 border-b bg-muted/40 px-3 py-2.5">
                        <Checkbox
                          id={groupId}
                          checked={state}
                          disabled={allowed.length === 0}
                          onCheckedChange={(checked) => {
                            const keys = allowed.map((p) => p.key);
                            setSelected(checked === true ? [...new Set([...selected, ...keys])] : selected.filter((k) => !keys.includes(k)));
                          }}
                        />
                        <label htmlFor={groupId} className="flex-1 cursor-pointer text-base font-semibold">
                          {text.group(g.group)}
                        </label>
                        <span className="tabular text-sm text-muted-foreground">
                          {on} / {g.permissions.length}
                        </span>
                      </div>
                      <ul className="grid gap-x-6 sm:grid-cols-2">
                        {g.visible.map((p) => {
                          const isLocked = locked(p.key);
                          const id = `${idBase}-p-${p.key}`;
                          return (
                            <li key={p.key} className={cn('flex items-start gap-3 px-3 py-2', isLocked && 'opacity-70')}>
                              <span className="flex h-6 items-center">
                                <Checkbox
                                  id={id}
                                  checked={selectedSet.has(p.key)}
                                  disabled={isLocked}
                                  onCheckedChange={(checked) => setSelected(checked === true ? [...selected, p.key] : selected.filter((k) => k !== p.key))}
                                />
                              </span>
                              <label htmlFor={id} className={cn('min-w-0 flex-1 text-base leading-6', isLocked ? 'cursor-not-allowed' : 'cursor-pointer')}>
                                {text.describe(p)}
                                <span className="ltr-value block text-xs text-muted-foreground">{p.key}</span>
                              </label>
                              {isLocked && !fixed ? (
                                <Badge tone="neutral" icon={<Lock />} title={t('adm.roles.editor.notYours')}>
                                  {t('adm.roles.editor.notYoursShort')}
                                </Badge>
                              ) : null}
                            </li>
                          );
                        })}
                      </ul>
                    </section>
                  );
                })}
              </div>
              <p className="text-sm text-muted-foreground">{t('adm.roles.grantRule')}</p>
            </fieldset>
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {editing ? t('common.saveChanges') : t('adm.roles.editor.create')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
