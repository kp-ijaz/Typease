import { SYSTEM_ROLES } from '@typease/permissions';
import type { Locale } from './format';

/**
 * The name of a role in the reader's language. The API stores role names in one
 * language; the built-in roles (owner, manager, receptionist ...) have an Arabic
 * name in `@typease/permissions`. Roles a centre created, and built-in roles
 * whose stored name is no longer the built-in one, keep the name they were given.
 *
 *   roleDisplayName({ key: 'owner', name: 'Centre Owner' }, 'ar')  ->  'مالك المركز'
 */
export function roleDisplayName(role: { key?: string | null; name: string; isSystem?: boolean }, locale: Locale): string {
  if (locale !== 'ar' || role.isSystem === false || !role.key) return role.name;
  const system = SYSTEM_ROLES[role.key];
  return system && role.name === system.name ? system.nameAr : role.name;
}
