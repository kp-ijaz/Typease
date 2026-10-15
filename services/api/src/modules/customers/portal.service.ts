import { Injectable } from '@nestjs/common';
import { Prisma } from '@typease/database';
import type { UpdateOwnCustomerInput } from '@typease/validation';
import { AuditService } from '../../common/audit.service';
import { ctx } from '../../common/context';
import { SystemDb, TenantDb, Tx } from '../../common/db/prisma.service';
import { Errors, found } from '../../common/errors';
import { ownCustomerId } from '../../common/scope';
import { AuthService } from '../auth/auth.service';
import { ConsentsService } from './consents.service';
import { CustomerRow, dateOnly, DEFAULT_COMMUNICATION_PREFS, ownCustomerView, parseDateOnly } from './customer-view';
import { assertEditable, CustomersService } from './customers.service';

const devTokens = () => process.env.EXPOSE_DEV_TOKENS === 'true' && process.env.NODE_ENV !== 'production';

/**
 * Details a customer may fill in themselves, and correct for as long as the value is their own entry. Once
 * somebody at the centre entered or confirmed the value (at the counter, from a document), it counts as
 * verified and only a correction request changes it.
 */
export const SELF_SERVICE_FIELDS = ['phone', 'nationality', 'dateOfBirth'] as const;
export type SelfServiceField = (typeof SELF_SERVICE_FIELDS)[number];
const FIELD_WORDS: Record<SelfServiceField, string> = { phone: 'phone number', nationality: 'nationality', dateOfBirth: 'date of birth' };

/** Portal access for customers: the staff-sent invitation and what customers may do with their own record. */
@Injectable()
export class CustomerPortalService {
  constructor(
    private readonly db: TenantDb,
    private readonly sys: SystemDb,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
    private readonly customers: CustomersService,
    private readonly consents: ConsentsService,
  ) {}

  /**
   * Staff invite a customer to the portal. The login is linked to exactly this
   * customer record, so the customer sees their existing requests and documents
   * from the first sign-in.
   */
  async invite(customerId: string, input: { email?: string }) {
    const c = ctx();
    // 1. Decide the address before any account is touched.
    const { email, fullName } = await this.db.tx(async (tx) => {
      const customer = await this.customers.require(tx, customerId);
      assertEditable(customer);
      const address = input.email ?? customer.email;
      if (!address) throw Errors.unprocessable('EMAIL_REQUIRED', 'Add an email address for this customer, or enter the address the invitation should go to.');
      return { email: address, fullName: customer.fullName };
    });
    // 2. Users are global identities (one person, possibly several centres), so the placeholder
    //    account is created on the system connection. It has no password until the invitation is accepted.
    const user = await this.sys.client.user.upsert({ where: { email }, create: { email, fullName }, update: {}, select: { id: true, email: true } });

    // 3. Link the login to the customer inside the tenant.
    const { membership, invitation } = await this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const customer = await this.customers.require(tx, customerId);
      assertEditable(customer);
      const linked = await tx.tenantMembership.findMany({ where: { tenantId, customerId, kind: 'CUSTOMER', status: { not: 'REMOVED' } }, select: { id: true, status: true, userId: true } });
      const active = linked.find((m) => m.status === 'ACTIVE' || m.status === 'SUSPENDED');
      if (active) throw Errors.conflict('ALREADY_HAS_ACCESS', 'This customer already has portal access.');
      // The same person can only sign in to one customer profile per centre.
      const sameUser = await tx.tenantMembership.findFirst({ where: { tenantId, userId: user.id, kind: 'CUSTOMER' } });
      if (sameUser && sameUser.status !== 'REMOVED' && sameUser.customerId !== customerId) {
        throw Errors.conflict('EMAIL_IN_USE', 'This email address already signs in to another customer profile at this centre. Use a different address, or merge the two records.');
      }
      const role = found(await tx.role.findFirst({ where: { tenantId, key: 'customer', kind: 'CUSTOMER' } }), 'Customer role');
      const tenant = await tx.tenant.findFirstOrThrow({ where: { id: tenantId }, select: { name: true } });
      // An earlier, unanswered invitation to a different address is withdrawn.
      for (const stale of linked.filter((m) => m.userId !== user.id)) await tx.tenantMembership.update({ where: { id: stale.id }, data: { status: 'REMOVED', customerId: null } });

      const data = { roleId: role.id, status: 'INVITED' as const, customerId, allBranches: true, invitedById: c.userId ?? null, invitedAt: new Date(), joinedAt: null };
      const m = sameUser ? await tx.tenantMembership.update({ where: { id: sameUser.id }, data }) : await tx.tenantMembership.create({ data: { ...data, tenantId, userId: user.id, kind: 'CUSTOMER' } });
      if (!customer.email) await tx.customer.update({ where: { id: customerId }, data: { email } });
      await this.audit.log({ action: 'customer.portal_invited', resourceType: 'Customer', resourceId: customerId, summary: `${customer.customerNo}: portal invitation sent`, after: { membershipId: m.id, email } }, tx);
      return {
        membership: m,
        invitation: { tenantId, membershipId: m.id, email, fullName: customer.fullName, app: 'customer' as const, centreName: tenant.name, roleName: role.name, language: customer.preferredLanguage },
      };
    });
    // 4. One-time tokens live outside the tenant connection: send after the transaction committed.
    const { token } = await this.auth.sendInvitation(invitation);
    return { membershipId: membership.id, status: 'INVITED' as const, email, ...(devTokens() ? { dev: { invitationToken: token } } : {}) };
  }

  // ------------------------------------------------------------------ self-service
  /**
   * Which of the self-service details were entered or confirmed by the centre (and are therefore locked for the
   * customer). There is no "verified" column: the audit trail of the record says who set each value last -
   * `customer.self_updated` is the customer, everything else (registration at the counter, an edit by staff,
   * values applied from a reviewed document, a merge) is the centre. A value that came with a record the
   * customer created by registering online is the customer's own; a value nobody can account for is treated
   * as the centre's (locked).
   */
  private async verifiedByCentre(tx: Tx, customer: CustomerRow): Promise<Record<SelfServiceField, boolean>> {
    const current: Record<SelfServiceField, unknown> = { phone: customer.phone, nationality: customer.nationality, dateOfBirth: customer.dateOfBirth };
    const pending = SELF_SERVICE_FIELDS.filter((f) => current[f] !== null && current[f] !== undefined);
    const out: Record<SelfServiceField, boolean> = { phone: false, nationality: false, dateOfBirth: false };
    if (!pending.length) return out; // empty fields are open
    const trail = await tx.auditLog.findMany({
      where: { tenantId: this.db.tenantId, resourceType: 'Customer', resourceId: customer.id, action: { in: ['customer.created', 'customer.updated', 'customer.self_updated', 'customer.updated_from_document', 'customer.merged'] } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { action: true, after: true },
      take: 500,
    });
    const sets = (row: { action: string; after: unknown }, field: SelfServiceField): boolean => {
      const after = (row.after ?? {}) as Record<string, unknown>;
      if (row.action === 'customer.updated_from_document') return Array.isArray(after.fields) && after.fields.includes(field);
      if (row.action === 'customer.merged') return Array.isArray(after.filledFields) && after.filledFields.includes(field);
      return after[field] !== null && after[field] !== undefined;
    };
    for (const field of pending) {
      const last = trail.find((row) => sets(row, field));
      // No entry sets it: the value came with the record. A record without a creator was made by the person registering online.
      out[field] = last ? last.action !== 'customer.self_updated' : customer.createdById !== null;
    }
    return out;
  }
  private ownView(customer: CustomerRow, verified: Record<SelfServiceField, boolean>) {
    return {
      ...ownCustomerView(customer),
      /** May I change this myself (PATCH /me/customer)? `false` = confirmed by the centre: send a correction request. */
      editable: Object.fromEntries(SELF_SERVICE_FIELDS.map((f) => [f, !verified[f]])) as Record<SelfServiceField, boolean>,
    };
  }

  ownProfile() {
    const customerId = ownCustomerId();
    return this.db.tx(async (tx) => {
      const customer = await this.customers.requireOwn(tx, customerId);
      return this.ownView(customer, await this.verifiedByCentre(tx, customer));
    });
  }

  /**
   * Customers change their name, language, address and communication preferences freely, and fill in or correct
   * their phone number, nationality and date of birth while those are empty or their own entry. A value the
   * centre entered or confirmed, the email address and identity numbers are changed by the centre only
   * (correction request).
   */
  updateOwnProfile(input: UpdateOwnCustomerInput) {
    const customerId = ownCustomerId();
    return this.db.tx(async (tx) => {
      const before = await this.customers.requireOwn(tx, customerId);
      if (before.status !== 'ACTIVE') throw Errors.conflict('PROFILE_LOCKED', 'Your profile cannot be changed at the moment. Please contact the centre.');
      const data: Record<string, unknown> = {};
      if (input.fullName !== undefined) data.fullName = input.fullName;
      if (input.fullNameAr !== undefined) data.fullNameAr = input.fullNameAr;
      if (input.preferredLanguage !== undefined) data.preferredLanguage = input.preferredLanguage;
      if (input.address !== undefined) data.address = input.address === null ? Prisma.DbNull : input.address;
      const prefsBefore = { ...DEFAULT_COMMUNICATION_PREFS, ...((before.communicationPrefs as object) ?? {}) };
      const prefsAfter = input.communicationPrefs ? { ...prefsBefore, ...input.communicationPrefs } : prefsBefore;
      if (input.communicationPrefs) data.communicationPrefs = prefsAfter;

      // Phone, nationality, date of birth: only what really changes is looked at; a verified value needs a correction request.
      const verified = await this.verifiedByCentre(tx, before);
      const wanted: Partial<Record<SelfServiceField, unknown>> = {};
      if (input.phone !== undefined && (input.phone ?? null) !== before.phone) wanted.phone = input.phone ?? null;
      if (input.nationality !== undefined && (input.nationality ?? null) !== before.nationality) wanted.nationality = input.nationality ?? null;
      if (input.dateOfBirth !== undefined && (input.dateOfBirth ?? null) !== dateOnly(before.dateOfBirth)) wanted.dateOfBirth = parseDateOnly(input.dateOfBirth);
      const locked = (Object.keys(wanted) as SelfServiceField[]).filter((f) => verified[f]);
      if (locked.length) {
        throw Errors.conflict(
          'CORRECTION_REQUIRED',
          `Your ${locked.map((f) => FIELD_WORDS[f]).join(' and ')} ${locked.length === 1 ? 'was' : 'were'} confirmed by the centre and cannot be changed here. Send a correction request and the centre will update ${locked.length === 1 ? 'it' : 'them'}.`,
          { fields: locked, how: 'POST /privacy/my/requests { "type": "CORRECTION", "details": "..." }' },
        );
      }
      Object.assign(data, wanted);
      const keys = Object.keys(data);
      if (!keys.length) return this.ownView(before, verified);

      await tx.customer.update({ where: { id: customerId }, data: { ...data, version: { increment: 1 }, lastActivityAt: new Date() } });
      // Ticking or unticking WhatsApp is a consent decision.
      if (prefsAfter.whatsapp !== prefsBefore.whatsapp) {
        await this.consents.apply(tx, customerId, { purpose: 'WHATSAPP', granted: prefsAfter.whatsapp, capturedVia: ctx().app === 'mobile' ? 'MOBILE' : 'PORTAL' }, { mirror: false });
      }
      const after = await this.customers.requireOwn(tx, customerId);
      // Dates travel as YYYY-MM-DD in the trail as everywhere else.
      const pick = (row: Record<string, any>) => Object.fromEntries(keys.map((k) => [k, k === 'dateOfBirth' ? dateOnly(row[k]) : (row[k] ?? null)]));
      await this.audit.log({ action: 'customer.self_updated', resourceType: 'Customer', resourceId: customerId, summary: `Changed by the customer: ${keys.join(', ')}`, before: pick(before), after: pick(after) }, tx);
      // What the customer just entered is theirs to correct again.
      return this.ownView(after, await this.verifiedByCentre(tx, after));
    });
  }
}
