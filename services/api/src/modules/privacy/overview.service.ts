import { Injectable } from '@nestjs/common';
import type { Prisma } from '@typease/database';
import type { PrivacyConsentQuery } from '@typease/validation';
import { TenantDb } from '../../common/db/prisma.service';
import { found } from '../../common/errors';
import { pageArgs, pageResult } from '../../common/pagination';
import { DataSubjectRequestService } from './dsr.service';
import { IncidentService } from './incident.service';
import { isEnforced } from './retention-policy.service';

/** Read-only views for the privacy officer: consent overview and the dashboard numbers. */
@Injectable()
export class PrivacyOverviewService {
  constructor(
    private readonly db: TenantDb,
    private readonly requests: DataSubjectRequestService,
    private readonly incidents: IncidentService,
  ) {}

  private async consentStatistics(tx: Prisma.TransactionClient) {
    const grouped = await tx.customerConsent.groupBy({ by: ['purpose', 'status'], where: { tenantId: this.db.tenantId }, _count: { _all: true } });
    const purposes = new Map<string, { purpose: string; granted: number; withdrawn: number }>();
    for (const g of grouped) {
      const row = purposes.get(g.purpose) ?? { purpose: g.purpose, granted: 0, withdrawn: 0 };
      if (g.status === 'GRANTED') row.granted = g._count._all;
      else row.withdrawn = g._count._all;
      purposes.set(g.purpose, row);
    }
    return [...purposes.values()].sort((a, b) => a.purpose.localeCompare(b.purpose));
  }

  /** Current consent state per customer and purpose. Consent itself is recorded by the customers module. */
  async consents(query: PrivacyConsentQuery) {
    return this.db.tx(async (tx) => {
      const where: Prisma.CustomerConsentWhereInput = {
        tenantId: this.db.tenantId,
        ...(query.purpose ? { purpose: query.purpose } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.customerId ? { customerId: query.customerId } : {}),
      };
      const [rows, total, statistics] = await Promise.all([
        tx.customerConsent.findMany({ where, ...pageArgs(query, ['updatedAt'] as const, 'updatedAt:desc'), include: { customer: { select: { id: true, customerNo: true, fullName: true } } } }),
        tx.customerConsent.count({ where }),
        this.consentStatistics(tx),
      ]);
      return { ...pageResult(rows, total, query), statistics };
    });
  }

  /** The append-only history of consent decisions of one customer. */
  /**
   * Every consent decision on record for one customer of this centre, newest first. The customer must exist here
   * (in any state: the history of an archived, merged or erased record is evidence the centre keeps): an unknown id
   * or a customer of another centre answers 404, not an empty history.
   */
  async consentHistory(customerId: string) {
    return this.db.tx(async (tx) => {
      found(await tx.customer.findFirst({ where: { id: customerId, tenantId: this.db.tenantId }, select: { id: true } }), 'Customer');
      return tx.consentRecord.findMany({ where: { tenantId: this.db.tenantId, customerId }, orderBy: { createdAt: 'desc' }, take: 500 });
    });
  }

  async overview() {
    const tenantId = this.db.tenantId;
    const fromDatabase = await this.db.tx(async (tx) => {
      const policies = await tx.dataRetentionPolicy.findMany({ where: { tenantId }, orderBy: [{ entity: 'asc' }, { documentTypeKey: 'asc' }] });
      const [onLegalHold, awaitingPurge] = await Promise.all([
        tx.document.count({ where: { tenantId, legalHold: true } }),
        tx.document.count({ where: { tenantId, status: 'DELETED', documentVersions: { some: { uploadStatus: 'COMPLETED' } } } }),
      ]);
      return {
        dataSubjectRequests: await this.requests.counts(tx),
        consents: await this.consentStatistics(tx),
        retention: {
          policiesInForce: policies.filter((p) => p.isActive).length,
          /** Policies the platform carries out by itself (documents). The others are the centre's own record. */
          policiesEnforcedAutomatically: policies.filter(isEnforced).length,
          policies: policies.map((p) => ({ id: p.id, entity: p.entity, documentTypeKey: p.documentTypeKey, retainDays: p.retainDays, action: p.action, isActive: p.isActive, enforced: isEnforced(p) })),
          documentsOnLegalHold: onLegalHold,
          deletedDocumentsAwaitingPurge: awaitingPurge,
        },
      };
    });
    return {
      ...fromDatabase,
      incidents: { byStatus: await this.incidents.incidentCounts(tenantId) },
      processors: await this.incidents.processorCounts(tenantId),
      disclaimer: 'These figures describe technical controls in TypEase. They do not establish legal compliance; have your privacy practices reviewed by qualified UAE advisers.',
    };
  }
}
