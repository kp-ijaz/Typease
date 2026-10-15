import { Injectable, Logger } from '@nestjs/common';
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { OffboardTenantInput } from '@typease/validation';
import { env } from '../../config/env';
import { AuditService } from '../../common/audit.service';
import { ctx, tryCtx } from '../../common/context';
import { SystemDb, Tx } from '../../common/db/prisma.service';
import { Errors, found } from '../../common/errors';
import { JobQueue } from '../../common/jobs/job-queue';
import { StorageService } from '../storage/storage.service';
import { TenantResolver } from '../tenancy/tenant-resolver.service';
import { auditForCentre } from './platform.util';
import { ForeignKey, KEPT_AFTER_PURGE, purgeOrder, safeIdentifier } from './purge-plan';
import { OFFBOARDING_POLICY_KEY, OffboardingPolicy, PlatformSettingsService } from './settings.service';
import { actionProblem } from './tenant-status';
import { PlatformTenantsService } from './tenants.service';

export const OFFBOARDING_JOB = 'platform.offboarding';
const DAY = 86_400_000;
const ASSET_KEY = /^[A-Za-z0-9_-]{16,80}\.(png|jpg|webp)$/;

export interface PurgeResult {
  tenantId: string;
  slug: string;
  storageObjects: number;
  publicAssets: number;
  users: number;
  rows: Record<string, number>;
}

/**
 * Controlled offboarding of a centre.
 *
 *  1. `offboard`  - a Super Admin types the centre's slug; the centre is
 *     archived, everybody is signed out, its domains stop working and a purge
 *     date is set (at least 30 days ahead unless explicitly immediate).
 *  2. `cancel`    - until that date the offboarding can be cancelled.
 *  3. `runDue`    - the daily job permanently deletes what is due: first the
 *     stored files, then every row of the centre in ONE transaction.
 *
 * Nothing is exported automatically. The manual export procedure for the
 * owner is described in docs/api/modules/platform.md.
 */
@Injectable()
export class OffboardingService {
  private readonly logger = new Logger(OffboardingService.name);
  private s3?: S3Client;

  constructor(
    private readonly sys: SystemDb,
    private readonly audit: AuditService,
    private readonly tenants: PlatformTenantsService,
    private readonly settings: PlatformSettingsService,
    private readonly storage: StorageService,
    private readonly jobs: JobQueue,
    private readonly resolver: TenantResolver,
  ) {}

  private assertSuperAdmin() {
    // The route already requires platform.tenants.manage; deleting a centre is reserved to Super Admins by name,
    // so a later change to the permission matrix cannot silently widen it.
    if (ctx().platformRole !== 'SUPER_ADMIN') throw Errors.forbidden('SUPER_ADMIN_ONLY', 'Only a Platform Super Admin can offboard a centre.');
  }

  async offboard(id: string, input: OffboardTenantInput) {
    this.assertSuperAdmin();
    const tenant = await this.tenants.require(id);
    if (input.confirmSlug !== tenant.slug) throw Errors.unprocessable('CONFIRMATION_MISMATCH', `To confirm, type the centre's web address name exactly: ${tenant.slug}`);
    const policy = await this.settings.value<OffboardingPolicy>(OFFBOARDING_POLICY_KEY);
    const minDays = Math.max(30, policy.minPurgeDelayDays);
    if (input.immediate) {
      if (input.confirmImmediate !== `PURGE ${tenant.slug}`) {
        throw Errors.unprocessable('IMMEDIATE_CONFIRMATION_REQUIRED', `Immediate deletion cannot be undone. To confirm, send confirmImmediate: "PURGE ${tenant.slug}".`);
      }
    } else if (input.purgeAfterDays < minDays) {
      throw Errors.unprocessable('PURGE_DELAY_TOO_SHORT', `The data is kept for at least ${minDays} days before it is deleted.`, { minPurgeDelayDays: minDays });
    }
    const now = new Date();
    const purgeAt = input.immediate ? now : new Date(now.getTime() + input.purgeAfterDays * DAY);

    const result = await this.sys.tx(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "tenants" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const current = found(await tx.tenant.findUnique({ where: { id } }), 'Centre');
      const problem = actionProblem('offboard', current);
      if (problem) throw Errors.conflict(problem.code, problem.message);
      const updated = await tx.tenant.update({ where: { id }, data: { status: 'ARCHIVED', archivedAt: current.archivedAt ?? now, offboardingAt: purgeAt } });
      await this.tenants.endSubscription(tx, id, `Centre offboarded by TypEase: ${input.reason}`);
      const sessions = await this.tenants.endSessions(tx, id, 'TENANT_OFFBOARDED');
      const domains = await tx.tenantDomain.updateMany({ where: { tenantId: id, status: { not: 'DISABLED' } }, data: { status: 'DISABLED', isPrimary: false } });
      const grants = await tx.accessGrant.updateMany({ where: { tenantId: id, status: { in: ['REQUESTED', 'APPROVED'] } }, data: { status: 'REVOKED', revokedAt: now } });
      return { before: current, after: updated, sessions, domains: domains.count, grants: grants.count };
    });
    this.resolver.invalidate();
    await auditForCentre(
      this.audit,
      {
        action: 'tenant.offboarding_scheduled',
        resourceType: 'Tenant',
        resourceId: id,
        summary: `${tenant.name}: offboarding scheduled, data will be permanently deleted ${input.immediate ? 'immediately' : `on ${purgeAt.toISOString().slice(0, 10)}`}`,
        before: { status: result.before.status },
        after: { status: 'ARCHIVED', purgeAt: purgeAt.toISOString(), immediate: input.immediate, reason: input.reason, sessionsEnded: result.sessions, domainsDisabled: result.domains, accessGrantsRevoked: result.grants },
      },
      tenant,
    );
    await this.audit.security('TENANT_OFFBOARDING_SCHEDULED', 'HIGH', { purgeAt: purgeAt.toISOString(), immediate: input.immediate }, id);
    // An immediate offboarding does not wait for the nightly run.
    if (input.immediate) await this.jobs.enqueue(OFFBOARDING_JOB, {}, { attempts: 1 });
    const detail = await this.tenants.detail(id);
    return { ...detail, offboarding: { ...detail.offboarding, purgeAt, reason: input.reason, immediate: input.immediate, dataExport: 'NOT_AUTOMATIC' as const } };
  }

  /** Withdraws a scheduled offboarding before its date. The centre stays archived; reactivate it separately. */
  async cancel(id: string, reason: string) {
    this.assertSuperAdmin();
    const { tenant, domains } = await this.sys.tx(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "tenants" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const current = found(await tx.tenant.findUnique({ where: { id } }), 'Centre');
      const problem = actionProblem('cancelOffboarding', current);
      if (problem) throw Errors.conflict(problem.code, problem.message);
      if (current.offboardingAt! <= new Date()) throw Errors.conflict('OFFBOARDING_DUE', 'The deletion date has passed: this centre is being deleted and can no longer be kept.');
      await tx.tenant.update({ where: { id }, data: { offboardingAt: null } });
      // Domains were switched off by the offboarding; they have to prove ownership again.
      const reset = await tx.tenantDomain.updateMany({ where: { tenantId: id, status: 'DISABLED' }, data: { status: 'PENDING', verifiedAt: null, lastCheckError: null } });
      return { tenant: current, domains: reset.count };
    });
    this.resolver.invalidate();
    await auditForCentre(
      this.audit,
      { action: 'tenant.offboarding_cancelled', resourceType: 'Tenant', resourceId: id, summary: `${tenant.name}: offboarding cancelled, nothing was deleted`, before: { purgeAt: tenant.offboardingAt!.toISOString() }, after: { purgeAt: null, reason, domainsToVerifyAgain: domains } },
      tenant,
    );
    await this.audit.security('TENANT_OFFBOARDING_CANCELLED', 'MEDIUM', { reason }, id);
    return this.tenants.detail(id);
  }

  // ------------------------------------------------------------------ purge
  /** Job: permanently delete every centre whose offboarding date has passed. One failure never stops the others. */
  async runDue(now = new Date()): Promise<{ purged: PurgeResult[]; failed: Array<{ tenantId: string; error: string }> }> {
    const due = await this.sys.client.tenant.findMany({ where: { status: 'ARCHIVED', offboardingAt: { not: null, lte: now } }, select: { id: true, slug: true }, orderBy: { offboardingAt: 'asc' } });
    const purged: PurgeResult[] = [];
    const failed: Array<{ tenantId: string; error: string }> = [];
    for (const tenant of due) {
      try {
        const result = await this.purge(tenant.id, now);
        if (result) purged.push(result);
      } catch (e: any) {
        failed.push({ tenantId: tenant.id, error: String(e?.message ?? e).slice(0, 500) });
        this.logger.error(`purge of centre ${tenant.slug} (${tenant.id}) failed: ${e?.stack ?? e}`);
        await this.audit.security('TENANT_PURGE_FAILED', 'HIGH', { slug: tenant.slug, error: String(e?.message ?? e).slice(0, 300) }, tenant.id);
      }
    }
    return { purged, failed };
  }

  private async tenantTables(tx: Tx): Promise<{ tables: string[]; foreignKeys: ForeignKey[] }> {
    const tables = await tx.$queryRaw<Array<{ name: string }>>`
      SELECT c.relname::text AS name FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attname = 'tenantId' AND NOT a.attisdropped`;
    const foreignKeys = await tx.$queryRaw<ForeignKey[]>`
      SELECT child.relname::text AS child, parent.relname::text AS parent, con.confdeltype::text AS rule
      FROM pg_constraint con
      JOIN pg_class child ON child.oid = con.conrelid JOIN pg_class parent ON parent.oid = con.confrelid
      JOIN pg_namespace n ON n.oid = child.relnamespace
      WHERE con.contype = 'f' AND n.nspname = 'public'`;
    return { tables: tables.map((t) => t.name), foreignKeys };
  }

  /**
   * Deletes one centre for good. Returns null when there is nothing (left) to
   * do. Safe to run twice and from two workers at once: files are deleted
   * idempotently, and the database part re-checks the centre under a row lock.
   */
  async purge(tenantId: string, now = new Date()): Promise<PurgeResult | null> {
    const tenant = await this.sys.client.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant || tenant.status !== 'ARCHIVED' || !tenant.offboardingAt || tenant.offboardingAt > now) return null;

    // 1. Files first: while the centre's row still exists a failed run is simply retried tomorrow.
    const branding = await this.sys.client.brandingSettings.findMany({ where: { tenantId }, select: { logoAssetKey: true, faviconAssetKey: true } });
    const assetKeys = [...new Set(branding.flatMap((b) => [b.logoAssetKey, b.faviconAssetKey]).filter((k): k is string => !!k))];
    const storage = await this.storage.deleteTenantObjects(tenantId);
    const publicAssets = await this.deletePublicAssets(assetKeys);

    // 2. Every row of the centre, in one transaction.
    const actor = tryCtx();
    const result = await this.sys.tx(
      async (tx) => {
        // Lets this transaction (and only this one) delete from append-only and immutable tables.
        await tx.$executeRawUnsafe(`SET LOCAL typease.allow_purge = 'on'`);
        await tx.$queryRaw`SELECT "id" FROM "tenants" WHERE "id" = ${tenantId}::uuid FOR UPDATE`;
        const current = await tx.tenant.findUnique({ where: { id: tenantId } });
        if (!current || current.status !== 'ARCHIVED' || !current.offboardingAt || current.offboardingAt > now) return null;

        // TypEase's own invoices to this centre are summarised on the platform trail before they go.
        const invoices = await tx.subscriptionInvoice.findMany({ where: { tenantId }, orderBy: { createdAt: 'asc' }, take: 500, select: { number: true, status: true, total: true, currency: true, periodStart: true, periodEnd: true, paidAt: true } });

        // Accounts that exist only because of this centre go with it. Platform staff and people who
        // also belong to another centre keep their account.
        const users = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT u."id"::text AS id FROM "users" u
          WHERE u."platformRole" IS NULL
            AND EXISTS (SELECT 1 FROM "tenant_memberships" m WHERE m."userId" = u."id" AND m."tenantId" = ${tenantId}::uuid)
            AND NOT EXISTS (SELECT 1 FROM "tenant_memberships" m WHERE m."userId" = u."id" AND m."tenantId" <> ${tenantId}::uuid)`;
        const userIds = users.map((u) => u.id);

        const { tables, foreignKeys } = await this.tenantTables(tx);
        const rows: Record<string, number> = {};
        for (const table of purgeOrder(tables, foreignKeys)) {
          const deleted = await tx.$executeRawUnsafe(`DELETE FROM ${safeIdentifier(table)} WHERE "tenantId" = $1::uuid`, tenantId);
          if (deleted) rows[table] = deleted;
        }
        if (userIds.length) {
          rows.login_activity = (rows.login_activity ?? 0) + (await tx.$executeRaw`DELETE FROM "login_activity" WHERE "userId" = ANY(${userIds}::uuid[])`);
          // Sessions and one-time tokens of these accounts cascade with the user row.
          await tx.$executeRaw`DELETE FROM "users" WHERE "id" = ANY(${userIds}::uuid[])`;
        }
        await tx.$executeRaw`DELETE FROM "tenants" WHERE "id" = ${tenantId}::uuid`;

        await tx.auditLog.create({
          data: {
            tenantId: null,
            actorUserId: actor?.userId ?? null,
            actorType: actor?.actorType ?? 'SYSTEM',
            actorLabel: actor?.actorLabel ?? 'system',
            action: 'tenant.purged',
            resourceType: 'Tenant',
            resourceId: tenantId,
            summary: `${current.name} [centre ${current.slug}] permanently deleted`,
            after: {
              slug: current.slug,
              name: current.name,
              legalName: current.legalName,
              scheduledFor: current.offboardingAt.toISOString(),
              storageObjects: storage.removed,
              publicAssets,
              usersDeleted: userIds.length,
              rows,
              kept: KEPT_AFTER_PURGE,
              subscriptionInvoices: invoices.map((i) => ({ number: i.number, status: i.status, total: i.total.toFixed(2), currency: i.currency, periodStart: i.periodStart.toISOString().slice(0, 10), periodEnd: i.periodEnd.toISOString().slice(0, 10), paidAt: i.paidAt?.toISOString() ?? null })),
            },
            requestId: actor?.requestId ?? null,
          },
        });
        return { tenantId, slug: current.slug, storageObjects: storage.removed, publicAssets, users: userIds.length, rows } satisfies PurgeResult;
      },
      { timeoutMs: 15 * 60_000 },
    );
    if (result) {
      this.resolver.invalidate();
      this.logger.warn(`centre ${result.slug} (${tenantId}) was permanently deleted: ${Object.values(result.rows).reduce((a, b) => a + b, 0)} rows, ${result.storageObjects} files`);
    }
    return result;
  }

  /** Logos and favicons live in the public asset store under random names recorded in branding_settings. */
  private async deletePublicAssets(keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      if (!ASSET_KEY.test(key)) continue;
      try {
        if (env().STORAGE_DRIVER === 's3') {
          this.s3 ??= new S3Client({
            region: env().S3_REGION,
            endpoint: env().S3_ENDPOINT,
            forcePathStyle: env().S3_FORCE_PATH_STYLE,
            credentials: env().S3_ACCESS_KEY_ID ? { accessKeyId: env().S3_ACCESS_KEY_ID!, secretAccessKey: env().S3_SECRET_ACCESS_KEY! } : undefined,
          });
          await this.s3.send(new DeleteObjectCommand({ Bucket: env().S3_PUBLIC_ASSETS_BUCKET, Key: key }));
        } else {
          await rm(join(resolve(env().STORAGE_LOCAL_DIR, 'public-assets'), key), { force: true });
        }
        removed += 1;
      } catch (e: any) {
        // A leftover logo is not personal data; never fail the purge over it.
        this.logger.warn(`public asset ${key} could not be deleted: ${e?.message ?? e}`);
      }
    }
    return removed;
  }
}
