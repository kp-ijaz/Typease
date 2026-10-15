'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useApi, useSession } from '@typease/ui';
import { admKeys } from '@/lib/keys/adm';
import type { DomainsState } from './types';

/**
 * Address of the centre's customer portal, for "View customer portal" links:
 *  1. the primary verified custom domain;
 *  2. the centre's automatic TypEase address (<slug>.<platform domain>);
 *  3. on a developer's machine (this app on localhost) the local portal with ?tenant=<slug>.
 * The staff app has no configuration value for the portal's address, so it is derived from what the
 * API reports (GET /domains, needs `domain.manage`) and, without that permission, from this app's own host.
 */
export function usePortalUrl(): string | null {
  const api = useApi();
  const session = useSession();
  const slug = session.tenant?.slug;
  const domains = useQuery({ queryKey: admKeys.domains.all, queryFn: () => api.client.get<DomainsState>('/domains'), enabled: session.hasPermission('domain.manage'), staleTime: 5 * 60_000 });
  const [url, setUrl] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!slug) return setUrl(null);
    const { protocol, hostname } = window.location;
    if (hostname === 'localhost' || hostname === '127.0.0.1') return setUrl(`http://${hostname}:3002/?tenant=${slug}`);
    const custom = domains.data?.domains.find((d) => d.status === 'VERIFIED' && d.isPrimary && d.app === 'customer');
    if (custom) return setUrl(`https://${custom.domain}`);
    if (domains.data?.platformDomain) return setUrl(`${protocol}//${domains.data.platformDomain}`);
    // "app.typease.ae" -> "<slug>.typease.ae"
    const parts = hostname.split('.');
    setUrl(parts.length > 2 ? `${protocol}//${[slug, ...parts.slice(1)].join('.')}` : null);
  }, [slug, domains.data]);
  return url;
}
