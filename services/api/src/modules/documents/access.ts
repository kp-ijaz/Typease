import { Injectable } from '@nestjs/common';
import type { Document, Prisma, RequestDocument, ServiceRequest } from '@typease/database';
import { can, canAny, ctx, isStaff } from '../../common/context';
import { TenantDb, Tx } from '../../common/db/prisma.service';
import { Errors, found } from '../../common/errors';
import { assertCustomerNotErased } from '../../common/customer-ref';
import { assertBranchAccess, branchFilter, ownCorporateAccountId } from '../../common/scope';
import { isRestricted, RESTRICTED_PREFIX } from './presenters';

export type ActorScope = 'STAFF' | 'CUSTOMER' | 'CORPORATE_ADMIN';
const CORPORATE_ADMIN_READ = ['corp.employees.read', 'corp.requests.read', 'corp.account.read'];
const CORPORATE_ADMIN_WRITE = ['corp.employees.manage', 'corp.requests.create'];
const CLOSED_REQUEST = ['COMPLETED', 'CANCELLED'];
/** Module-owned files (scheduled reports ...) are outside the general rules: nobody reaches them through this class. */
const NOT_RESTRICTED: Prisma.DocumentWhereInput = { OR: [{ category: null }, { NOT: { category: { startsWith: RESTRICTED_PREFIX } } }] };

export interface OwnerInput {
  customerId?: string | null;
  corporateAccountId?: string | null;
  requestId?: string | null;
  checklistItemId?: string | null;
}
export interface ResolvedOwner {
  customerId: string | null;
  corporateAccountId: string | null;
  requestId: string | null;
  checklistItemId: string | null;
  checklistItem: RequestDocument | null;
}

/**
 * Resource-level rules of the vault: which documents an actor may see, and for
 * whom an actor may upload. Permissions (checked by the guard) say WHAT a role
 * may do; this class says on WHICH documents.
 *
 *  - Staff: documents of the tenant; documents filed under a request follow the
 *    request's branch, and operators limited to assigned requests only see
 *    documents of requests assigned to them.
 *  - Customers / corporate employees: documents of their own customer record
 *    that staff have not hidden (customerVisible).
 *  - Corporate administrators: documents of their company and of its active
 *    employees, again only when customerVisible.
 *  - Platform support: like staff, but only under an approved access grant that
 *    includes document.read (enforced by the guard through the grant's scopes).
 *  - Restricted files (category `restricted:<owner>`, e.g. scheduled reports) are
 *    excluded for everybody, holders of document.read included: the module that
 *    owns them authorises access itself (DocumentStorePort.restrictedDownloadLink).
 */
@Injectable()
export class DocumentAccess {
  constructor(private readonly db: TenantDb) {}

  scope(): ActorScope {
    const c = ctx();
    if (isStaff(c)) return 'STAFF';
    if (c.actorType === 'CORPORATE' && canAny([...CORPORATE_ADMIN_READ, ...CORPORATE_ADMIN_WRITE], c)) return 'CORPORATE_ADMIN';
    return 'CUSTOMER';
  }
  isStaff(): boolean {
    return this.scope() === 'STAFF';
  }

  /** The customer record a customer / corporate employee acts for. */
  async ownCustomerId(tx: Tx): Promise<string> {
    const c = ctx();
    if (c.customerId) return c.customerId;
    if (c.corporateEmployeeId) {
      const employee = await tx.corporateEmployee.findFirst({ where: { id: c.corporateEmployeeId, tenantId: this.db.tenantId, status: 'ACTIVE' } });
      if (employee) return employee.customerId;
    }
    throw Errors.forbidden('NO_CUSTOMER_PROFILE', 'Your account is not linked to a customer profile.');
  }

  /** Operators with request.read.assigned (and not request.read.all) only work on their own requests. */
  private assignedOnly(): boolean {
    const c = ctx();
    return c.actorType === 'STAFF' && can('request.read.assigned', c) && !can('request.read.all', c);
  }
  private requestScope(): Prisma.ServiceRequestWhereInput | null {
    const c = ctx();
    const and: Prisma.ServiceRequestWhereInput[] = [];
    const branches = branchFilter(c);
    if (branches) and.push({ branchId: branches });
    if (this.assignedOnly()) and.push({ OR: [{ assignedToId: c.membershipId ?? '' }, { reviewerId: c.membershipId ?? '' }] });
    return and.length ? { AND: and } : null;
  }

  /** Prisma filter selecting the documents the current actor may read. */
  async readFilter(tx: Tx): Promise<Prisma.DocumentWhereInput> {
    return { AND: [await this.scopeFilter(tx), NOT_RESTRICTED] };
  }

  private async scopeFilter(tx: Tx): Promise<Prisma.DocumentWhereInput> {
    const tenantId = this.db.tenantId;
    switch (this.scope()) {
      case 'STAFF': {
        if (!can('document.read')) throw Errors.forbidden();
        const requestScope = this.requestScope();
        return requestScope ? { tenantId, OR: [{ requestId: null }, { request: requestScope }] } : { tenantId };
      }
      case 'CORPORATE_ADMIN': {
        if (!canAny(CORPORATE_ADMIN_READ)) throw Errors.forbidden();
        const accountId = ownCorporateAccountId();
        return {
          tenantId,
          customerVisible: true,
          status: { not: 'DELETED' },
          OR: [
            { corporateAccountId: accountId },
            { customer: { corporateEmployees: { some: { corporateAccountId: accountId, status: 'ACTIVE' } } } },
            { customerId: null, request: { corporateAccountId: accountId } },
          ],
        };
      }
      default: {
        if (!can('self.documents')) throw Errors.forbidden();
        const own = await this.ownCustomerId(tx);
        return { tenantId, customerVisible: true, status: { not: 'DELETED' }, OR: [{ customerId: own }, { customerId: null, request: { customerId: own } }] };
      }
    }
  }

  /** Loads a document the actor may read. Anything else is "not found" (never reveals existence). */
  async findReadable(tx: Tx, id: string): Promise<Document> {
    return found(await tx.document.findFirst({ where: { AND: [{ id, tenantId: this.db.tenantId }, await this.readFilter(tx)] } }), 'Document');
  }

  /** Loads a document the actor may add files to (new version, completing an upload). */
  async findWritable(tx: Tx, id: string): Promise<Document> {
    const tenantId = this.db.tenantId;
    const doc = found(await tx.document.findFirst({ where: { id, tenantId } }), 'Document');
    if (isRestricted(doc)) throw Errors.notFound('Document');
    switch (this.scope()) {
      case 'STAFF': {
        if (!can('document.upload')) throw Errors.forbidden();
        if (doc.requestId) await this.assertRequestInScope(tx, doc.requestId);
        return doc;
      }
      case 'CORPORATE_ADMIN': {
        if (!canAny(CORPORATE_ADMIN_WRITE)) throw Errors.forbidden();
        const accountId = ownCorporateAccountId();
        const mine =
          doc.customerVisible &&
          (doc.corporateAccountId === accountId ||
            (doc.customerId && (await tx.corporateEmployee.count({ where: { tenantId, corporateAccountId: accountId, customerId: doc.customerId, status: 'ACTIVE' } })) > 0));
        if (!mine) throw Errors.notFound('Document');
        return doc;
      }
      default: {
        if (!can('self.documents')) throw Errors.forbidden();
        if (!doc.customerVisible || !doc.customerId || doc.customerId !== (await this.ownCustomerId(tx))) throw Errors.notFound('Document');
        return doc;
      }
    }
  }

  /** Staff: the request must be in a branch (and assignment) the member can work on. */
  async assertRequestInScope(tx: Tx, requestId: string): Promise<ServiceRequest> {
    const request = found(await tx.serviceRequest.findFirst({ where: { id: requestId, tenantId: this.db.tenantId, deletedAt: null } }), 'Request');
    const c = ctx();
    if (c.actorType === 'STAFF') {
      assertBranchAccess(request.branchId, c);
      if (this.assignedOnly() && request.assignedToId !== c.membershipId && request.reviewerId !== c.membershipId) throw Errors.notFound('Request');
    }
    return request;
  }

  /** May the actor see this request at all? Used by read-only helpers such as the checklist assistant. */
  async findReadableRequest(tx: Tx, requestId: string): Promise<ServiceRequest> {
    const tenantId = this.db.tenantId;
    const request = found(await tx.serviceRequest.findFirst({ where: { id: requestId, tenantId, deletedAt: null } }), 'Request');
    switch (this.scope()) {
      case 'STAFF':
        if (!can('document.read')) throw Errors.forbidden();
        await this.assertRequestInScope(tx, requestId);
        return request;
      case 'CORPORATE_ADMIN':
        if (request.corporateAccountId !== ownCorporateAccountId()) throw Errors.notFound('Request');
        return request;
      default:
        if (request.customerId !== (await this.ownCustomerId(tx))) throw Errors.notFound('Request');
        return request;
    }
  }

  /**
   * Validates who a new document is for. Ids supplied by the client are looked
   * up inside the tenant; customers and corporate users are pinned to their own
   * customer record / company regardless of what they send.
   */
  async resolveOwner(tx: Tx, input: OwnerInput): Promise<ResolvedOwner> {
    const tenantId = this.db.tenantId;
    let customerId = input.customerId ?? null;
    let corporateAccountId = input.corporateAccountId ?? null;
    let requestId = input.requestId ?? null;
    let checklistItem: RequestDocument | null = null;

    if (input.checklistItemId) {
      checklistItem = found(await tx.requestDocument.findFirst({ where: { id: input.checklistItemId, tenantId } }), 'Checklist item');
      if (requestId && requestId !== checklistItem.requestId) throw Errors.unprocessable('CHECKLIST_MISMATCH', 'That checklist item belongs to a different request.');
      requestId = checklistItem.requestId;
    }
    const request = requestId ? found(await tx.serviceRequest.findFirst({ where: { id: requestId, tenantId, deletedAt: null } }), 'Request') : null;

    switch (this.scope()) {
      case 'STAFF': {
        if (!can('document.upload')) throw Errors.forbidden();
        if (request) await this.assertRequestInScope(tx, request.id);
        if (corporateAccountId) found(await tx.corporateAccount.findFirst({ where: { id: corporateAccountId, tenantId, deletedAt: null } }), 'Corporate account');
        if (request) {
          customerId ??= request.customerId;
          corporateAccountId ??= request.corporateAccountId;
        }
        break;
      }
      case 'CORPORATE_ADMIN': {
        if (!canAny(CORPORATE_ADMIN_WRITE)) throw Errors.forbidden();
        const accountId = ownCorporateAccountId();
        if (corporateAccountId && corporateAccountId !== accountId) throw Errors.notFound('Corporate account');
        if (request && request.corporateAccountId !== accountId) throw Errors.notFound('Request');
        if (customerId) {
          const employee = await tx.corporateEmployee.findFirst({ where: { tenantId, corporateAccountId: accountId, customerId, status: 'ACTIVE' } });
          if (!employee) throw Errors.notFound('Employee');
        }
        corporateAccountId = accountId;
        break;
      }
      default: {
        if (!can('self.documents')) throw Errors.forbidden();
        const own = await this.ownCustomerId(tx);
        if (customerId && customerId !== own) throw Errors.notFound('Customer');
        if (corporateAccountId) throw Errors.notFound('Corporate account');
        if (request && request.customerId !== own) throw Errors.notFound('Request');
        customerId = own;
        break;
      }
    }

    // COMPLETION lines are the output of the request (the issued visa, the typed contract ...): only the
    // centre provides them. Checked after the ownership rules, so a line of somebody else's request stays a 404.
    if (checklistItem?.kind === 'COMPLETION' && this.scope() !== 'STAFF') {
      throw Errors.forbidden('COMPLETION_DOCUMENT_STAFF_ONLY', `"${checklistItem.label}" is a completed document that the centre adds when your request is ready. You can only upload the documents the centre asked you for.`);
    }
    if (request && this.scope() !== 'STAFF' && CLOSED_REQUEST.includes(request.status)) {
      throw Errors.conflict('REQUEST_CLOSED', 'This request is closed, so documents can no longer be added to it. Please contact the centre.');
    }
    if (customerId) {
      await assertCustomerNotErased(tx, tenantId, customerId);
      const customer = found(await tx.customer.findFirst({ where: { id: customerId, tenantId, deletedAt: null } }), 'Customer');
      if (customer.status === 'ANONYMISED' || customer.status === 'MERGED') {
        throw Errors.conflict('CUSTOMER_INACTIVE', 'This customer record is no longer active, so documents cannot be added to it.');
      }
    }
    if (!customerId && !corporateAccountId && !requestId) {
      throw Errors.unprocessable('DOCUMENT_OWNER_REQUIRED', 'Choose the customer, company or request this document belongs to.');
    }
    return { customerId, corporateAccountId, requestId, checklistItemId: checklistItem?.id ?? null, checklistItem };
  }
}
