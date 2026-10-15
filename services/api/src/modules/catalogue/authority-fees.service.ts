import { Injectable, OnModuleInit } from '@nestjs/common';
import type { AuthorityFeeInput, AuthorityFeeQuery, ImportAuthorityFeeInput, UpdateAuthorityFeeInput } from '@typease/validation';
import { serviceSchema } from '@typease/validation';
import { AuditService } from '../../common/audit.service';
import { ctx } from '../../common/context';
import { Prisma, SystemDb, TenantDb } from '../../common/db/prisma.service';
import { Errors, found } from '../../common/errors';
import { ProvisioningService } from '../tenancy/provisioning.service';
import { CatalogueService } from './catalogue.service';
import { PricingService } from './pricing.service';

const SAMPLE_NOTE = 'Sample amount entered by TypEase for illustration. Verify it with the authority before you rely on it.';
/**
 * Starting entries, clearly marked as samples: TypEase replaces them with verified amounts in the console.
 * They are illustrative figures, not official fees.
 */
const SAMPLES: Array<Pick<AuthorityFeeInput, 'authority' | 'code' | 'name' | 'nameAr' | 'category'> & { governmentFee: string; thirdPartyFee: string }> = [
  { authority: 'AMER', code: 'AMER-RES-NEW', name: 'Residence visa - new (inside UAE)', nameAr: 'إقامة جديدة (داخل الدولة)', category: 'Residence', governmentFee: '650.00', thirdPartyFee: '70.00' },
  { authority: 'AMER', code: 'AMER-RES-RENEW', name: 'Residence visa - renewal', nameAr: 'تجديد الإقامة', category: 'Residence', governmentFee: '500.00', thirdPartyFee: '70.00' },
  { authority: 'AMER', code: 'AMER-RES-CANCEL', name: 'Residence visa - cancellation', nameAr: 'إلغاء الإقامة', category: 'Residence', governmentFee: '150.00', thirdPartyFee: '50.00' },
  { authority: 'AMER', code: 'AMER-ENTRY-30', name: 'Visit visa - 30 days', nameAr: 'تأشيرة زيارة 30 يوماً', category: 'Entry permits', governmentFee: '350.00', thirdPartyFee: '50.00' },
  { authority: 'AMER', code: 'AMER-STATUS-CHANGE', name: 'Change of status (inside UAE)', nameAr: 'تعديل الوضع (داخل الدولة)', category: 'Entry permits', governmentFee: '650.00', thirdPartyFee: '70.00' },
  { authority: 'ICP', code: 'ICP-EID-NEW', name: 'Emirates ID - new (1 year)', nameAr: 'هوية إماراتية جديدة (سنة)', category: 'Emirates ID', governmentFee: '270.00', thirdPartyFee: '70.00' },
  { authority: 'ICP', code: 'ICP-EID-RENEW-2Y', name: 'Emirates ID - renewal (2 years)', nameAr: 'تجديد الهوية الإماراتية (سنتان)', category: 'Emirates ID', governmentFee: '370.00', thirdPartyFee: '70.00' },
  { authority: 'ICP', code: 'ICP-EID-REPLACE', name: 'Emirates ID - replacement (lost or damaged)', nameAr: 'بدل فاقد أو تالف للهوية', category: 'Emirates ID', governmentFee: '300.00', thirdPartyFee: '70.00' },
  { authority: 'TASHEEL', code: 'TAS-WP-NEW', name: 'Work permit - new', nameAr: 'تصريح عمل جديد', category: 'Work permits', governmentFee: '300.00', thirdPartyFee: '53.00' },
  { authority: 'TASHEEL', code: 'TAS-WP-RENEW', name: 'Work permit - renewal', nameAr: 'تجديد تصريح العمل', category: 'Work permits', governmentFee: '300.00', thirdPartyFee: '53.00' },
  { authority: 'TASHEEL', code: 'TAS-CONTRACT', name: 'Employment contract - typing and submission', nameAr: 'طباعة وتقديم عقد العمل', category: 'Contracts', governmentFee: '0.00', thirdPartyFee: '53.00' },
  { authority: 'MOHRE', code: 'MOHRE-WP-CANCEL', name: 'Work permit - cancellation', nameAr: 'إلغاء تصريح العمل', category: 'Work permits', governmentFee: '0.00', thirdPartyFee: '53.00' },
  { authority: 'MOHRE', code: 'MOHRE-OFFER', name: 'Job offer letter', nameAr: 'عرض العمل', category: 'Contracts', governmentFee: '0.00', thirdPartyFee: '53.00' },
  { authority: 'DHA', code: 'DHA-MED-STD', name: 'Medical fitness test - standard', nameAr: 'فحص اللياقة الطبية - عادي', category: 'Medical', governmentFee: '320.00', thirdPartyFee: '0.00' },
  { authority: 'DED', code: 'DED-TL-RENEW', name: 'Trade licence - renewal (typing fee only)', nameAr: 'تجديد الرخصة التجارية (رسوم الطباعة)', category: 'Trade licence', governmentFee: '0.00', thirdPartyFee: '50.00' },
  { authority: 'MOFA', code: 'MOFA-ATTEST', name: 'Document attestation (per document)', nameAr: 'تصديق المستندات (لكل مستند)', category: 'Attestation', governmentFee: '150.00', thirdPartyFee: '0.00' },
];

const money = (v: Prisma.Decimal | string | number) => new Prisma.Decimal(v).toFixed(2);
const present = (f: Prisma.AuthorityFeeGetPayload<object>) => ({
  id: f.id,
  authority: f.authority,
  code: f.code,
  name: f.name,
  nameAr: f.nameAr,
  category: f.category,
  governmentFee: money(f.governmentFee),
  thirdPartyFee: money(f.thirdPartyFee),
  notes: f.notes,
  sourceUrl: f.sourceUrl,
  verifiedAt: f.verifiedAt ? f.verifiedAt.toISOString().slice(0, 10) : null,
  isSample: f.isSample,
  isActive: f.isActive,
  version: f.version,
  updatedAt: f.updatedAt,
});
const where = (q: AuthorityFeeQuery): Prisma.AuthorityFeeWhereInput => ({
  ...(q.includeInactive ? {} : { isActive: true }),
  ...(q.authority ? { authority: q.authority } : {}),
  ...(q.q ? { OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { nameAr: { contains: q.q } }, { code: { contains: q.q.toUpperCase() } }, { category: { contains: q.q, mode: 'insensitive' } }] } : {}),
});

/**
 * Authority fee catalogue maintained by TypEase. Platform staff keep the amounts current; each change raises the
 * entry's version and is kept in its history. A centre links its services to entries and sees an update whenever
 * a linked entry is newer than what it applied - it decides when the new amounts go into its prices.
 */
@Injectable()
export class AuthorityFeesService implements OnModuleInit {
  constructor(
    private readonly db: TenantDb,
    private readonly sys: SystemDb,
    private readonly audit: AuditService,
    private readonly provisioning: ProvisioningService,
    private readonly catalogue: CatalogueService,
    private readonly pricing: PricingService,
  ) {}

  onModuleInit() {
    this.provisioning.registerGlobalStep('catalogue.authority_fees', async (tx) => {
      if ((await tx.authorityFee.count()) > 0) return;
      await tx.authorityFee.createMany({ data: SAMPLES.map((s) => ({ ...s, notes: SAMPLE_NOTE, isSample: true })) });
    });
  }

  // ------------------------------------------------------------------ platform staff
  async platformList(query: AuthorityFeeQuery) {
    const rows = await this.sys.client.authorityFee.findMany({ where: where({ ...query, includeInactive: query.includeInactive ?? true }), orderBy: [{ authority: 'asc' }, { code: 'asc' }] });
    const linked = await this.sys.client.service.groupBy({ by: ['authorityFeeId'], where: { authorityFeeId: { in: rows.map((r) => r.id) }, deletedAt: null }, _count: { _all: true } });
    const counts = new Map(linked.map((l) => [l.authorityFeeId, l._count._all]));
    return rows.map((r) => ({ ...present(r), linkedServices: counts.get(r.id) ?? 0 }));
  }

  async create(input: AuthorityFeeInput) {
    return this.sys.tx(async (tx) => {
      if (await tx.authorityFee.findUnique({ where: { code: input.code } })) throw Errors.conflict('CODE_TAKEN', `An entry with code ${input.code} already exists.`);
      const fee = await tx.authorityFee.create({ data: { ...input, verifiedAt: input.verifiedAt ? new Date(`${input.verifiedAt}T00:00:00.000Z`) : null, updatedById: ctx().userId ?? null } });
      await this.audit.logSystem({ action: 'platform.authority_fee_created', resourceType: 'AuthorityFee', resourceId: fee.id, summary: `${fee.code} ${fee.name}: ${money(fee.governmentFee)} + ${money(fee.thirdPartyFee)}`, after: present(fee) });
      return present(fee);
    });
  }

  async update(id: string, input: UpdateAuthorityFeeInput) {
    return this.sys.tx(async (tx) => {
      const before = found(await tx.authorityFee.findUnique({ where: { id } }), 'Entry');
      if (before.version !== input.version) throw Errors.conflict('STALE_VERSION', 'Someone changed this entry in the meantime. Reload it and try again.');
      const { version: _v, changeNote, verifiedAt, ...fields } = input;
      const gov = fields.governmentFee !== undefined ? new Prisma.Decimal(fields.governmentFee) : before.governmentFee;
      const third = fields.thirdPartyFee !== undefined ? new Prisma.Decimal(fields.thirdPartyFee) : before.thirdPartyFee;
      // Only a change of the amounts is a new version: centres are asked to update their prices for those alone.
      const amountsChanged = !gov.equals(before.governmentFee) || !third.equals(before.thirdPartyFee);
      const fee = await tx.authorityFee.update({
        where: { id },
        data: {
          ...fields,
          ...(verifiedAt !== undefined ? { verifiedAt: verifiedAt ? new Date(`${verifiedAt}T00:00:00.000Z`) : null } : {}),
          ...(amountsChanged ? { version: { increment: 1 } } : {}),
          updatedById: ctx().userId ?? null,
        },
      });
      if (amountsChanged) {
        await tx.authorityFeeChange.create({
          data: { feeId: id, version: fee.version, governmentFeeBefore: before.governmentFee, governmentFeeAfter: gov, thirdPartyFeeBefore: before.thirdPartyFee, thirdPartyFeeAfter: third, note: changeNote ?? null, changedById: ctx().userId ?? null },
        });
      }
      await this.audit.logSystem({ action: 'platform.authority_fee_updated', resourceType: 'AuthorityFee', resourceId: id, summary: `${fee.code}${amountsChanged ? `: ${money(before.governmentFee)} + ${money(before.thirdPartyFee)} -> ${money(gov)} + ${money(third)}` : ' updated'}`, before: present(before), after: present(fee) });
      return present(fee);
    });
  }

  async history(id: string) {
    const rows = await this.sys.client.authorityFeeChange.findMany({ where: { feeId: id }, orderBy: { version: 'desc' } });
    return rows.map((r) => ({ version: r.version, governmentFeeBefore: money(r.governmentFeeBefore), governmentFeeAfter: money(r.governmentFeeAfter), thirdPartyFeeBefore: money(r.thirdPartyFeeBefore), thirdPartyFeeAfter: money(r.thirdPartyFeeAfter), note: r.note, createdAt: r.createdAt }));
  }

  // ------------------------------------------------------------------ centres
  /** The catalogue, with this centre's services that follow each entry. */
  async browse(query: AuthorityFeeQuery) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const rows = await tx.authorityFee.findMany({ where: where(query), orderBy: [{ authority: 'asc' }, { code: 'asc' }] });
      const mine = await tx.service.findMany({ where: { tenantId, deletedAt: null, authorityFeeId: { in: rows.map((r) => r.id) } }, select: { id: true, code: true, name: true, nameAr: true, authorityFeeId: true, authorityFeeVersion: true } });
      return rows.map((r) => ({
        ...present(r),
        services: mine.filter((s) => s.authorityFeeId === r.id).map((s) => ({ id: s.id, code: s.code, name: s.name, nameAr: s.nameAr, upToDate: s.authorityFeeVersion === r.version })),
      }));
    });
  }

  /** Adds an entry to the centre's catalogue as a new service: the centre's fee, the catalogue's pass-through amounts. */
  async importFee(feeId: string, input: ImportAuthorityFeeInput) {
    return this.db.tx(async (tx) => {
      const fee = found(await tx.authorityFee.findFirst({ where: { id: feeId, isActive: true } }), 'Entry');
      const service = await this.catalogue.createService(
        serviceSchema.parse({
          categoryId: input.categoryId,
          code: input.code,
          name: input.name ?? fee.name,
          nameAr: input.nameAr ?? fee.nameAr,
          description: fee.isSample ? null : (fee.notes ?? null),
          price: { serviceFee: input.serviceFee, governmentFeeEstimate: money(fee.governmentFee), thirdPartyFeeEstimate: money(fee.thirdPartyFee) },
        }),
      );
      await tx.service.update({ where: { id: service.id }, data: { authorityFeeId: fee.id, authorityFeeVersion: fee.version } });
      await this.audit.log({ action: 'service.authority_fee_imported', resourceType: 'Service', resourceId: service.id, summary: `${service.code} created from the TypEase fee catalogue (${fee.code})`, after: { authorityFeeId: fee.id, version: fee.version } }, tx);
      return { ...service, authorityFeeId: fee.id, authorityFeeVersion: fee.version };
    });
  }

  /** Makes an existing service follow an entry (or stop following). Its prices change only when an update is applied. */
  async link(serviceId: string, feeId: string | null) {
    return this.db.tx(async (tx) => {
      const service = await this.catalogue.requireService(tx, serviceId);
      if (feeId) found(await tx.authorityFee.findFirst({ where: { id: feeId, isActive: true }, select: { id: true } }), 'Entry');
      await tx.service.update({ where: { id: serviceId }, data: { authorityFeeId: feeId, authorityFeeVersion: null } });
      await this.audit.log({ action: feeId ? 'service.authority_fee_linked' : 'service.authority_fee_unlinked', resourceType: 'Service', resourceId: serviceId, before: { authorityFeeId: service.authorityFeeId }, after: { authorityFeeId: feeId } }, tx);
      return { serviceId, authorityFeeId: feeId };
    });
  }

  /** Services whose price does not carry the current catalogue amounts yet, with what would change. */
  async updates() {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const services = await tx.service.findMany({ where: { tenantId, deletedAt: null, authorityFeeId: { not: null } }, include: { authorityFee: true, servicePrices: { where: { isActive: true, branchId: null }, take: 1 } } });
      return services
        .filter((s) => s.authorityFee && s.authorityFee.isActive && s.authorityFeeVersion !== s.authorityFee.version)
        .map((s) => {
          const f = s.authorityFee!;
          const price = s.servicePrices[0];
          return {
            serviceId: s.id,
            code: s.code,
            name: s.name,
            nameAr: s.nameAr,
            fee: { id: f.id, code: f.code, authority: f.authority, name: f.name, nameAr: f.nameAr, version: f.version, isSample: f.isSample, verifiedAt: f.verifiedAt ? f.verifiedAt.toISOString().slice(0, 10) : null },
            current: price ? { serviceFee: money(price.serviceFee), governmentFee: money(price.governmentFeeEstimate), thirdPartyFee: money(price.thirdPartyFeeEstimate) } : null,
            proposed: { governmentFee: money(f.governmentFee), thirdPartyFee: money(f.thirdPartyFee) },
          };
        });
    });
  }

  /**
   * Puts the catalogue's current amounts into the prices of the chosen services: every active price (default and
   * branch) gets a new row with the same service fee and the new pass-through amounts, so the price history shows
   * the change.
   */
  async apply(serviceIds: string[]) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const services = await tx.service.findMany({ where: { tenantId, id: { in: serviceIds }, deletedAt: null, authorityFeeId: { not: null } }, include: { authorityFee: true } });
      if (services.length !== new Set(serviceIds).size) throw Errors.notFound('Service');
      let prices = 0;
      for (const s of services) {
        const f = s.authorityFee!;
        const active = await tx.servicePrice.findMany({ where: { tenantId, serviceId: s.id, isActive: true }, orderBy: { branchId: { sort: 'asc', nulls: 'first' } } });
        for (const p of active) {
          await this.pricing.setPrice(s.id, { branchId: p.branchId, serviceFee: money(p.serviceFee), governmentFeeEstimate: money(f.governmentFee), thirdPartyFeeEstimate: money(f.thirdPartyFee) });
          prices += 1;
        }
        await tx.service.update({ where: { id: s.id }, data: { authorityFeeVersion: f.version } });
      }
      return { services: services.length, prices };
    });
  }
}
