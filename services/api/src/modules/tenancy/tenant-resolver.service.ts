import { Injectable } from '@nestjs/common';
import type { Tenant } from '@typease/database';
import { env } from '../../config/env';
import { tryCtx } from '../../common/context';
import { SystemDb } from '../../common/db/prisma.service';
import { Errors } from '../../common/errors';

/**
 * Finds which tenant a PUBLIC request is addressed to (portal host, verified
 * custom domain or explicit slug). This only selects branding / catalogue /
 * the centre a person is signing in to. It is never proof of authorisation:
 * authenticated data access uses the tenant bound to the verified session.
 */
@Injectable()
export class TenantResolver {
  private cache = new Map<string, { at: number; tenantId: string | null }>();
  constructor(private readonly sys: SystemDb) {}

  /**
   * host -> tenant id, via <slug>.<base domain> or a VERIFIED custom domain of a centre whose plan includes
   * custom domains. Answers are cached for 30 seconds: a verification, a removal or a plan change is visible
   * after that time at the latest (changes made through this API clear the cache at once).
   */
  async fromHost(host: string | undefined | null): Promise<string | null> {
    if (!host) return null;
    const h = host.toLowerCase().split(':')[0].replace(/\.$/, '');
    const hit = this.cache.get(h);
    if (hit && Date.now() - hit.at < 30_000) return hit.tenantId;
    let tenantId: string | null = null;
    const base = env().PLATFORM_BASE_DOMAIN.toLowerCase();
    if (h.endsWith(`.${base}`)) {
      const sub = h.slice(0, -(base.length + 1));
      if (/^[a-z0-9-]+$/.test(sub)) tenantId = (await this.sys.client.tenant.findUnique({ where: { slug: sub }, select: { id: true } }))?.id ?? null;
    }
    if (!tenantId) {
      const domain = await this.sys.client.tenantDomain.findFirst({ where: { domain: h, status: 'VERIFIED' }, select: { tenantId: true } });
      // A verified domain is routed only while the centre's plan includes custom domains. The row is kept, so
      // the domain works again by itself when the plan includes the feature again.
      if (domain && (await this.customDomainsIncluded(domain.tenantId))) tenantId = domain.tenantId;
    }
    this.cache.set(h, { at: Date.now(), tenantId });
    if (this.cache.size > 5000) this.cache.clear();
    return tenantId;
  }
  invalidate() {
    this.cache.clear();
  }

  /** Does the centre's current plan include custom domains? Same rule as UsageService (no subscription = no). */
  async customDomainsIncluded(tenantId: string): Promise<boolean> {
    const sub = await this.sys.client.subscription.findUnique({ where: { tenantId }, select: { plan: { select: { features: true } } } });
    return ((sub?.plan.features ?? {}) as Record<string, unknown>).customDomains === true;
  }

  /** Explicit slug wins; otherwise the tenant resolved from the request host. */
  async resolveId(slug?: string | null): Promise<string | null> {
    if (slug) return (await this.sys.client.tenant.findUnique({ where: { slug }, select: { id: true } }))?.id ?? null;
    return tryCtx()?.hostTenantId ?? null;
  }
  async require(slug?: string | null): Promise<Tenant> {
    const id = await this.resolveId(slug);
    const tenant = id ? await this.sys.client.tenant.findUnique({ where: { id } }) : null;
    if (!tenant || tenant.status === 'ARCHIVED') throw Errors.notFound('Centre');
    return tenant;
  }

  /**
   * Link into a tenant's customer / corporate portal. Uses the primary verified
   * custom domain when there is one; otherwise the shared portal with the centre
   * selected by the `tenant` query parameter.
   */
  async portalLink(tenantId: string, path = '', params: Record<string, string> = {}, app: 'customer' | 'corporate' = 'customer'): Promise<string> {
    // A domain that the plan no longer covers does not resolve: links must not point at it.
    const primary = (await this.customDomainsIncluded(tenantId))
      ? await this.sys.client.tenantDomain.findFirst({ where: { tenantId, app, status: 'VERIFIED' }, orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }] })
      : null;
    const qs = new URLSearchParams(params);
    let base: string;
    if (primary) base = `https://${primary.domain}`;
    else {
      const tenant = await this.sys.client.tenant.findUnique({ where: { id: tenantId }, select: { slug: true } });
      base = app === 'corporate' ? env().CORPORATE_WEB_URL : env().CUSTOMER_WEB_URL;
      if (tenant) qs.set('tenant', tenant.slug);
    }
    const query = qs.toString();
    return `${base}${path}${query ? `?${query}` : ''}`;
  }

  /** Origins allowed by CORS: configured app URLs plus verified tenant domains. */
  async isAllowedOrigin(origin: string): Promise<boolean> {
    const e = env();
    const fixed = [e.CENTRE_WEB_URL, e.CUSTOMER_WEB_URL, e.CORPORATE_WEB_URL, e.PLATFORM_ADMIN_URL, ...e.CORS_ORIGINS];
    if (fixed.includes(origin)) return true;
    try {
      return (await this.fromHost(new URL(origin).host)) !== null;
    } catch {
      return false;
    }
  }
}
