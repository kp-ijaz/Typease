import { Injectable } from '@nestjs/common';
import type { CorporateAgreementInput, CorporatePriceInput, UpdateCorporateAgreementInput } from '@typease/validation';
import { AuditService } from '../../common/audit.service';
import { TenantDb, Tx } from '../../common/db/prisma.service';
import { Errors, found } from '../../common/errors';
import { CorporateAccess } from './corporate-access.service';

const dateOnly = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const parseDate = (v: string) => new Date(`${v}T00:00:00.000Z`);
type AgreementRow = { id: string; corporateAccountId: string; title: string; terms: string | null; startsOn: Date; endsOn: Date | null; status: string; createdAt: Date; updatedAt: Date };
const agreementView = (a: AgreementRow) => ({ id: a.id, corporateAccountId: a.corporateAccountId, title: a.title, terms: a.terms, startsOn: dateOnly(a.startsOn), endsOn: dateOnly(a.endsOn), status: a.status, createdAt: a.createdAt, updatedAt: a.updatedAt });

/** Commercial terms with a company: service agreements and contract prices. */
@Injectable()
export class CorporateTermsService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly access: CorporateAccess,
  ) {}

  // ------------------------------------------------------------------ agreements
  listAgreements(accountId: string) {
    return this.db.tx(async (tx) => {
      await this.access.requireAccount(tx, accountId);
      const rows = await tx.corporateAgreement.findMany({ where: { tenantId: this.db.tenantId, corporateAccountId: accountId }, orderBy: [{ startsOn: 'desc' }, { createdAt: 'desc' }] });
      return rows.map(agreementView);
    });
  }

  createAgreement(accountId: string, input: CorporateAgreementInput) {
    return this.db.tx(async (tx) => {
      const account = await this.access.requireAccount(tx, accountId);
      this.access.assertNotArchived(account);
      const row = await tx.corporateAgreement.create({
        data: { tenantId: this.db.tenantId, corporateAccountId: accountId, title: input.title, terms: input.terms ?? null, startsOn: parseDate(input.startsOn), endsOn: input.endsOn ? parseDate(input.endsOn) : null, status: input.status },
      });
      await this.audit.log({ action: 'corporate.agreement_created', resourceType: 'CorporateAccount', resourceId: accountId, summary: `${account.accountNo}: agreement "${row.title}"`, after: { agreementId: row.id, title: row.title, startsOn: input.startsOn, endsOn: input.endsOn ?? null, status: row.status } }, tx);
      return agreementView(row);
    });
  }

  private async requireAgreement(tx: Tx, accountId: string, agreementId: string) {
    return found(await tx.corporateAgreement.findFirst({ where: { id: agreementId, corporateAccountId: accountId, tenantId: this.db.tenantId } }), 'Agreement');
  }

  updateAgreement(accountId: string, agreementId: string, input: UpdateCorporateAgreementInput) {
    return this.db.tx(async (tx) => {
      this.access.assertNotArchived(await this.access.requireAccount(tx, accountId));
      const before = await this.requireAgreement(tx, accountId, agreementId);
      const startsOn = input.startsOn ? parseDate(input.startsOn) : before.startsOn;
      const endsOn = input.endsOn === undefined ? before.endsOn : input.endsOn ? parseDate(input.endsOn) : null;
      if (endsOn && endsOn < startsOn) throw Errors.unprocessable('INVALID_DATES', 'The end date cannot be before the start date.');
      const after = await tx.corporateAgreement.update({ where: { id: agreementId }, data: { title: input.title, terms: input.terms, status: input.status, startsOn, endsOn } });
      await this.audit.log(
        { action: 'corporate.agreement_updated', resourceType: 'CorporateAccount', resourceId: accountId, before: { agreementId, title: before.title, startsOn: dateOnly(before.startsOn), endsOn: dateOnly(before.endsOn), status: before.status }, after: { agreementId, title: after.title, startsOn: dateOnly(after.startsOn), endsOn: dateOnly(after.endsOn), status: after.status, termsChanged: after.terms !== before.terms } },
        tx,
      );
      return agreementView(after);
    });
  }

  deleteAgreement(accountId: string, agreementId: string) {
    return this.db.tx(async (tx) => {
      this.access.assertNotArchived(await this.access.requireAccount(tx, accountId));
      const before = await this.requireAgreement(tx, accountId, agreementId);
      await tx.corporateAgreement.delete({ where: { id: agreementId } });
      await this.audit.log({ action: 'corporate.agreement_deleted', resourceType: 'CorporateAccount', resourceId: accountId, before: { agreementId, title: before.title, startsOn: dateOnly(before.startsOn), endsOn: dateOnly(before.endsOn), status: before.status } }, tx);
      return { status: 'DELETED' as const };
    });
  }

  // ------------------------------------------------------------------ contract prices
  /** Contract prices next to the catalogue fee they replace. */
  private async prices(tx: Tx, accountId: string, forPortal: boolean) {
    const tenantId = this.db.tenantId;
    const rows = await tx.corporatePrice.findMany({
      where: { tenantId, corporateAccountId: accountId, service: { deletedAt: null } },
      include: { service: { select: { id: true, code: true, name: true, nameAr: true, isActive: true, servicePrices: { where: { isActive: true, branchId: null }, orderBy: { validFrom: 'desc' }, take: 1, select: { serviceFee: true, currency: true } } } } },
      orderBy: { service: { name: 'asc' } },
    });
    return rows.map((r) => {
      const list = r.service.servicePrices[0];
      return {
        id: r.id,
        serviceId: r.serviceId,
        serviceName: r.service.name,
        serviceNameAr: r.service.nameAr,
        ...(forPortal ? {} : { serviceCode: r.service.code, serviceActive: r.service.isActive, createdAt: r.createdAt }),
        contractServiceFee: r.serviceFee.toFixed(2),
        catalogueServiceFee: list ? list.serviceFee.toFixed(2) : null,
        currency: list?.currency ?? null,
      };
    });
  }

  listPrices(accountId: string) {
    return this.db.tx(async (tx) => {
      await this.access.requireAccount(tx, accountId);
      return this.prices(tx, accountId, false);
    });
  }
  /** GET /corporate/prices - the company's own contract prices only. */
  ownPrices() {
    return this.db.tx(async (tx) => this.prices(tx, (await this.access.ownAccount(tx)).id, true));
  }

  /** One contract price per company and service: setting it again replaces the fee. */
  setPrice(accountId: string, input: CorporatePriceInput) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const account = await this.access.requireAccount(tx, accountId);
      this.access.assertNotArchived(account);
      const service = found(await tx.service.findFirst({ where: { id: input.serviceId, tenantId, deletedAt: null }, select: { id: true, code: true, name: true } }), 'Service');
      const before = await tx.corporatePrice.findFirst({ where: { tenantId, corporateAccountId: accountId, serviceId: service.id } });
      const row = before
        ? await tx.corporatePrice.update({ where: { id: before.id }, data: { serviceFee: input.serviceFee } })
        : await tx.corporatePrice.create({ data: { tenantId, corporateAccountId: accountId, serviceId: service.id, serviceFee: input.serviceFee } });
      await this.audit.log(
        { action: 'corporate.price_set', resourceType: 'CorporateAccount', resourceId: accountId, summary: `${account.accountNo}: ${service.code} contract fee ${row.serviceFee.toFixed(2)}`, before: before ? { serviceId: service.id, serviceFee: before.serviceFee.toFixed(2) } : null, after: { priceId: row.id, serviceId: service.id, serviceFee: row.serviceFee.toFixed(2) } },
        tx,
      );
      return (await this.prices(tx, accountId, false)).find((p) => p.id === row.id)!;
    });
  }

  removePrice(accountId: string, priceId: string) {
    return this.db.tx(async (tx) => {
      const account = await this.access.requireAccount(tx, accountId);
      this.access.assertNotArchived(account);
      const price = found(await tx.corporatePrice.findFirst({ where: { id: priceId, corporateAccountId: accountId, tenantId: this.db.tenantId } }), 'Contract price');
      await tx.corporatePrice.delete({ where: { id: priceId } });
      await this.audit.log({ action: 'corporate.price_removed', resourceType: 'CorporateAccount', resourceId: accountId, summary: `${account.accountNo}: contract price removed`, before: { priceId, serviceId: price.serviceId, serviceFee: price.serviceFee.toFixed(2) } }, tx);
      return { status: 'DELETED' as const };
    });
  }
}
