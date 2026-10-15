import { Injectable } from '@nestjs/common';
import type { AuditExportQuery, AuditLogQuery } from '@typease/validation';
import { AuditService } from '../../common/audit.service';
import { TenantDb } from '../../common/db/prisma.service';
import { found } from '../../common/errors';
import { pageArgs, pageResult } from '../../common/pagination';
import { AUDIT_LIST_SELECT, auditWhere, toCsv } from './audit-view';

const SORT = ['createdAt'] as const;

/**
 * Read-only view of a centre's audit trail. The trail itself is written by
 * every module through `AuditService` and is append-only in the database:
 * there is deliberately no way to edit or delete an entry here.
 *
 * Everything runs on the tenant-scoped connection, so row-level security
 * limits every query to the centre of the signed-in user; platform-level
 * entries (no tenant) are never visible.
 */
@Injectable()
export class AuditViewerService {
  /** Largest export in one file. Narrow the filters (date range) to export the rest. */
  exportLimit = 10_000;

  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
  ) {}

  async list(query: AuditLogQuery) {
    const where = { tenantId: this.db.tenantId, ...auditWhere(query) };
    return this.db.tx(async (tx) => {
      const [rows, total] = await Promise.all([tx.auditLog.findMany({ where, select: AUDIT_LIST_SELECT, ...pageArgs(query, SORT, 'createdAt:desc') }), tx.auditLog.count({ where })]);
      return pageResult(rows, total, query);
    });
  }

  /** One entry with the recorded before / after values (credentials are redacted when an entry is written). */
  async get(id: string) {
    return this.db.tx(async (tx) => {
      const row = found(await tx.auditLog.findFirst({ where: { id, tenantId: this.db.tenantId } }), 'Audit entry');
      const { tenantId: _tenantId, ...rest } = row;
      return rest;
    });
  }

  /** CSV of the filtered trail, newest first, capped at `exportLimit` rows. The export itself is audited. */
  async exportCsv(query: AuditExportQuery): Promise<{ csv: string; filename: string; rows: number; truncated: boolean }> {
    const where = { tenantId: this.db.tenantId, ...auditWhere(query) };
    return this.db.tx(async (tx) => {
      const rows = await tx.auditLog.findMany({ where, select: AUDIT_LIST_SELECT, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: this.exportLimit + 1 });
      const truncated = rows.length > this.exportLimit;
      const exported = truncated ? rows.slice(0, this.exportLimit) : rows;
      const filters = Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined));
      await this.audit.log(
        { action: 'audit.exported', resourceType: 'AuditLog', summary: `Audit trail exported (${exported.length} entries${truncated ? `, limited to the newest ${this.exportLimit}` : ''})`, after: { filters, rows: exported.length, truncated } },
        tx,
      );
      return { csv: toCsv(exported), filename: `audit-trail-${new Date().toISOString().slice(0, 10)}.csv`, rows: exported.length, truncated };
    });
  }
}
