import { Injectable } from '@nestjs/common';
import type { Prisma } from '@typease/database';
import { ctx, Ctx } from '../../common/context';
import { TenantDb, Tx } from '../../common/db/prisma.service';
import { Errors, found } from '../../common/errors';
import { branchFilter } from '../../common/scope';

/** Who is acting, as far as request scoping is concerned. */
export type RequestActorKind = 'STAFF' | 'CUSTOMER' | 'CORPORATE_ADMIN' | 'CORPORATE_EMPLOYEE' | 'SYSTEM';

export function requestActorKind(c: Ctx = ctx()): RequestActorKind {
  if (c.actorType === 'SYSTEM' || c.actorType === 'AUTOMATION') return 'SYSTEM';
  if (c.actorType === 'STAFF' || c.actorType === 'PLATFORM') return 'STAFF';
  if (c.actorType === 'CORPORATE') return c.permissions.has('corp.requests.read') || c.permissions.has('corp.requests.create') ? 'CORPORATE_ADMIN' : 'CORPORATE_EMPLOYEE';
  return 'CUSTOMER';
}
/** Customers, corporate admins and corporate employees: people outside the centre. */
export const isExternalActor = (c: Ctx = ctx()) => ['CUSTOMER', 'CORPORATE_ADMIN', 'CORPORATE_EMPLOYEE'].includes(requestActorKind(c));
export const isStaffActor = (c: Ctx = ctx()) => requestActorKind(c) === 'STAFF';

/**
 * Row-level scoping of service requests. Permissions say what an actor may
 * do; this says on which requests:
 *
 *  staff with request.read.all       requests of their branches
 *  staff with request.read.assigned  requests where they are the operator or the reviewer
 *  customers                         requests of their own customer record
 *  corporate admins                  requests of their company
 *  corporate employees               requests of their own customer record: the company's requests about
 *                                    them and their personal ones (like a customer; the company's
 *                                    administrators see only the company's)
 *
 * Everything outside the scope looks like it does not exist (404).
 */
@Injectable()
export class RequestAccess {
  constructor(private readonly db: TenantDb) {}

  /** The customer record a self-service user acts for. */
  async selfCustomerId(tx: Tx, c: Ctx = ctx()): Promise<string> {
    if (c.customerId) return c.customerId;
    if (c.actorType === 'CORPORATE' && c.corporateEmployeeId) {
      const employee = await tx.corporateEmployee.findFirst({ where: { id: c.corporateEmployeeId, tenantId: this.db.tenantId }, select: { customerId: true } });
      if (employee) return employee.customerId;
    }
    throw Errors.forbidden('NO_CUSTOMER_PROFILE', 'Your account is not linked to a customer profile.');
  }

  async scope(tx: Tx, c: Ctx = ctx()): Promise<Prisma.ServiceRequestWhereInput> {
    switch (requestActorKind(c)) {
      case 'SYSTEM':
        return {};
      case 'STAFF': {
        const branches = branchFilter(c);
        const base: Prisma.ServiceRequestWhereInput = branches ? { branchId: branches } : {};
        if (c.permissions.has('request.read.all')) return base;
        if (c.permissions.has('request.read.assigned') && c.membershipId) return { ...base, OR: [{ assignedToId: c.membershipId }, { reviewerId: c.membershipId }] };
        // No read permission: nothing is visible.
        return { id: { in: [] } };
      }
      case 'CORPORATE_ADMIN': {
        if (!c.corporateAccountId) throw Errors.forbidden('NO_CORPORATE_ACCOUNT', 'Your account is not linked to a company.');
        return { corporateAccountId: c.corporateAccountId };
      }
      // An employee in the corporate portal sees the requests about themselves (the company's and their own), like a customer.
      default:
        return { customerId: await this.selfCustomerId(tx, c) };
    }
  }

  /** Loads a request the current actor may see, or throws 404. */
  async load(tx: Tx, id: string) {
    return found(await tx.serviceRequest.findFirst({ where: { AND: [{ id, tenantId: this.db.tenantId, deletedAt: null }, await this.scope(tx)] } }), 'Request');
  }

  async assertVisible(tx: Tx, id: string): Promise<void> {
    const row = await tx.serviceRequest.findFirst({ where: { AND: [{ id, tenantId: this.db.tenantId, deletedAt: null }, await this.scope(tx)] }, select: { id: true } });
    if (!row) throw Errors.notFound('Request');
  }
}
