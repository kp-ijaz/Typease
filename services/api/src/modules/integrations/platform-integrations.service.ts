import { Injectable } from '@nestjs/common';
import type { ApprovedProvidersInput, AuthorisationReviewQuery } from '@typease/validation';
import { AuditService } from '../../common/audit.service';
import { ctx } from '../../common/context';
import { Prisma, SystemDb } from '../../common/db/prisma.service';
import { Errors, found } from '../../common/errors';
import { pageArgs, pageResult } from '../../common/pagination';
import { ALL_PROVIDER_CODES, AUTHORISATION_KEY, AuthorisationMeta, AuthorisationState, findProvider, providerCode, PROVIDERS, splitProvider } from './catalogue';

export const APPROVED_PROVIDERS_KEY = 'integrations.approvedProviders';
const RECORD_CATEGORIES = ['GOVERNMENT', 'PARTNER'];
const SORT = ['createdAt', 'updatedAt'] as const;

/** Reads the stored allow-list. Anything that is not a list of known codes counts as "no restriction". */
export function parseApproved(value: unknown): Set<string> | null {
  if (!Array.isArray(value)) return null;
  return new Set(value.filter((v): v is string => typeof v === 'string' && ALL_PROVIDER_CODES.includes(v)));
}

/**
 * The platform side of integrations. This is the only file of the module that
 * uses the system database connection, for two things that are cross-tenant by
 * nature:
 *
 *  1. the platform-wide list of APPROVED providers (platform_settings), which
 *     decides what any centre may configure;
 *  2. the review of GOVERNMENT / PARTNER authorisation records.
 *
 * Every query on integration rows is pinned to those two record categories and
 * selects only the record itself: no credentials (they have none), and nothing
 * else of the centre beyond its name.
 */
@Injectable()
export class PlatformIntegrationsService {
  constructor(
    private readonly sys: SystemDb,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------------ approved providers
  /** `null` = every provider of the catalogue is approved (the default). */
  async approved(): Promise<Set<string> | null> {
    const row = await this.sys.client.platformSetting.findUnique({ where: { key: APPROVED_PROVIDERS_KEY } });
    return row ? parseApproved(row.value) : null;
  }
  async isApproved(category: string, provider: string): Promise<boolean> {
    const approved = await this.approved();
    return approved === null || approved.has(providerCode(category, splitProvider(provider).base));
  }

  async approvedView() {
    const approved = await this.approved();
    return {
      restricted: approved !== null,
      providers: PROVIDERS.map((p) => ({ code: providerCode(p.category, p.provider), category: p.category, provider: p.provider, name: p.name, kind: p.kind, approved: approved === null || approved.has(providerCode(p.category, p.provider)) })),
    };
  }

  /**
   * Replaces the allow-list (`null` removes the restriction). Integrations of
   * a provider that is no longer approved are switched off at once in every
   * centre, so nothing keeps flowing to a service the platform has withdrawn.
   */
  async setApproved(input: ApprovedProvidersInput) {
    const next = input.providers === null ? null : [...new Set(input.providers)];
    const unknown = (next ?? []).filter((code) => !ALL_PROVIDER_CODES.includes(code));
    if (unknown.length) throw Errors.unprocessable('UNKNOWN_PROVIDER', `Not in the provider catalogue: ${unknown.join(', ')}.`, { unknown });
    const before = await this.approved();
    const switchedOff = await this.sys.tx(async (tx) => {
      if (next === null) await tx.platformSetting.deleteMany({ where: { key: APPROVED_PROVIDERS_KEY } });
      else await tx.platformSetting.upsert({ where: { key: APPROVED_PROVIDERS_KEY }, create: { key: APPROVED_PROVIDERS_KEY, value: next }, update: { value: next } });
      if (next === null) return [];
      const withdrawn = PROVIDERS.filter((p) => !next.includes(providerCode(p.category, p.provider)));
      if (!withdrawn.length) return [];
      const where: Prisma.IntegrationWhereInput = {
        tenantId: { not: null },
        status: { in: ['ACTIVE', 'ERROR'] },
        OR: withdrawn.map((p) => ({ category: p.category, OR: [{ provider: p.provider }, { provider: { startsWith: `${p.provider}:` } }] })),
      };
      const rows = await tx.integration.findMany({ where, select: { id: true, tenantId: true, category: true, provider: true, name: true } });
      if (rows.length) await tx.integration.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { status: 'DISABLED' } });
      return rows;
    });
    await this.audit.logSystem({
      action: 'platform.approved_providers_changed',
      resourceType: 'PlatformSetting',
      resourceId: APPROVED_PROVIDERS_KEY,
      summary: next === null ? 'Provider restriction removed: every catalogue provider may be configured' : `${next.length} providers approved; ${switchedOff.length} active integrations switched off`,
      before: { providers: before ? [...before] : null },
      after: { providers: next, switchedOff: switchedOff.length },
    });
    for (const row of switchedOff) {
      await this.audit.logSystem(
        { action: 'integration.disabled_by_platform', resourceType: 'Integration', resourceId: row.id, summary: `${row.name} was switched off because TypEase no longer approves this provider`, after: { category: row.category, provider: row.provider, status: 'DISABLED' } },
        row.tenantId,
      );
    }
    return { ...(await this.approvedView()), switchedOff: switchedOff.length };
  }

  // ------------------------------------------------------------------ authorisation review
  private record(row: Prisma.IntegrationGetPayload<object>, tenant: { id: string; name: string; slug: string; status: string } | null, reviewer: string | null) {
    const { [AUTHORISATION_KEY]: rawMeta, ...fields } = (row.config ?? {}) as Record<string, any>;
    const meta = (rawMeta ?? {}) as Partial<AuthorisationMeta>;
    const { base, instanceKey } = splitProvider(row.provider);
    const def = findProvider(row.category, row.provider);
    const state: AuthorisationState = row.authorisationVerifiedAt ? 'VERIFIED' : meta.state === 'REJECTED' ? 'REJECTED' : 'PENDING';
    return {
      id: row.id,
      centre: tenant,
      category: row.category,
      provider: base,
      instanceKey,
      name: row.name,
      status: row.status,
      state,
      /** The record as the centre submitted it, with the catalogue labels. */
      fields: (def?.configFields ?? []).map((f) => ({ key: f.key, label: f.label, value: fields[f.key] ?? null, keyField: f.keyField === true })),
      authorisationNote: row.authorisationNote,
      /** Only the id: opening the document itself needs a support access grant with the document.read scope. */
      evidenceDocumentId: meta.evidenceDocumentId ?? null,
      submittedAt: meta.submittedAt ?? row.createdAt.toISOString(),
      verifiedAt: row.authorisationVerifiedAt,
      verifiedByName: reviewer,
      reviewNote: meta.reviewNote ?? null,
      reviewedAt: meta.reviewedAt ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private async decorate(rows: Array<Prisma.IntegrationGetPayload<object>>) {
    const tenantIds = [...new Set(rows.map((r) => r.tenantId).filter((v): v is string => !!v))];
    const reviewerIds = [...new Set(rows.map((r) => r.authorisationVerifiedById).filter((v): v is string => !!v))];
    const [tenants, reviewers] = await Promise.all([
      tenantIds.length ? this.sys.client.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, name: true, slug: true, status: true } }) : [],
      reviewerIds.length ? this.sys.client.user.findMany({ where: { id: { in: reviewerIds }, platformRole: { not: null } }, select: { id: true, fullName: true } }) : [],
    ]);
    const tenantMap = new Map(tenants.map((t) => [t.id, t]));
    const reviewerMap = new Map(reviewers.map((u) => [u.id, u.fullName]));
    return rows.map((r) => this.record(r, r.tenantId ? (tenantMap.get(r.tenantId) ?? null) : null, r.authorisationVerifiedById ? (reviewerMap.get(r.authorisationVerifiedById) ?? null) : null));
  }

  private stateFilter(state: AuthorisationState): Prisma.IntegrationWhereInput {
    if (state === 'VERIFIED') return { authorisationVerifiedAt: { not: null } };
    // The integrations service is the only writer of these rows and always stores the review state.
    return { authorisationVerifiedAt: null, config: { path: [AUTHORISATION_KEY, 'state'], equals: state } };
  }

  async listAuthorisations(query: AuthorisationReviewQuery) {
    const where: Prisma.IntegrationWhereInput = {
      tenantId: query.centreId ?? { not: null },
      category: query.category ?? { in: RECORD_CATEGORIES },
      ...this.stateFilter(query.state),
      ...(query.q ? { OR: [{ name: { contains: query.q, mode: 'insensitive' } }, { tenant: { name: { contains: query.q, mode: 'insensitive' } } }, { tenant: { slug: { contains: query.q.toLowerCase() } } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      this.sys.client.integration.findMany({ where, ...pageArgs(query, SORT, query.state === 'PENDING' ? 'updatedAt:asc' : 'updatedAt:desc') }),
      this.sys.client.integration.count({ where }),
    ]);
    return pageResult(await this.decorate(rows), total, query);
  }

  private async one(id: string, db: Pick<Prisma.TransactionClient, 'integration'> = this.sys.client) {
    return found(await db.integration.findFirst({ where: { id, tenantId: { not: null }, category: { in: RECORD_CATEGORIES } } }), 'Authorisation record');
  }
  async getAuthorisation(id: string) {
    return (await this.decorate([await this.one(id)]))[0];
  }

  private meta(row: { config: unknown; createdAt: Date }): AuthorisationMeta {
    const raw = ((row.config ?? {}) as Record<string, any>)[AUTHORISATION_KEY] ?? {};
    return { state: raw.state ?? 'PENDING', submittedAt: raw.submittedAt ?? row.createdAt.toISOString(), evidenceDocumentId: raw.evidenceDocumentId ?? null, reviewNote: raw.reviewNote ?? null, reviewedAt: raw.reviewedAt ?? null };
  }

  /** The reviewer confirms the centre's authorisation: the record becomes ACTIVE. */
  async verify(id: string, note: string | null | undefined) {
    const reviewerId = ctx().userId!;
    const row = await this.sys.tx(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "integration_credentials_metadata" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const current = await this.one(id, tx);
      if (current.authorisationVerifiedAt) throw Errors.conflict('ALREADY_VERIFIED', 'This authorisation has already been verified.');
      const now = new Date();
      const meta: AuthorisationMeta = { ...this.meta(current), state: 'VERIFIED', reviewNote: note ?? null, reviewedAt: now.toISOString() };
      return tx.integration.update({
        where: { id },
        data: { status: 'ACTIVE', authorisationVerifiedAt: now, authorisationVerifiedById: reviewerId, config: { ...(current.config as object), [AUTHORISATION_KEY]: meta } as any },
      });
    });
    const entry = { action: 'integration.authorisation_verified', resourceType: 'Integration', resourceId: id, summary: `Authorisation "${row.name}" verified by TypEase`, after: { category: row.category, provider: row.provider, status: 'ACTIVE', note: note ?? null } };
    await this.audit.logSystem(entry, row.tenantId);
    await this.audit.logSystem({ ...entry, summary: `${entry.summary} (centre ${row.tenantId})` });
    return this.getAuthorisation(id);
  }

  /**
   * Rejects a submitted record, or withdraws an earlier verification (for
   * example when a licence has lapsed). The record is switched off and the
   * centre sees the note; it can correct the record and submit it again.
   */
  async reject(id: string, note: string) {
    const row = await this.sys.tx(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "integration_credentials_metadata" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const current = await this.one(id, tx);
      const previous = this.meta(current);
      if (!current.authorisationVerifiedAt && previous.state === 'REJECTED') throw Errors.conflict('ALREADY_REJECTED', 'This authorisation has already been rejected. The centre has to submit it again.');
      const meta: AuthorisationMeta = { ...previous, state: 'REJECTED', reviewNote: note, reviewedAt: new Date().toISOString() };
      const updated = await tx.integration.update({
        where: { id },
        data: { status: 'DISABLED', authorisationVerifiedAt: null, authorisationVerifiedById: null, config: { ...(current.config as object), [AUTHORISATION_KEY]: meta } as any },
      });
      return { updated, wasVerified: !!current.authorisationVerifiedAt };
    });
    const action = row.wasVerified ? 'integration.authorisation_withdrawn' : 'integration.authorisation_rejected';
    const entry = { action, resourceType: 'Integration', resourceId: id, summary: `Authorisation "${row.updated.name}" ${row.wasVerified ? 'verification withdrawn' : 'rejected'} by TypEase`, after: { category: row.updated.category, provider: row.updated.provider, status: 'DISABLED', note } };
    await this.audit.logSystem(entry, row.updated.tenantId);
    await this.audit.logSystem({ ...entry, summary: `${entry.summary} (centre ${row.updated.tenantId})` });
    return this.getAuthorisation(id);
  }
}
