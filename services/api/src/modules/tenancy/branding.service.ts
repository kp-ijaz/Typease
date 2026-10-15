import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { TenantDomain } from '@typease/database';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { promises as dns } from 'node:dns';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { PublicTenantConfig } from '@typease/types';
import type { PlatformDomainQuery } from '@typease/validation';
import { env } from '../../config/env';
import { AuditService } from '../../common/audit.service';
import { ctx } from '../../common/context';
import { randomToken } from '../../common/crypto';
import { Prisma, SystemDb, TenantDb } from '../../common/db/prisma.service';
import { pageArgs, pageResult } from '../../common/pagination';
import { Errors, found } from '../../common/errors';
import { isWhiteLabel } from '../../common/white-label';
import { JobQueue } from '../../common/jobs/job-queue';
import { PasswordPolicy, passwordPolicy } from '../../common/password-policy';
import { detectMime, extensionFor } from '../../common/files';
import { UsageService } from '../../common/usage.service';
import { RESERVED_SLUGS } from './onboarding.service';
import { TenantResolver } from './tenant-resolver.service';

/** Official TypEase palette, sampled from the supplied logo. */
export const TYPEASE_COLORS = { primary: '#0B2240', secondary: '#0B7AD1', accent: '#00A166' };
const ASSET_MIME = ['image/png', 'image/jpeg', 'image/webp'];
const ASSET_MAX_BYTES = 1024 * 1024;

/** An unverified claim older than this no longer blocks another centre that claims the same domain. */
export const DOMAIN_CLAIM_RELEASE_HOURS = 72;
/** Unverified claims older than this are removed by the daily clean-up. */
export const DOMAIN_CLAIM_EXPIRY_DAYS = 14;
export const DOMAIN_CLEANUP_JOB = 'tenancy.domain_claims_cleanup';
/** A claim that was never proven: only these are ever released automatically. Verified domains stay exclusive. */
const NEVER_VERIFIED = { status: { in: ['PENDING', 'FAILED'] as Array<'PENDING' | 'FAILED'> }, verifiedAt: null };

/** DNS lookups are behind a port so tests can supply deterministic answers. */
export abstract class DnsLookup {
  abstract resolveTxt(name: string): Promise<string[]>;
}
@Injectable()
export class SystemDnsLookup extends DnsLookup {
  async resolveTxt(name: string): Promise<string[]> {
    const resolver = new dns.Resolver({ timeout: 4000, tries: 2 });
    try {
      return (await resolver.resolveTxt(name)).map((chunks) => chunks.join(''));
    } catch (e: any) {
      if (['ENOTFOUND', 'ENODATA', 'ESERVFAIL', 'ETIMEOUT'].includes(e?.code)) return [];
      throw e;
    }
  }
}

/** Public, non-sensitive brand assets (logos, favicons). Private documents never go here. */
@Injectable()
export class PublicAssetStore {
  private s3?: S3Client;
  private dir = resolve(env().STORAGE_LOCAL_DIR, 'public-assets');

  private client(): S3Client {
    return (this.s3 ??= new S3Client({
      region: env().S3_REGION,
      endpoint: env().S3_ENDPOINT,
      forcePathStyle: env().S3_FORCE_PATH_STYLE,
      credentials: env().S3_ACCESS_KEY_ID ? { accessKeyId: env().S3_ACCESS_KEY_ID!, secretAccessKey: env().S3_SECRET_ACCESS_KEY! } : undefined,
    }));
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    if (env().STORAGE_DRIVER === 's3') {
      await this.client().send(new PutObjectCommand({ Bucket: env().S3_PUBLIC_ASSETS_BUCKET, Key: key, Body: body, ContentType: contentType, CacheControl: 'public, max-age=31536000, immutable' }));
      return;
    }
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, key), body);
  }

  /** Reads an asset from whichever store is active. Keys are random and validated, never user-supplied paths. */
  async read(key: string): Promise<Buffer | null> {
    if (!/^[A-Za-z0-9_-]{16,80}\.(png|jpg|webp)$/.test(key)) return null;
    try {
      if (env().STORAGE_DRIVER === 's3') {
        const out = await this.client().send(new GetObjectCommand({ Bucket: env().S3_PUBLIC_ASSETS_BUCKET, Key: key }));
        return out.Body ? Buffer.from(await out.Body.transformToByteArray()) : null;
      }
      return await readFile(join(this.dir, key));
    } catch {
      return null;
    }
  }

  /** Public URL of an asset: the configured CDN / bucket URL, otherwise the API's own asset route. */
  url(key: string | null | undefined): string | null {
    if (!key) return null;
    const base = env().S3_PUBLIC_ASSETS_BASE_URL;
    return base && env().STORAGE_DRIVER === 's3' ? `${base.replace(/\/+$/, '')}/${key}` : `${env().API_PUBLIC_URL}/api/v1/public/assets/${key}`;
  }
}

@Injectable()
export class BrandingService implements OnModuleInit {
  private readonly logger = new Logger(BrandingService.name);
  constructor(
    private readonly db: TenantDb,
    private readonly sys: SystemDb,
    private readonly audit: AuditService,
    private readonly usage: UsageService,
    private readonly assets: PublicAssetStore,
    private readonly resolver: TenantResolver,
    private readonly dnsLookup: DnsLookup,
    private readonly jobs: JobQueue,
  ) {}

  onModuleInit() {
    this.jobs.register(DOMAIN_CLEANUP_JOB, async () => void (await this.cleanUpDomainClaims()), { attempts: 1 });
    this.jobs.schedule({ name: DOMAIN_CLEANUP_JOB, cron: '10 3 * * *', description: `Remove custom-domain claims that were never verified and are older than ${DOMAIN_CLAIM_EXPIRY_DAYS} days` });
  }

  // ------------------------------------------------------------------ public presentation
  /** What an unauthenticated visitor may know about a centre: name, colours, logo, contact. */
  async publicConfig(tenantId: string, branchId?: string | null): Promise<PublicTenantConfig & { passwordPolicy: PasswordPolicy }> {
    const tenant = found(await this.sys.client.tenant.findUnique({ where: { id: tenantId } }), 'Centre');
    if (['ARCHIVED', 'CANCELLED'].includes(tenant.status)) throw Errors.notFound('Centre');
    const rows = await this.sys.client.brandingSettings.findMany({ where: { tenantId, OR: [{ branchId: null }, ...(branchId ? [{ branchId }] : [])] } });
    const base = rows.find((r) => r.branchId === null);
    const branch = rows.find((r) => r.branchId !== null);
    const pickField = <K extends keyof NonNullable<typeof base>>(k: K) => (branch?.[k] ?? base?.[k] ?? null) as any;
    const sub = await this.sys.client.subscription.findUnique({ where: { tenantId }, include: { plan: true } });
    const features = { ...((sub?.plan.features as Record<string, boolean>) ?? {}) };
    // White-label presentation applies only when the plan includes it AND the centre switched it on.
    const whiteLabel = isWhiteLabel(base?.mode, features);
    return {
      tenantId: tenant.id,
      slug: tenant.slug,
      name: pickField('businessName') ?? tenant.name,
      nameAr: pickField('businessNameAr'),
      mode: whiteLabel ? 'WHITE_LABEL' : 'TYPEASE',
      logoUrl: whiteLabel ? this.assets.url(pickField('logoAssetKey')) : null,
      faviconUrl: whiteLabel ? this.assets.url(pickField('faviconAssetKey')) : null,
      colors: whiteLabel
        ? {
            primary: pickField('primaryColor') ?? TYPEASE_COLORS.primary,
            secondary: pickField('secondaryColor') ?? TYPEASE_COLORS.secondary,
            accent: pickField('accentColor') ?? TYPEASE_COLORS.accent,
          }
        : TYPEASE_COLORS,
      websiteTitle: (whiteLabel ? pickField('websiteTitle') : null) ?? `${pickField('businessName') ?? tenant.name}`,
      tagline: (whiteLabel ? pickField('tagline') : null) ?? (whiteLabel ? null : 'Typing Made Easy.'),
      supportEmail: pickField('supportEmail') ?? tenant.contactEmail,
      supportPhone: pickField('supportPhone') ?? tenant.contactPhone,
      defaultLanguage: tenant.defaultLanguage,
      currency: tenant.defaultCurrency,
      timezone: tenant.timezone,
      publicCatalogueEnabled: base?.publicCatalogueEnabled ?? true,
      features: {
        selfRegistration: (tenant.settings as any)?.allowSelfRegistration !== false,
        corporatePortal: features.corporatePortal === true,
        open: ['TRIAL', 'ACTIVE', 'PAST_DUE'].includes(tenant.status),
      },
      // What a new password must satisfy, so that forms can say it before the request is sent.
      passwordPolicy: passwordPolicy(),
    };
  }

  // ------------------------------------------------------------------ settings
  async get() {
    return this.db.tx(async (tx) => {
      const rows = await tx.brandingSettings.findMany({ where: { tenantId: this.db.tenantId }, orderBy: { createdAt: 'asc' } });
      const shape = (r: (typeof rows)[number]) => ({ ...r, logoUrl: this.assets.url(r.logoAssetKey), faviconUrl: this.assets.url(r.faviconAssetKey) });
      const whiteLabelIncluded = await this.usage.hasFeature('whiteLabel', tx);
      return { tenant: rows.filter((r) => !r.branchId).map(shape)[0] ?? null, branches: rows.filter((r) => r.branchId).map(shape), whiteLabelIncluded, defaults: TYPEASE_COLORS };
    });
  }

  async update(input: Record<string, any>, branchId: string | null = null) {
    return this.db.tx(async (tx) => {
      if (branchId) found(await tx.branch.findFirst({ where: { id: branchId, tenantId: this.db.tenantId } }), 'Branch');
      const wantsWhiteLabel = input.mode === 'WHITE_LABEL' || ['primaryColor', 'secondaryColor', 'accentColor', 'websiteTitle', 'tagline'].some((k) => input[k]);
      if (wantsWhiteLabel) await this.usage.assertFeature('whiteLabel', tx);
      const existing = await tx.brandingSettings.findFirst({ where: { tenantId: this.db.tenantId, branchId } });
      const data: any = { ...input, updatedById: ctx().userId };
      if (branchId) delete data.mode;
      // A changed sender address must be verified again with the email provider before it is used.
      if (input.emailFromAddress !== undefined && input.emailFromAddress !== existing?.emailFromAddress) data.emailSenderVerified = false;
      const saved = existing
        ? await tx.brandingSettings.update({ where: { id: existing.id }, data })
        : await tx.brandingSettings.create({ data: { ...data, tenantId: this.db.tenantId, branchId } });
      await this.audit.log({ action: 'branding.updated', resourceType: 'BrandingSettings', resourceId: saved.id, after: input }, tx);
      return { ...saved, logoUrl: this.assets.url(saved.logoAssetKey), faviconUrl: this.assets.url(saved.faviconAssetKey) };
    });
  }

  async uploadAsset(kind: 'logo' | 'favicon', file: { buffer: Buffer; size: number } | undefined, branchId: string | null = null) {
    if (!file?.buffer?.length) throw Errors.badRequest('FILE_REQUIRED', 'Choose an image to upload.');
    if (file.size > ASSET_MAX_BYTES) throw Errors.badRequest('FILE_TOO_LARGE', 'The image must be 1 MB or smaller.');
    const mime = detectMime(file.buffer.subarray(0, 16));
    if (!mime || !ASSET_MIME.includes(mime)) throw Errors.badRequest('FILE_TYPE_NOT_ALLOWED', 'Upload a PNG, JPEG or WebP image.');
    await this.db.tx((tx) => this.usage.assertFeature('whiteLabel', tx));
    const key = `${randomToken(24)}.${extensionFor(mime)}`;
    await this.assets.put(key, file.buffer, mime);
    return this.update(kind === 'logo' ? { logoAssetKey: key } : { faviconAssetKey: key }, branchId);
  }

  // ------------------------------------------------------------------ custom domains
  private instructions(domain: string, token: string) {
    return {
      txt: { name: `_typease-verify.${domain}`, value: `typease-verify=${token}` },
      cname: { name: domain, value: env().CUSTOM_DOMAIN_CNAME_TARGET },
      note: 'Add both DNS records, wait for them to propagate, then press Verify. The TLS certificate is issued automatically after verification.',
    };
  }

  /**
   * What the centre sees of a domain. `status` is the stored status, except that a verified domain of a centre
   * whose plan does not include custom domains is shown as SUSPENDED_BY_PLAN: it is kept (and stays exclusive),
   * but it does not resolve and gets no certificate until the plan includes the feature again.
   */
  private domainView(row: TenantDomain, included: boolean) {
    const { verificationToken, ...d } = row;
    const suspended = d.status === 'VERIFIED' && !included;
    return {
      ...d,
      status: (suspended ? 'SUSPENDED_BY_PLAN' : d.status) as TenantDomain['status'] | 'SUSPENDED_BY_PLAN',
      /** True only while the portal is actually reachable on this domain. */
      routed: d.status === 'VERIFIED' && included,
      /** For an unverified claim: when another centre may take the domain over, and when the claim is removed. */
      claim: d.status !== 'VERIFIED' && !d.verifiedAt
        ? { releasableAt: new Date(d.createdAt.getTime() + DOMAIN_CLAIM_RELEASE_HOURS * 3_600_000), expiresAt: new Date(d.createdAt.getTime() + DOMAIN_CLAIM_EXPIRY_DAYS * 86_400_000) }
        : null,
      dns: d.status === 'VERIFIED' ? null : this.instructions(d.domain, verificationToken),
    };
  }

  async listDomains() {
    return this.db.tx(async (tx) => {
      const tenant = await tx.tenant.findFirstOrThrow({ where: { id: this.db.tenantId } });
      const rows = await tx.tenantDomain.findMany({ where: { tenantId: this.db.tenantId }, orderBy: { createdAt: 'asc' } });
      const included = await this.usage.hasFeature('customDomains', tx);
      return {
        platformDomain: `${tenant.slug}.${env().PLATFORM_BASE_DOMAIN}`,
        customDomainsIncluded: included,
        domains: rows.map((d) => this.domainView(d, included)),
      };
    });
  }

  async addDomain(input: { domain: string; app: string }) {
    const base = env().PLATFORM_BASE_DOMAIN.toLowerCase();
    if (input.domain === base || input.domain.endsWith(`.${base}`) || RESERVED_SLUGS.some((r) => input.domain === `${r}.${base}`)) {
      throw Errors.badRequest('DOMAIN_NOT_ALLOWED', 'Use a domain that you own. TypEase addresses are assigned automatically.');
    }
    const tenantId = this.db.tenantId;
    // Before anything is released for this centre: it must be allowed to have a custom domain at all.
    await this.usage.assertFeature('customDomains');
    const inUse = () => Errors.conflict('DOMAIN_IN_USE', 'This domain is already connected to a TypEase account. Contact support if you own it.');
    // Global uniqueness: a domain can be claimed by one tenant only. The reply never reveals who holds it.
    const existing = await this.sys.client.tenantDomain.findUnique({ where: { domain: input.domain } });
    if (existing) {
      if (existing.tenantId === tenantId) throw Errors.conflict('DOMAIN_ALREADY_ADDED', 'You have already added this domain.');
      // Somebody else claimed it but never proved ownership: after 72 hours the claim no longer blocks anybody.
      const stale = !existing.verifiedAt && ['PENDING', 'FAILED'].includes(existing.status) && existing.createdAt.getTime() <= Date.now() - DOMAIN_CLAIM_RELEASE_HOURS * 3_600_000;
      if (!stale || !(await this.releaseClaim(existing, 'SUPERSEDED'))) throw inUse();
    }
    try {
      return await this.db.tx(async (tx) => {
        const token = randomToken(24);
        const row = await tx.tenantDomain.create({ data: { tenantId, domain: input.domain, app: input.app, kind: 'CUSTOM', verificationToken: token, status: 'PENDING', createdById: ctx().userId } });
        await this.audit.log({ action: 'domain.added', resourceType: 'TenantDomain', resourceId: row.id, after: { domain: input.domain, app: input.app, ...(existing ? { replacedUnverifiedClaim: true } : {}) } }, tx);
        return this.domainView(row, true);
      });
    } catch (e: any) {
      // Two centres asked at the same moment: the database lets exactly one of them have the domain.
      if (e?.code === 'P2002') throw inUse();
      throw e;
    }
  }

  /**
   * Removes a claim that was never verified - and only such a claim: the DELETE is conditional, so a domain that
   * was verified in the meantime stays. Recorded on the trail of the centre that held the claim. Nobody is notified.
   */
  private async releaseClaim(row: Pick<TenantDomain, 'id' | 'tenantId' | 'domain' | 'status' | 'createdAt'>, reason: 'SUPERSEDED' | 'EXPIRED'): Promise<boolean> {
    const removed = await this.sys.client.tenantDomain.deleteMany({ where: { id: row.id, ...NEVER_VERIFIED } });
    if (removed.count !== 1) return false;
    this.resolver.invalidate();
    await this.sys.client.auditLog.create({
      data: {
        tenantId: row.tenantId, actorType: 'SYSTEM', actorLabel: 'system', action: 'domain.claim_released', resourceType: 'TenantDomain', resourceId: row.id,
        summary: reason === 'SUPERSEDED' ? `The unverified claim on ${row.domain} was released: another account claimed the domain` : `The unverified claim on ${row.domain} was removed: it was not verified within ${DOMAIN_CLAIM_EXPIRY_DAYS} days`,
        before: { domain: row.domain, status: row.status, claimedAt: row.createdAt.toISOString() }, after: { reason },
      },
    });
    return true;
  }

  /** Daily job: unverified claims older than 14 days are removed. Verified domains are never touched. */
  async cleanUpDomainClaims(now = new Date()): Promise<{ removed: number }> {
    const cutoff = new Date(now.getTime() - DOMAIN_CLAIM_EXPIRY_DAYS * 86_400_000);
    const stale = await this.sys.client.tenantDomain.findMany({ where: { ...NEVER_VERIFIED, createdAt: { lte: cutoff } }, orderBy: { createdAt: 'asc' }, take: 500 });
    let removed = 0;
    for (const row of stale) if (await this.releaseClaim(row, 'EXPIRED')) removed += 1;
    if (removed) this.logger.log(`removed ${removed} unverified domain claim(s) older than ${DOMAIN_CLAIM_EXPIRY_DAYS} days`);
    return { removed };
  }

  /** Platform console: claims across all centres, to find the one somebody is asking about. */
  async listDomainsForPlatform(query: PlatformDomainQuery) {
    const where: Prisma.TenantDomainWhereInput = {
      ...(query.q ? { domain: { contains: query.q } } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.centreId ? { tenantId: query.centreId } : {}),
    };
    const [rows, total] = await Promise.all([
      this.sys.client.tenantDomain.findMany({ where, ...pageArgs(query, ['createdAt', 'domain', 'status'] as const, 'createdAt:desc'), include: { tenant: { select: { id: true, slug: true, name: true, status: true, subscription: { select: { plan: { select: { key: true, features: true } } } } } } } }),
      this.sys.client.tenantDomain.count({ where }),
    ]);
    return pageResult(
      rows.map(({ verificationToken: _token, tenant, ...d }) => {
        const included = ((tenant.subscription?.plan.features ?? {}) as Record<string, unknown>).customDomains === true;
        return {
          ...d,
          status: d.status === 'VERIFIED' && !included ? ('SUSPENDED_BY_PLAN' as const) : d.status,
          routed: d.status === 'VERIFIED' && included,
          ageHours: Math.floor((Date.now() - d.createdAt.getTime()) / 3_600_000),
          centre: { id: tenant.id, slug: tenant.slug, name: tenant.name, status: tenant.status, planKey: tenant.subscription?.plan.key ?? null },
        };
      }),
      total,
      query,
    );
  }

  /**
   * Platform staff release any claim - verified or not - for example after a dispute about who owns a domain.
   * Recorded on the platform trail and on the trail of the centre that held it.
   */
  async releaseByPlatform(id: string, reason: string) {
    const row = found(await this.sys.client.tenantDomain.findUnique({ where: { id } }), 'Domain');
    const tenant = await this.sys.client.tenant.findUnique({ where: { id: row.tenantId }, select: { slug: true } });
    const removed = await this.sys.client.tenantDomain.deleteMany({ where: { id } });
    if (removed.count !== 1) throw Errors.notFound('Domain');
    this.resolver.invalidate();
    const before = { domain: row.domain, status: row.status, verifiedAt: row.verifiedAt?.toISOString() ?? null, isPrimary: row.isPrimary, claimedAt: row.createdAt.toISOString() };
    await this.audit.logSystem({ action: 'domain.released_by_platform', resourceType: 'TenantDomain', resourceId: id, summary: `${row.domain} released [centre ${tenant?.slug ?? row.tenantId}]: ${reason}`, before, after: { reason } }, null, { strict: true });
    await this.audit.logSystem({ action: 'domain.released_by_platform', resourceType: 'TenantDomain', resourceId: id, summary: `${row.domain} was released by TypEase: ${reason}`, before, after: { reason } }, row.tenantId, { strict: true });
    // A released primary domain hands the role to the oldest remaining verified domain of the same app.
    if (row.isPrimary) {
      const next = await this.sys.client.tenantDomain.findFirst({ where: { tenantId: row.tenantId, app: row.app, status: 'VERIFIED' }, orderBy: { createdAt: 'asc' } });
      if (next) await this.sys.client.tenantDomain.update({ where: { id: next.id }, data: { isPrimary: true } });
    }
    return { id, domain: row.domain, status: 'RELEASED' as const };
  }

  /** Proves ownership through the DNS TXT record. Only then is the domain routed and a certificate issued. */
  async verifyDomain(id: string) {
    const row = await this.db.tx(async (tx) => found(await tx.tenantDomain.findFirst({ where: { id, tenantId: this.db.tenantId } }), 'Domain'));
    const expected = `typease-verify=${row.verificationToken}`;
    let records: string[] = [];
    let error: string | null = null;
    try {
      records = await this.dnsLookup.resolveTxt(`_typease-verify.${row.domain}`);
    } catch (e: any) {
      error = `DNS lookup failed: ${e?.code ?? e?.message}`;
    }
    const ok = records.map((r) => r.trim()).includes(expected);
    if (!ok && !error) error = records.length ? 'The TXT record was found but its value does not match.' : 'The TXT record was not found yet. DNS changes can take up to 48 hours.';
    // Verification state is system-controlled: the tenant-scoped role cannot write it.
    const others = ok ? await this.sys.client.tenantDomain.count({ where: { tenantId: row.tenantId, app: row.app, isPrimary: true, id: { not: row.id } } }) : 1;
    const updated = await this.sys.client.tenantDomain.update({
      where: { id: row.id },
      data: { status: ok ? 'VERIFIED' : row.status === 'VERIFIED' ? 'VERIFIED' : 'FAILED', verifiedAt: ok ? (row.verifiedAt ?? new Date()) : row.verifiedAt, lastCheckedAt: new Date(), lastCheckError: ok ? null : error, ...(ok && !others ? { isPrimary: true } : {}) },
    });
    this.resolver.invalidate();
    await this.audit.logSystem({ action: ok ? 'domain.verified' : 'domain.verification_failed', resourceType: 'TenantDomain', resourceId: row.id, summary: row.domain }, row.tenantId);
    const included = await this.resolver.customDomainsIncluded(row.tenantId);
    const message = !ok ? error : included ? 'Domain verified. Your portal will be reachable on it within a few minutes.' : 'Domain verified. It will be switched on when your plan includes custom domains.';
    return { ...this.domainView(updated, included), verified: ok, message };
  }

  async removeDomain(id: string) {
    await this.db.tx(async (tx) => {
      const row = found(await tx.tenantDomain.findFirst({ where: { id, tenantId: this.db.tenantId } }), 'Domain');
      await tx.tenantDomain.delete({ where: { id: row.id } });
      await this.audit.log({ action: 'domain.removed', resourceType: 'TenantDomain', resourceId: id, before: { domain: row.domain } }, tx);
    });
    this.resolver.invalidate();
    return { status: 'REMOVED' as const };
  }

  /** Reverse-proxy "may I issue a certificate for this host?" check (on-demand TLS). */
  async tlsAllowed(host: string): Promise<boolean> {
    return (await this.resolver.fromHost(host)) !== null;
  }
}
