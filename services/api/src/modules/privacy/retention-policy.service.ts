import { Injectable, OnModuleInit } from '@nestjs/common';
import type { DataRetentionPolicy } from '@typease/database';
import type { PrivacyRetentionPolicyInput, PrivacyRetentionPolicyUpdateInput } from '@typease/validation';
import { AuditService } from '../../common/audit.service';
import { ctx } from '../../common/context';
import { TenantDb } from '../../common/db/prisma.service';
import { Errors, found } from '../../common/errors';
import { ProvisioningService } from '../tenancy/provisioning.service';

const NOTE = 'Starting value set by TypEase, not legal advice. Confirm the period with your legal adviser and change it here.';
/**
 * Defaults every new centre starts with. Only DOCUMENT policies are applied by
 * the platform (the daily documents.purge job); the others are recorded
 * switched off so the centre can decide them deliberately.
 */
export const DEFAULT_RETENTION_POLICIES: Array<Pick<DataRetentionPolicy, 'entity' | 'documentTypeKey' | 'retainDays' | 'action' | 'isActive'>> = [
  { entity: 'DOCUMENT', documentTypeKey: null, retainDays: 5 * 365, action: 'DELETE', isActive: true },
  // Personal-data exports produced for access / export requests contain identity numbers in clear text.
  { entity: 'DOCUMENT', documentTypeKey: 'data_export', retainDays: 30, action: 'DELETE', isActive: true },
  { entity: 'CUSTOMER', documentTypeKey: null, retainDays: 7 * 365, action: 'ANONYMISE', isActive: false },
  { entity: 'NOTIFICATION', documentTypeKey: null, retainDays: 365, action: 'DELETE', isActive: false },
  { entity: 'SUPPORT_TICKET', documentTypeKey: null, retainDays: 2 * 365, action: 'DELETE', isActive: false },
];

/** Is a policy carried out automatically by the platform today? */
export const isEnforced = (p: Pick<DataRetentionPolicy, 'entity' | 'action' | 'isActive'>) => p.isActive && p.entity === 'DOCUMENT' && p.action === 'DELETE';

/** Configurable retention periods per kind of record. */
@Injectable()
export class RetentionPolicyService implements OnModuleInit {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly provisioning: ProvisioningService,
  ) {}

  onModuleInit() {
    // Idempotent: existing policies (including ones the centre changed or switched off) are never touched.
    this.provisioning.registerTenantStep('privacy.retention-defaults', async (tx, tenant) => {
      for (const policy of DEFAULT_RETENTION_POLICIES) {
        const exists = await tx.dataRetentionPolicy.findFirst({ where: { tenantId: tenant.id, entity: policy.entity, documentTypeKey: policy.documentTypeKey } });
        if (!exists) await tx.dataRetentionPolicy.create({ data: { tenantId: tenant.id, ...policy, legalBasisNote: NOTE } });
      }
    });
  }

  private present(p: DataRetentionPolicy) {
    return { ...p, enforced: isEnforced(p) };
  }

  async list() {
    return this.db.tx(async (tx) => {
      const rows = await tx.dataRetentionPolicy.findMany({ where: { tenantId: this.db.tenantId }, orderBy: [{ entity: 'asc' }, { documentTypeKey: 'asc' }] });
      return rows.map((p) => this.present(p));
    });
  }

  async create(input: PrivacyRetentionPolicyInput) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const documentTypeKey = input.documentTypeKey ?? null;
      const existing = await tx.dataRetentionPolicy.findFirst({ where: { tenantId, entity: input.entity, documentTypeKey } });
      if (existing) throw Errors.conflict('POLICY_EXISTS', 'A retention policy for this kind of record already exists. Change that one instead.');
      const row = await tx.dataRetentionPolicy.create({
        data: { tenantId, entity: input.entity, documentTypeKey, retainDays: input.retainDays, action: input.action, legalBasisNote: input.legalBasisNote ?? null, isActive: input.isActive, updatedById: ctx().userId ?? null },
      });
      await this.audit.log({ action: 'privacy.retention_policy_created', resourceType: 'DataRetentionPolicy', resourceId: row.id, after: row }, tx);
      return this.present(row);
    });
  }

  async update(id: string, input: PrivacyRetentionPolicyUpdateInput) {
    return this.db.tx(async (tx) => {
      const before = found(await tx.dataRetentionPolicy.findFirst({ where: { id, tenantId: this.db.tenantId } }), 'Retention policy');
      if (before.entity === 'DOCUMENT' && input.action === 'ANONYMISE') throw Errors.unprocessable('INVALID_ACTION', 'Documents can only be deleted, not anonymised.');
      const after = await tx.dataRetentionPolicy.update({
        where: { id: before.id },
        data: {
          ...(input.retainDays !== undefined ? { retainDays: input.retainDays } : {}),
          ...(input.action !== undefined ? { action: input.action } : {}),
          ...(input.legalBasisNote !== undefined ? { legalBasisNote: input.legalBasisNote ?? null } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          updatedById: ctx().userId ?? null,
        },
      });
      await this.audit.log(
        {
          action: 'privacy.retention_policy_updated',
          resourceType: 'DataRetentionPolicy',
          resourceId: before.id,
          before: { retainDays: before.retainDays, action: before.action, isActive: before.isActive, legalBasisNote: before.legalBasisNote },
          after: { retainDays: after.retainDays, action: after.action, isActive: after.isActive, legalBasisNote: after.legalBasisNote },
        },
        tx,
      );
      return this.present(after);
    });
  }

  async remove(id: string) {
    return this.db.tx(async (tx) => {
      const before = found(await tx.dataRetentionPolicy.findFirst({ where: { id, tenantId: this.db.tenantId } }), 'Retention policy');
      await tx.dataRetentionPolicy.delete({ where: { id: before.id } });
      await this.audit.log({ action: 'privacy.retention_policy_deleted', resourceType: 'DataRetentionPolicy', resourceId: before.id, before }, tx);
      return { id: before.id, deleted: true };
    });
  }
}
