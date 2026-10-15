'use client';

import * as React from 'react';
import { SYSTEM_ROLES } from '@typease/permissions';
import { useI18n } from '@typease/ui';
import type { PermissionDef } from './types';

/** Dictionary key of a permission's description ("request.read.all" -> adm.permissions.request_read_all). */
const permissionKey = (key: string) => `adm.permissions.${key.replace(/\./g, '_')}`;
const groupKey = (group: string) => `adm.permissionGroups.${group}`;

/**
 * Words for the permission catalogue. The API sends English group names and descriptions; the
 * dictionary carries both languages and the API's text is the fallback for permissions added later.
 */
export function usePermissionText() {
  const { t, has } = useI18n();
  return React.useMemo(
    () => ({
      group: (group: string) => (has(groupKey(group)) ? t(groupKey(group)) : group),
      describe: (permission: Pick<PermissionDef, 'key' | 'description'>) => (has(permissionKey(permission.key)) ? t(permissionKey(permission.key)) : permission.description),
    }),
    [t, has],
  );
}

/** The catalogue as ordered groups: [{ group, permissions }]. */
export function groupPermissions(catalogue: PermissionDef[]): Array<{ group: string; permissions: PermissionDef[] }> {
  const groups: Array<{ group: string; permissions: PermissionDef[] }> = [];
  for (const permission of catalogue) {
    const last = groups.find((g) => g.group === permission.group);
    if (last) last.permissions.push(permission);
    else groups.push({ group: permission.group, permissions: [permission] });
  }
  return groups;
}

/** "Head cashier" -> "head_cashier"; names without Latin letters get a neutral key. */
export function roleKeyFrom(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 36);
  const key = /^[a-z]/.test(base) ? base : `role_${base}`.replace(/_+$/, '');
  return key.length >= 3 && key !== 'role' ? key : `role_${Date.now().toString(36)}`;
}

/** Built-in roles the centre has not renamed are named by the dictionary (both languages); other roles keep the name they were given. */
export function useRoleName(): (role: { key: string; name: string }) => string {
  const { t, has } = useI18n();
  return React.useCallback(
    (role) => (SYSTEM_ROLES[role.key]?.name === role.name && has(`adm.roles.builtIn.${role.key}.name`) ? t(`adm.roles.builtIn.${role.key}.name`) : role.name),
    [t, has],
  );
}
