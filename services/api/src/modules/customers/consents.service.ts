import { customerErasedError } from '../../common/customer-ref';
import { Injectable } from '@nestjs/common';
import { CONSENT_PURPOSES } from '@typease/validation';
import type { ConsentInput, ConsentPurpose, LawfulBasis, StaffConsentInput } from '@typease/validation';
import { AuditService } from '../../common/audit.service';
import { ctx } from '../../common/context';
import { TenantDb, Tx } from '../../common/db/prisma.service';
import { Errors, found } from '../../common/errors';
import { ownCustomerId } from '../../common/scope';
import { DEFAULT_COMMUNICATION_PREFS } from './customer-view';

export type CapturedVia = 'STAFF_RECORDED' | 'PORTAL' | 'MOBILE';

/** Why each purpose is processed when nobody says otherwise. */
const DEFAULT_BASIS: Record<ConsentPurpose, LawfulBasis> = {
  SERVICE_PROCESSING: 'CONTRACT',
  REMINDERS: 'CONSENT',
  MARKETING: 'CONSENT',
  AI_PROCESSING: 'CONSENT',
  DOCUMENT_REUSE: 'CONSENT',
  WHATSAPP: 'CONSENT',
};
export const CONSENT_DESCRIPTIONS: Record<ConsentPurpose, string> = {
  SERVICE_PROCESSING: 'Using my details and documents to handle the services I request',
  REMINDERS: 'Reminders before my documents expire',
  MARKETING: 'Offers and news from the centre',
  AI_PROCESSING: 'AI-assisted reading of my documents to pre-fill forms',
  DOCUMENT_REUSE: 'Re-using valid documents on my file for new requests',
  WHATSAPP: 'Messages on WhatsApp',
};

export interface ConsentChange {
  purpose: ConsentPurpose;
  granted: boolean;
  lawfulBasis?: LawfulBasis;
  noticeVersion?: string;
  capturedVia: CapturedVia;
}

/**
 * Consent per customer and purpose. `customer_consents` holds the current
 * state; every change also appends a row to `consent_records`, which the
 * database keeps append-only, so the history can always prove who decided
 * what, when and through which channel.
 */
@Injectable()
export class ConsentsService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
  ) {}

  /**
   * Applies one decision. Returns false (and writes nothing) when it changes
   * nothing: saving the same choice twice does not create history.
   * `mirror` keeps the two convenience columns on the customer in step
   * (marketingOptIn, communicationPrefs.whatsapp).
   */
  async apply(tx: Tx, customerId: string, change: ConsentChange, opts: { mirror?: boolean } = {}): Promise<boolean> {
    const tenantId = this.db.tenantId;
    const c = ctx();
    const current = await tx.customerConsent.findFirst({ where: { tenantId, customerId, purpose: change.purpose } });
    const status = change.granted ? ('GRANTED' as const) : ('WITHDRAWN' as const);
    const lawfulBasis = change.lawfulBasis ?? current?.lawfulBasis ?? DEFAULT_BASIS[change.purpose];
    const noticeVersion = change.noticeVersion ?? current?.noticeVersion ?? null;
    if (current && current.status === status && current.lawfulBasis === lawfulBasis && (current.noticeVersion ?? null) === noticeVersion) return false;

    const now = new Date();
    await tx.consentRecord.create({
      data: { tenantId, customerId, userId: c.actorType === 'CUSTOMER' ? (c.userId ?? null) : null, purpose: change.purpose, status, lawfulBasis, noticeVersion, capturedVia: change.capturedVia, capturedById: c.userId ?? null, ip: c.ip ?? null },
    });
    if (current) {
      await tx.customerConsent.update({
        where: { id: current.id },
        data: { status, lawfulBasis, noticeVersion, ...(change.granted ? { grantedAt: now, withdrawnAt: null } : { withdrawnAt: now }) },
      });
    } else {
      await tx.customerConsent.create({ data: { tenantId, customerId, purpose: change.purpose, status, lawfulBasis, noticeVersion, grantedAt: change.granted ? now : null, withdrawnAt: change.granted ? null : now } });
    }
    if (opts.mirror !== false) await this.mirror(tx, customerId, change.purpose, change.granted);
    return true;
  }

  private async mirror(tx: Tx, customerId: string, purpose: ConsentPurpose, granted: boolean) {
    if (purpose === 'MARKETING') await tx.customer.update({ where: { id: customerId }, data: { marketingOptIn: granted } });
    if (purpose === 'WHATSAPP') {
      const row = await tx.customer.findFirstOrThrow({ where: { id: customerId, tenantId: this.db.tenantId }, select: { communicationPrefs: true } });
      await tx.customer.update({ where: { id: customerId }, data: { communicationPrefs: { ...DEFAULT_COMMUNICATION_PREFS, ...((row.communicationPrefs as object) ?? {}), whatsapp: granted } } });
    }
  }

  /** All purposes with their current state; purposes never decided show as NOT_SET. */
  async state(tx: Tx, customerId: string) {
    const rows = await tx.customerConsent.findMany({ where: { tenantId: this.db.tenantId, customerId } });
    return CONSENT_PURPOSES.map((purpose) => {
      const row = rows.find((r) => r.purpose === purpose);
      return {
        purpose,
        description: CONSENT_DESCRIPTIONS[purpose],
        status: row?.status ?? ('NOT_SET' as const),
        granted: row?.status === 'GRANTED',
        lawfulBasis: row?.lawfulBasis ?? DEFAULT_BASIS[purpose],
        noticeVersion: row?.noticeVersion ?? null,
        grantedAt: row?.grantedAt ?? null,
        withdrawnAt: row?.withdrawnAt ?? null,
        updatedAt: row?.updatedAt ?? null,
      };
    });
  }

  private async requireCustomer(tx: Tx, customerId: string) {
    const customer = found(await tx.customer.findFirst({ where: { id: customerId, tenantId: this.db.tenantId, OR: [{ deletedAt: null }, { status: 'ANONYMISED' }] }, select: { id: true, status: true, customerNo: true } }), 'Customer');
    return customer;
  }
  private assertOpen(customer: { status: string }) {
    if (customer.status === 'ANONYMISED') throw customerErasedError();
    if (customer.status === 'MERGED') {
      throw Errors.conflict('CUSTOMER_READ_ONLY', 'This customer record was merged into another one and can no longer be changed.');
    }
  }

  // ------------------------------------------------------------------ staff
  /** Current state plus the history. After a merge the history of the retired records is included. */
  forCustomer(customerId: string) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      await this.requireCustomer(tx, customerId);
      const mergedFrom = await tx.customer.findMany({ where: { tenantId, mergedIntoId: customerId }, select: { id: true } });
      const history = await tx.consentRecord.findMany({
        where: { tenantId, customerId: { in: [customerId, ...mergedFrom.map((m) => m.id)] } },
        orderBy: { createdAt: 'desc' },
        take: 200,
        select: { id: true, customerId: true, purpose: true, status: true, lawfulBasis: true, noticeVersion: true, capturedVia: true, capturedById: true, createdAt: true },
      });
      return { consents: await this.state(tx, customerId), history };
    });
  }

  recordByStaff(customerId: string, input: StaffConsentInput) {
    return this.db.tx(async (tx) => {
      const customer = await this.requireCustomer(tx, customerId);
      this.assertOpen(customer);
      const changed = await this.apply(tx, customerId, { ...input, capturedVia: 'STAFF_RECORDED' });
      if (changed) {
        await this.audit.log(
          { action: input.granted ? 'customer.consent_granted' : 'customer.consent_withdrawn', resourceType: 'Customer', resourceId: customerId, summary: `${input.purpose} recorded by staff`, after: { purpose: input.purpose, granted: input.granted, lawfulBasis: input.lawfulBasis ?? null, noticeVersion: input.noticeVersion ?? null, capturedVia: 'STAFF_RECORDED' } },
          tx,
        );
      }
      return { changed, consents: await this.state(tx, customerId) };
    });
  }

  // ------------------------------------------------------------------ customer self-service
  own() {
    const customerId = ownCustomerId();
    return this.db.tx(async (tx) => {
      await this.requireCustomer(tx, customerId);
      return { consents: await this.state(tx, customerId) };
    });
  }

  setOwn(changes: ConsentInput[]) {
    const customerId = ownCustomerId();
    const capturedVia: CapturedVia = ctx().app === 'mobile' ? 'MOBILE' : 'PORTAL';
    return this.db.tx(async (tx) => {
      const customer = await this.requireCustomer(tx, customerId);
      this.assertOpen(customer);
      const applied: ConsentPurpose[] = [];
      for (const change of changes) {
        if (change.purpose === 'SERVICE_PROCESSING' && !change.granted) {
          throw Errors.unprocessable(
            'CONSENT_REQUIRED_FOR_SERVICE',
            'The centre needs to use your details to handle the services you request, so this cannot be switched off here. To stop all processing or have your data deleted, send a privacy request.',
          );
        }
        if (await this.apply(tx, customerId, { ...change, capturedVia })) applied.push(change.purpose);
      }
      if (applied.length) {
        await this.audit.log(
          { action: 'customer.consent_changed', resourceType: 'Customer', resourceId: customerId, summary: `Changed by the customer: ${applied.join(', ')}`, after: { changes: changes.filter((c) => applied.includes(c.purpose)), capturedVia } },
          tx,
        );
      }
      return { changed: applied, consents: await this.state(tx, customerId) };
    });
  }
}
