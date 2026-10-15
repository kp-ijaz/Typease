import type { LucideIcon } from 'lucide-react';

/**
 * Navigation is data: each app declares its items once and the shell filters
 * them by the session's permissions. Hidden items are a convenience only; the
 * API checks every permission again.
 */
export interface NavItem {
  id: string;
  /** Dictionary key of the label, e.g. "nav.requests". */
  labelKey: string;
  icon: LucideIcon;
  href: string;
  /** Shown when the session holds at least one of these (empty / omitted: always shown). */
  anyOf?: readonly string[];
  /** ... and all of these. */
  allOf?: readonly string[];
  /** Active only on the exact path (for "/" and other parents of sibling items). */
  exact?: boolean;
  /**
   * The `id` of the item this one belongs under ("Scheduled reports" under "Reports"). It is listed
   * right after its parent, indented; in the collapsed icon rail it is left out (reach it through the parent).
   */
  parent?: string;
}
export interface NavGroup {
  id: string;
  /** Dictionary key of the group heading; omit for the first, unlabelled group. */
  labelKey?: string;
  items: NavItem[];
}

export interface PermissionCheck {
  hasPermission: (permission: string) => boolean;
  hasAnyPermission: (permissions: readonly string[]) => boolean;
}

export const canSee = (item: Pick<NavItem, 'anyOf' | 'allOf'>, session: PermissionCheck): boolean =>
  (!item.anyOf || item.anyOf.length === 0 || session.hasAnyPermission(item.anyOf)) && (!item.allOf || item.allOf.every((p) => session.hasPermission(p)));

/** Groups with only the items the session may see; empty groups disappear. */
export function filterNav(groups: NavGroup[], session: PermissionCheck): NavGroup[] {
  return groups.map((group) => ({ ...group, items: group.items.filter((item) => canSee(item, session)) })).filter((group) => group.items.length > 0);
}

export function isActivePath(pathname: string, item: Pick<NavItem, 'href' | 'exact'>): boolean {
  const path = pathname.replace(/\/+$/, '') || '/';
  const href = item.href.split('?')[0].replace(/\/+$/, '') || '/';
  if (item.exact || href === '/') return path === href;
  return path === href || path.startsWith(`${href}/`);
}

/**
 * The item a path belongs to (longest matching href). The shell marks only this one as current, so
 * "/reports/scheduled" lights up "Scheduled reports" and not "Reports" as well. Also for page titles and breadcrumbs.
 */
export function findNavItem(groups: NavGroup[], pathname: string): NavItem | undefined {
  return groups
    .flatMap((g) => g.items)
    .filter((item) => isActivePath(pathname, item))
    .sort((a, b) => b.href.length - a.href.length)[0];
}
