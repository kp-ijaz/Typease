import { Injectable } from '@nestjs/common';
import type { PlatformAuditQuery, PlatformPeriodQuery, SecurityEventQuery } from '@typease/validation';
import { Prisma, SystemDb } from '../../common/db/prisma.service';
import { found } from '../../common/errors';
import { pageArgs, pageResult } from '../../common/pagination';
import { AUDIT_LIST_SELECT, auditWhere, rangeBound } from '../audit/audit-view';
import { resolvePeriod } from './platform.util';

const SORT = ['createdAt'] as const;

/**
 * What platform staff may read of the audit and security trails.
 *
 *  - Audit: ONLY platform-level entries (`tenantId IS NULL`): what TypEase
 *    staff and platform jobs did. A centre's own audit trail - and with it the
 *    before / after values of its records - is never readable here; the filter
 *    is part of every query in this file, not an option.
 *  - Security events: all of them (sign-in failures, permission denials, token
 *    reuse, webhook problems ...), with the centre they belong to.
 */
@Injectable()
export class PlatformAuditService {
  constructor(private readonly sys: SystemDb) {}

  async list(query: PlatformAuditQuery) {
    const where: Prisma.AuditLogWhereInput = { ...auditWhere(query), tenantId: null };
    const [rows, total] = await Promise.all([this.sys.client.auditLog.findMany({ where, select: AUDIT_LIST_SELECT, ...pageArgs(query, SORT, 'createdAt:desc') }), this.sys.client.auditLog.count({ where })]);
    return pageResult(rows, total, query);
  }

  async get(id: string) {
    const row = found(await this.sys.client.auditLog.findFirst({ where: { id, tenantId: null } }), 'Audit entry');
    const { tenantId: _tenantId, ...rest } = row;
    return rest;
  }

  private securityWhere(query: Pick<SecurityEventQuery, 'type' | 'severity' | 'centreId' | 'platformOnly' | 'userId' | 'from' | 'to'>): Prisma.SecurityEventWhereInput {
    const from = rangeBound(query.from, false);
    const to = rangeBound(query.to, true);
    return {
      ...(query.type ? { type: query.type.toUpperCase() } : {}),
      ...(query.severity ? { severity: query.severity } : {}),
      ...(query.centreId ? { tenantId: query.centreId } : query.platformOnly ? { tenantId: null } : {}),
      ...(query.userId ? { userId: query.userId } : {}),
      ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
    };
  }

  async securityEvents(query: SecurityEventQuery) {
    const where = this.securityWhere(query);
    const [rows, total] = await Promise.all([this.sys.client.securityEvent.findMany({ where, ...pageArgs(query, SORT, 'createdAt:desc') }), this.sys.client.securityEvent.count({ where })]);
    const tenantIds = [...new Set(rows.map((r) => r.tenantId).filter((v): v is string => !!v))];
    const tenants = tenantIds.length ? await this.sys.client.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, name: true, slug: true } }) : [];
    const byId = new Map(tenants.map((t) => [t.id, t]));
    return pageResult(
      rows.map(({ tenantId, ...r }) => ({ ...r, centre: tenantId ? (byId.get(tenantId) ?? { id: tenantId, name: null, slug: null }) : null })),
      total,
      query,
    );
  }

  /** How many events of each type and severity happened in a period (default: the last 7 days). */
  async securitySummary(query: PlatformPeriodQuery) {
    const { start, end } = resolvePeriod(query, 7);
    const where: Prisma.SecurityEventWhereInput = { createdAt: { gte: start, lt: end } };
    const [byType, bySeverity] = await Promise.all([
      this.sys.client.securityEvent.groupBy({ by: ['type', 'severity'], where, _count: { _all: true } }),
      this.sys.client.securityEvent.groupBy({ by: ['severity'], where, _count: { _all: true } }),
    ]);
    const severity = { INFO: 0, LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 } as Record<string, number>;
    for (const s of bySeverity) severity[s.severity] = s._count._all;
    return {
      from: start,
      to: end,
      total: bySeverity.reduce((n, s) => n + s._count._all, 0),
      bySeverity: severity,
      byType: byType.map((t) => ({ type: t.type, severity: t.severity, count: t._count._all })).sort((a, b) => b.count - a.count || a.type.localeCompare(b.type)),
    };
  }
}
