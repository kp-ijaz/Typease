'use client';

import { SectionPlaceholder, findNavItem, useT } from '@typease/ui';
import { NAV } from '@/lib/nav';

/**
 * TEMPORARY. Routes of sections that are not built yet render this marker so
 * that the navigation has no dead links. The list of these routes is in
 * docs/architecture/FRONTEND_CONVENTIONS.md ("Temporary markers").
 * Page builders replace the page file; nothing else depends on this component.
 */
export function SectionMarker({ titleKey, descriptionKey, parentHref }: { titleKey: string; descriptionKey: string; parentHref?: string }) {
  const t = useT();
  const parent = parentHref ? findNavItem(NAV, parentHref) : undefined;
  return <SectionPlaceholder title={t(titleKey)} description={t(descriptionKey)} breadcrumbs={parent ? [{ label: t(parent.labelKey), href: parent.href }] : undefined} />;
}
