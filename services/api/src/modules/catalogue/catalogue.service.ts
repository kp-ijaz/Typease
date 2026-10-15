import { Injectable } from '@nestjs/common';
import { OPEN_STATUSES } from '@typease/types';
import type {
  CatalogueDocumentTypeInput, ServiceCategoryInput, ServiceInput, ServiceListQuery, ServiceRequirementInput,
  UpdateCatalogueDocumentTypeInput, UpdateServiceCategoryInput, UpdateServiceInput, UpdateServiceRequirementInput,
} from '@typease/validation';
import { AuditService } from '../../common/audit.service';
import { TenantDb, Tx } from '../../common/db/prisma.service';
import { Errors, found } from '../../common/errors';
import { pageArgs, pageResult } from '../../common/pagination';

const SERVICE_SORT = ['sortOrder', 'name', 'code', 'createdAt', 'updatedAt'] as const;

/** Columns of a price that are shown to staff. */
export const PRICE_SELECT = {
  id: true, serviceId: true, branchId: true, serviceFee: true, governmentFeeEstimate: true, thirdPartyFeeEstimate: true,
  currency: true, validFrom: true, validTo: true, isActive: true, createdAt: true,
} as const;

const SERVICE_INCLUDE = {
  category: { select: { id: true, key: true, name: true, nameAr: true, icon: true, isActive: true } },
  serviceBranches: { select: { branchId: true } },
  servicePrices: { where: { isActive: true, branchId: null }, orderBy: { validFrom: 'desc' as const }, take: 1, select: PRICE_SELECT },
} as const;

type CapabilityKey = 'DOCUMENT_PREPARATION_ONLY' | 'PARTNER_COORDINATION' | 'DIRECT_AUTHORISED' | 'INFORMATIONAL_ONLY';

const pick = (obj: Record<string, any>, keys: string[]) => Object.fromEntries(keys.map((k) => [k, obj[k]]));
const slugify = (name: string) =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36);

/**
 * Service catalogue configuration: categories, document types, services and
 * their document requirements. Prices, forms and the customer-facing views
 * live in their own services next to this one.
 */
@Injectable()
export class CatalogueService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------------ categories
  listCategories(includeInactive = false) {
    return this.db.tx(async (tx) => {
      const rows = await tx.serviceCategory.findMany({
        where: { tenantId: this.db.tenantId, ...(includeInactive ? {} : { isActive: true }) },
        include: { _count: { select: { services: { where: { deletedAt: null } } } } },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      });
      return rows.map(({ _count, ...c }) => ({ ...c, serviceCount: _count.services }));
    });
  }

  createCategory(input: ServiceCategoryInput) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      let key = input.key ?? slugify(input.name);
      if (!/^[a-z][a-z0-9-]{1,39}$/.test(key)) key = `category-${key}`.replace(/-+$/, '').slice(0, 40);
      const taken = async (k: string) => !!(await tx.serviceCategory.findFirst({ where: { tenantId, key: k }, select: { id: true } }));
      if (await taken(key)) {
        if (input.key) throw Errors.conflict('DUPLICATE_KEY', `A category with the key "${key}" already exists.`);
        let n = 2;
        while (await taken(`${key}-${n}`)) n += 1;
        key = `${key}-${n}`;
      }
      const last = await tx.serviceCategory.aggregate({ where: { tenantId }, _max: { sortOrder: true } });
      const category = await tx.serviceCategory.create({
        data: {
          tenantId,
          key,
          name: input.name,
          nameAr: input.nameAr ?? null,
          description: input.description ?? null,
          icon: input.icon ?? null,
          sortOrder: input.sortOrder ?? (last._max.sortOrder ?? -1) + 1,
          isActive: input.isActive ?? true,
        },
      });
      await this.audit.log({ action: 'service_category.created', resourceType: 'ServiceCategory', resourceId: category.id, after: category }, tx);
      return category;
    });
  }

  updateCategory(id: string, input: UpdateServiceCategoryInput) {
    return this.db.tx(async (tx) => {
      const before = found(await tx.serviceCategory.findFirst({ where: { id, tenantId: this.db.tenantId } }), 'Category');
      const after = await tx.serviceCategory.update({ where: { id }, data: input });
      await this.audit.log({ action: 'service_category.updated', resourceType: 'ServiceCategory', resourceId: id, before: pick(before, Object.keys(input)), after: input }, tx);
      return after;
    });
  }

  deleteCategory(id: string) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const category = found(await tx.serviceCategory.findFirst({ where: { id, tenantId } }), 'Category');
      // Deleted services still point at their category (history of old requests), so they count too.
      const services = await tx.service.count({ where: { tenantId, categoryId: id } });
      if (services) {
        throw Errors.conflict('CATEGORY_IN_USE', `This category still has ${services} service(s), including deleted ones. Move them to another category, or deactivate the category instead.`);
      }
      await tx.serviceCategory.delete({ where: { id } });
      await this.audit.log({ action: 'service_category.deleted', resourceType: 'ServiceCategory', resourceId: id, before: { key: category.key, name: category.name } }, tx);
      return { status: 'DELETED' as const };
    });
  }

  reorderCategories(ids: string[]) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const all = await tx.serviceCategory.findMany({ where: { tenantId }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], select: { id: true } });
      const known = new Set(all.map((c) => c.id));
      if (ids.some((id) => !known.has(id))) throw Errors.notFound('Category');
      const order = [...ids, ...all.map((c) => c.id).filter((id) => !ids.includes(id))];
      for (const [i, id] of order.entries()) await tx.serviceCategory.update({ where: { id }, data: { sortOrder: i } });
      await this.audit.log({ action: 'service_category.reordered', resourceType: 'ServiceCategory', after: { order } }, tx);
      return this.listCategories(true);
    });
  }

  // ------------------------------------------------------------------ document types
  /** Platform defaults merged with the centre's own types; the centre's row wins on the same key. */
  async documentTypes(tx: Tx, includeInactive = false) {
    const tenantId = this.db.tenantId;
    const rows = await tx.documentType.findMany({ where: { OR: [{ tenantId: null }, { tenantId }] }, orderBy: { name: 'asc' } });
    const byKey = new Map<string, (typeof rows)[number]>();
    const platformKeys = new Set(rows.filter((r) => r.tenantId === null).map((r) => r.key));
    for (const row of rows) {
      const current = byKey.get(row.key);
      if (!current || row.tenantId !== null) byKey.set(row.key, row);
    }
    return [...byKey.values()]
      .filter((r) => includeInactive || r.isActive)
      .map(({ tenantId: owner, ...r }) => ({ ...r, source: owner === null ? ('PLATFORM' as const) : ('TENANT' as const), overridesPlatformDefault: owner !== null && platformKeys.has(r.key) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  listDocumentTypes(includeInactive = false) {
    return this.db.tx((tx) => this.documentTypes(tx, includeInactive));
  }

  createDocumentType(input: CatalogueDocumentTypeInput) {
    if (input.reminderEnabled && !input.hasExpiry) throw Errors.unprocessable('REMINDER_NEEDS_EXPIRY', 'Expiry reminders are only possible for document types that have an expiry date.');
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      if (await tx.documentType.findFirst({ where: { tenantId, key: input.key }, select: { id: true } })) {
        throw Errors.conflict('DUPLICATE_KEY', `You already have a document type with the key "${input.key}". Edit it instead.`);
      }
      const row = await tx.documentType.create({ data: { ...input, nameAr: input.nameAr ?? null, tenantId } });
      await this.audit.log({ action: 'document_type.created', resourceType: 'DocumentType', resourceId: row.id, after: input }, tx);
      return { ...row, source: 'TENANT' as const };
    });
  }

  private async ownDocumentType(tx: Tx, id: string) {
    const row = found(await tx.documentType.findFirst({ where: { id, OR: [{ tenantId: this.db.tenantId }, { tenantId: null }] } }), 'Document type');
    if (row.tenantId === null) {
      throw Errors.conflict('PLATFORM_DEFAULT', 'This is a TypEase default document type and cannot be changed. Create your own document type with the same key to replace it for your centre.');
    }
    return row;
  }

  updateDocumentType(id: string, input: UpdateCatalogueDocumentTypeInput) {
    return this.db.tx(async (tx) => {
      const before = await this.ownDocumentType(tx, id);
      const hasExpiry = input.hasExpiry ?? before.hasExpiry;
      const reminderEnabled = input.reminderEnabled ?? before.reminderEnabled;
      if (reminderEnabled && !hasExpiry) throw Errors.unprocessable('REMINDER_NEEDS_EXPIRY', 'Expiry reminders are only possible for document types that have an expiry date.');
      const after = await tx.documentType.update({ where: { id }, data: input });
      await this.audit.log({ action: 'document_type.updated', resourceType: 'DocumentType', resourceId: id, before: pick(before, Object.keys(input)), after: input }, tx);
      return { ...after, source: 'TENANT' as const };
    });
  }

  deleteDocumentType(id: string) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const row = await this.ownDocumentType(tx, id);
      const fallback = await tx.documentType.findFirst({ where: { tenantId: null, key: row.key }, select: { id: true } });
      if (!fallback) {
        const [requirements, documents] = await Promise.all([
          tx.serviceRequirement.count({ where: { tenantId, documentTypeKey: row.key } }),
          tx.document.count({ where: { tenantId, documentTypeKey: row.key } }),
        ]);
        if (requirements || documents) {
          throw Errors.conflict('DOCUMENT_TYPE_IN_USE', `This document type is used by ${requirements} service requirement(s) and ${documents} document(s). Deactivate it instead of deleting it.`);
        }
      }
      await tx.documentType.delete({ where: { id } });
      await this.audit.log({ action: 'document_type.deleted', resourceType: 'DocumentType', resourceId: id, before: { key: row.key, name: row.name } }, tx);
      return { status: 'DELETED' as const, revertedToPlatformDefault: !!fallback };
    });
  }

  // ------------------------------------------------------------------ services
  private shape = (row: any) => {
    const { serviceBranches, servicePrices, ...rest } = row;
    return { ...rest, branchIds: (serviceBranches ?? []).map((b: { branchId: string }) => b.branchId), price: servicePrices?.[0] ?? null };
  };

  /** A service of this centre that has not been deleted, or 404. */
  async requireService(tx: Tx, id: string, opts: { includeDeleted?: boolean } = {}) {
    return found(await tx.service.findFirst({ where: { id, tenantId: this.db.tenantId, ...(opts.includeDeleted ? {} : { deletedAt: null }) } }), 'Service');
  }
  /** Serialises changes to one service (prices, form versions) inside the current transaction. */
  async lockService(tx: Tx, id: string) {
    await tx.$queryRaw`SELECT "id" FROM "services" WHERE "id" = ${id}::uuid AND "tenantId" = ${this.db.tenantId}::uuid FOR UPDATE`;
  }

  listServices(query: ServiceListQuery) {
    return this.db.tx(async (tx) => {
      const and: any[] = [];
      if (query.q) {
        and.push({ OR: [{ name: { contains: query.q, mode: 'insensitive' } }, { nameAr: { contains: query.q } }, { code: { contains: query.q, mode: 'insensitive' } }] });
      }
      if (query.branchId) and.push({ OR: [{ allBranches: true }, { serviceBranches: { some: { branchId: query.branchId } } }] });
      const where = {
        tenantId: this.db.tenantId,
        deletedAt: query.deleted ? { not: null } : null,
        ...(query.categoryId ? { categoryId: query.categoryId } : {}),
        ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
        ...(query.isPublic !== undefined ? { isPublic: query.isPublic } : {}),
        ...(query.onlineAvailable !== undefined ? { onlineAvailable: query.onlineAvailable } : {}),
        ...(query.complianceCapability ? { complianceCapability: query.complianceCapability } : {}),
        ...(and.length ? { AND: and } : {}),
      };
      const [rows, total] = await Promise.all([
        tx.service.findMany({ where, include: SERVICE_INCLUDE, ...pageArgs(query, SERVICE_SORT, 'sortOrder:asc') }),
        tx.service.count({ where }),
      ]);
      return pageResult(rows.map(this.shape), total, query);
    });
  }

  getService(id: string) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const row = found(await tx.service.findFirst({ where: { id, tenantId }, include: SERVICE_INCLUDE }), 'Service');
      const [prices, requirements, forms, workflow] = await Promise.all([
        tx.servicePrice.findMany({ where: { tenantId, serviceId: id, isActive: true }, select: PRICE_SELECT, orderBy: [{ branchId: { sort: 'asc', nulls: 'first' } }] }),
        tx.serviceRequirement.findMany({ where: { tenantId, serviceId: id }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }),
        tx.serviceFormDefinition.findMany({ where: { tenantId, serviceId: id, status: { in: ['DRAFT', 'PUBLISHED'] } }, select: { id: true, version: true, status: true, publishedAt: true, updatedAt: true } }),
        row.workflowDefinitionId ? tx.workflowDefinition.findFirst({ where: { id: row.workflowDefinitionId, tenantId }, select: { id: true, key: true, name: true } }) : null,
      ]);
      return {
        ...this.shape(row),
        activePrices: prices,
        requirements,
        workflowDefinition: workflow,
        form: { published: forms.find((f) => f.status === 'PUBLISHED') ?? null, draft: forms.find((f) => f.status === 'DRAFT') ?? null },
      };
    });
  }

  /**
   * The capability is a business category that says what the centre itself does
   * for a service. The two categories that involve an outside channel are only
   * selectable once that channel has really been set up.
   */
  private async assertCapabilityAllowed(tx: Tx, capability: CapabilityKey) {
    const tenantId = this.db.tenantId;
    if (capability === 'DIRECT_AUTHORISED') {
      const ok = await tx.integration.findFirst({ where: { tenantId, category: 'GOVERNMENT', status: 'ACTIVE', authorisationVerifiedAt: { not: null } }, select: { id: true } });
      if (!ok) {
        throw Errors.unprocessable(
          'CAPABILITY_NOT_PERMITTED',
          '"Direct authorised processing" can only be selected after an authorised government-service integration has been added, its authorisation has been verified and it is active (Settings > Integrations). Until then choose "Document preparation only" or "Coordination through an authorised partner".',
          { capability, requires: { integrationCategory: 'GOVERNMENT', status: ['ACTIVE'], authorisationVerified: true } },
        );
      }
    }
    if (capability === 'PARTNER_COORDINATION') {
      const ok = await tx.integration.findFirst({ where: { tenantId, category: 'PARTNER', status: { in: ['ACTIVE', 'CONFIGURED'] } }, select: { id: true } });
      if (!ok) {
        throw Errors.unprocessable(
          'CAPABILITY_NOT_PERMITTED',
          '"Coordination through an authorised partner" can only be selected after a partner has been set up (Settings > Integrations > Partners). Until then choose "Document preparation only".',
          { capability, requires: { integrationCategory: 'PARTNER', status: ['ACTIVE', 'CONFIGURED'] } },
        );
      }
    }
  }

  private async assertCategory(tx: Tx, categoryId: string) {
    const category = found(await tx.serviceCategory.findFirst({ where: { id: categoryId, tenantId: this.db.tenantId } }), 'Category');
    if (!category.isActive) throw Errors.unprocessable('CATEGORY_INACTIVE', `The category "${category.name}" is inactive. Activate it or choose another category.`);
  }
  private async assertBranches(tx: Tx, branchIds: string[]) {
    if (!branchIds.length) return;
    const n = await tx.branch.count({ where: { tenantId: this.db.tenantId, id: { in: branchIds } } });
    if (n !== new Set(branchIds).size) throw Errors.notFound('Branch');
  }
  private async assertStaffGroup(tx: Tx, roleKey: string) {
    const role = await tx.role.findFirst({ where: { tenantId: this.db.tenantId, key: roleKey, kind: 'STAFF' }, select: { id: true } });
    if (!role) throw Errors.unprocessable('UNKNOWN_STAFF_GROUP', `There is no staff role with the key "${roleKey}" in this centre.`);
  }
  private async assertWorkflow(tx: Tx, workflowDefinitionId: string) {
    found(await tx.workflowDefinition.findFirst({ where: { id: workflowDefinitionId, tenantId: this.db.tenantId }, select: { id: true } }), 'Workflow');
  }
  private async assertCodeFree(tx: Tx, code: string, exceptId?: string) {
    const clash = await tx.service.findFirst({ where: { tenantId: this.db.tenantId, code, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true, name: true, deletedAt: true } });
    if (!clash) return;
    throw Errors.conflict(
      'DUPLICATE_CODE',
      clash.deletedAt
        ? `The code "${code}" belongs to the deleted service "${clash.name}". Restore that service or choose another code.`
        : `The code "${code}" is already used by "${clash.name}". Choose another code.`,
      { serviceId: clash.id, deleted: !!clash.deletedAt },
    );
  }

  createService(input: ServiceInput) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const { branchIds, price, ...fields } = input;
      await this.assertCategory(tx, fields.categoryId);
      await this.assertCodeFree(tx, fields.code);
      await this.assertCapabilityAllowed(tx, fields.complianceCapability);
      if (fields.staffGroupRoleKey) await this.assertStaffGroup(tx, fields.staffGroupRoleKey);
      if (fields.workflowDefinitionId) await this.assertWorkflow(tx, fields.workflowDefinitionId);
      const branches = fields.allBranches ? [] : [...new Set(branchIds)];
      await this.assertBranches(tx, branches);
      const tenant = await tx.tenant.findFirstOrThrow({ where: { id: tenantId }, select: { defaultCurrency: true } });

      const service = await tx.service.create({
        data: {
          ...fields,
          tenantId,
          nameAr: fields.nameAr ?? null,
          description: fields.description ?? null,
          descriptionAr: fields.descriptionAr ?? null,
          eligibilityGuidance: fields.eligibilityGuidance ?? null,
          estimatedProcessingHours: fields.estimatedProcessingHours ?? null,
          depositPercent: fields.paymentPolicy === 'DEPOSIT' ? fields.depositPercent! : null,
          staffGroupRoleKey: fields.staffGroupRoleKey ?? null,
          workflowDefinitionId: fields.workflowDefinitionId ?? null,
        },
      });
      if (branches.length) await tx.serviceBranch.createMany({ data: branches.map((branchId) => ({ tenantId, serviceId: service.id, branchId })) });
      await tx.servicePrice.create({
        data: { tenantId, serviceId: service.id, branchId: null, serviceFee: price.serviceFee, governmentFeeEstimate: price.governmentFeeEstimate, thirdPartyFeeEstimate: price.thirdPartyFeeEstimate, currency: tenant.defaultCurrency },
      });
      await this.audit.log({ action: 'service.created', resourceType: 'Service', resourceId: service.id, summary: `${service.code} ${service.name}`, after: { ...fields, branchIds: branches, price } }, tx);
      return this.shape(await tx.service.findFirstOrThrow({ where: { id: service.id, tenantId }, include: SERVICE_INCLUDE }));
    });
  }

  updateService(id: string, input: UpdateServiceInput) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const before = await this.requireService(tx, id);
      const { version, branchIds, ...fields } = input;
      if (version !== undefined && version !== before.version) throw versionConflict();

      if (fields.categoryId && fields.categoryId !== before.categoryId) await this.assertCategory(tx, fields.categoryId);
      if (fields.code && fields.code !== before.code) await this.assertCodeFree(tx, fields.code, id);
      const capability = fields.complianceCapability ?? before.complianceCapability;
      const reactivating = fields.isActive === true && !before.isActive;
      if (capability !== before.complianceCapability || reactivating) await this.assertCapabilityAllowed(tx, capability);
      if (fields.staffGroupRoleKey && fields.staffGroupRoleKey !== before.staffGroupRoleKey) await this.assertStaffGroup(tx, fields.staffGroupRoleKey);
      if (fields.workflowDefinitionId && fields.workflowDefinitionId !== before.workflowDefinitionId) await this.assertWorkflow(tx, fields.workflowDefinitionId);

      const data: Record<string, any> = { ...fields };
      const paymentPolicy = fields.paymentPolicy ?? before.paymentPolicy;
      if (paymentPolicy === 'DEPOSIT') {
        const percent = fields.depositPercent === undefined ? before.depositPercent : fields.depositPercent;
        if (percent === null) throw Errors.unprocessable('DEPOSIT_PERCENT_REQUIRED', 'Enter the deposit percentage for a service that takes a deposit.');
      } else if (before.depositPercent !== null || fields.depositPercent !== undefined) {
        data.depositPercent = null;
      }

      const allBranches = fields.allBranches ?? before.allBranches;
      let nextBranches: string[] | undefined;
      if (allBranches) {
        if (!before.allBranches || branchIds !== undefined) nextBranches = [];
      } else if (branchIds !== undefined) {
        nextBranches = [...new Set(branchIds)];
        if (!nextBranches.length) throw Errors.unprocessable('BRANCH_REQUIRED', 'Choose at least one branch, or offer the service in all branches.');
        await this.assertBranches(tx, nextBranches);
      } else if (before.allBranches) {
        throw Errors.unprocessable('BRANCH_REQUIRED', 'Choose at least one branch, or offer the service in all branches.');
      }

      // The version in the WHERE clause makes two simultaneous edits impossible to both win.
      const changed = await tx.service.updateMany({ where: { id, tenantId, version: before.version, deletedAt: null }, data: { ...data, version: { increment: 1 } } });
      if (changed.count !== 1) throw versionConflict();
      if (nextBranches !== undefined) {
        await tx.serviceBranch.deleteMany({ where: { tenantId, serviceId: id } });
        if (nextBranches.length) await tx.serviceBranch.createMany({ data: nextBranches.map((branchId) => ({ tenantId, serviceId: id, branchId })) });
      }
      await this.audit.log(
        { action: 'service.updated', resourceType: 'Service', resourceId: id, summary: `${before.code} ${before.name}`, before: pick(before, Object.keys(data)), after: { ...data, ...(nextBranches !== undefined ? { branchIds: nextBranches } : {}) } },
        tx,
      );
      return this.shape(await tx.service.findFirstOrThrow({ where: { id, tenantId }, include: SERVICE_INCLUDE }));
    });
  }

  reorderServices(ids: string[]) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const n = await tx.service.count({ where: { tenantId, id: { in: ids }, deletedAt: null } });
      if (n !== ids.length) throw Errors.notFound('Service');
      for (const [i, id] of ids.entries()) await tx.service.update({ where: { id }, data: { sortOrder: i } });
      await this.audit.log({ action: 'service.reordered', resourceType: 'Service', after: { order: ids } }, tx);
      return { status: 'REORDERED' as const, count: ids.length };
    });
  }

  deleteService(id: string) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const service = await this.requireService(tx, id);
      const open = await tx.serviceRequest.count({ where: { tenantId, serviceId: id, status: { in: OPEN_STATUSES }, deletedAt: null } });
      if (open) throw Errors.conflict('SERVICE_HAS_OPEN_REQUESTS', `This service still has ${open} open request(s). Complete or cancel them first, or deactivate the service so no new requests can be created.`);
      await tx.service.update({ where: { id }, data: { deletedAt: new Date(), isActive: false, version: { increment: 1 } } });
      await this.audit.log({ action: 'service.deleted', resourceType: 'Service', resourceId: id, summary: `${service.code} ${service.name}`, before: { isActive: service.isActive } }, tx);
      return { status: 'DELETED' as const };
    });
  }

  /** Brings a deleted service back. It stays inactive until staff activate it again. */
  restoreService(id: string) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const service = await this.requireService(tx, id, { includeDeleted: true });
      if (!service.deletedAt) throw Errors.conflict('NOT_DELETED', 'This service is not deleted.');
      await tx.service.update({ where: { id }, data: { deletedAt: null, version: { increment: 1 } } });
      await this.audit.log({ action: 'service.restored', resourceType: 'Service', resourceId: id, summary: `${service.code} ${service.name}` }, tx);
      return this.shape(await tx.service.findFirstOrThrow({ where: { id, tenantId }, include: SERVICE_INCLUDE }));
    });
  }

  // ------------------------------------------------------------------ requirements (document checklist)
  listRequirements(serviceId: string) {
    return this.db.tx(async (tx) => {
      await this.requireService(tx, serviceId, { includeDeleted: true });
      return tx.serviceRequirement.findMany({ where: { tenantId: this.db.tenantId, serviceId }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
    });
  }

  private async assertDocumentTypeKey(tx: Tx, key: string) {
    const type = (await this.documentTypes(tx, true)).find((d) => d.key === key);
    if (!type) throw Errors.unprocessable('UNKNOWN_DOCUMENT_TYPE', `There is no document type with the key "${key}". Add it under Settings > Document types first.`);
    if (!type.isActive) throw Errors.unprocessable('DOCUMENT_TYPE_INACTIVE', `The document type "${type.name}" is inactive. Activate it first.`);
  }

  addRequirement(serviceId: string, input: ServiceRequirementInput) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      await this.requireService(tx, serviceId);
      await this.assertDocumentTypeKey(tx, input.documentTypeKey);
      const last = await tx.serviceRequirement.aggregate({ where: { tenantId, serviceId }, _max: { sortOrder: true } });
      const row = await tx.serviceRequirement.create({
        data: { ...input, labelAr: input.labelAr ?? null, description: input.description ?? null, maxAgeDays: input.maxAgeDays ?? null, tenantId, serviceId, sortOrder: (last._max.sortOrder ?? -1) + 1 },
      });
      await this.audit.log({ action: 'service_requirement.created', resourceType: 'Service', resourceId: serviceId, after: { requirementId: row.id, ...input } }, tx);
      return row;
    });
  }

  updateRequirement(serviceId: string, requirementId: string, input: UpdateServiceRequirementInput) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      await this.requireService(tx, serviceId);
      const before = found(await tx.serviceRequirement.findFirst({ where: { id: requirementId, serviceId, tenantId } }), 'Requirement');
      if (input.documentTypeKey && input.documentTypeKey !== before.documentTypeKey) await this.assertDocumentTypeKey(tx, input.documentTypeKey);
      const after = await tx.serviceRequirement.update({ where: { id: requirementId }, data: input });
      await this.audit.log({ action: 'service_requirement.updated', resourceType: 'Service', resourceId: serviceId, before: { requirementId, ...pick(before, Object.keys(input)) }, after: { requirementId, ...input } }, tx);
      return after;
    });
  }

  removeRequirement(serviceId: string, requirementId: string) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      await this.requireService(tx, serviceId);
      const before = found(await tx.serviceRequirement.findFirst({ where: { id: requirementId, serviceId, tenantId } }), 'Requirement');
      await tx.serviceRequirement.delete({ where: { id: requirementId } });
      await this.audit.log({ action: 'service_requirement.deleted', resourceType: 'Service', resourceId: serviceId, before: { requirementId, documentTypeKey: before.documentTypeKey, label: before.label } }, tx);
      return { status: 'DELETED' as const };
    });
  }

  reorderRequirements(serviceId: string, ids: string[]) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      await this.requireService(tx, serviceId);
      const all = await tx.serviceRequirement.findMany({ where: { tenantId, serviceId }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }], select: { id: true } });
      const known = new Set(all.map((r) => r.id));
      if (ids.some((id) => !known.has(id))) throw Errors.notFound('Requirement');
      const order = [...ids, ...all.map((r) => r.id).filter((id) => !ids.includes(id))];
      for (const [i, id] of order.entries()) await tx.serviceRequirement.update({ where: { id }, data: { sortOrder: i } });
      await this.audit.log({ action: 'service_requirement.reordered', resourceType: 'Service', resourceId: serviceId, after: { order } }, tx);
      return tx.serviceRequirement.findMany({ where: { tenantId, serviceId }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
    });
  }
}

export const versionConflict = () =>
  Errors.conflict('VERSION_CONFLICT', 'Someone else changed this record while you were editing it. Reload it and apply your changes again.');
