import { Injectable } from '@nestjs/common';
import { serviceSchema, type ServiceImportInput } from '@typease/validation';
import { AuditService } from '../../common/audit.service';
import { TenantDb } from '../../common/db/prisma.service';
import { AppError } from '../../common/errors';
import { parseTable, parseYesNo, pickColumn, toCsv } from '../../common/tabular';
import { CatalogueService } from './catalogue.service';

const POLICY: Record<string, string> = { before: 'BEFORE_PROCESSING', 'before processing': 'BEFORE_PROCESSING', after: 'AFTER_COMPLETION', 'after completion': 'AFTER_COMPLETION', deposit: 'DEPOSIT' };
const TAX: Record<string, string> = { 'service fee': 'SERVICE_FEE_ONLY', 'service fee only': 'SERVICE_FEE_ONLY', all: 'ALL_COMPONENTS', 'all components': 'ALL_COMPONENTS', none: 'NONE', 'no vat': 'NONE' };
const money = (v: string) => v.replace(/[,\s]|aed|درهم/gi, '');

/**
 * Bulk import of the service catalogue from a CSV or Excel file. Each row becomes a service with its default price,
 * through the same rules as the "Add service" form. The category is matched by key or name (English or Arabic).
 */
@Injectable()
export class ServicesImportService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly catalogue: CatalogueService,
  ) {}

  template() {
    return toCsv([
      ['Code', 'Name', 'Arabic name', 'Category', 'Service fee', 'Government fee', 'Third-party fee', 'Description', 'Processing hours', 'Requires approval', 'Online', 'Payment', 'Deposit %', 'VAT'],
      ['EID-RENEW', 'Emirates ID renewal', 'تجديد الهوية الإماراتية', 'typing', '70', '370', '0', 'Typing of the renewal application', '24', 'no', 'yes', 'before', '', 'service fee'],
    ]);
  }

  private async categories() {
    const rows = await this.catalogue.listCategories(true);
    const map = new Map<string, string>();
    for (const c of rows as Array<{ id: string; key: string; name: string; nameAr: string | null }>) {
      for (const k of [c.key, c.name, c.nameAr]) if (k) map.set(k.trim().toLowerCase(), c.id);
    }
    return map;
  }

  private map(values: Record<string, string>, categories: Map<string, string>) {
    const p = (aliases: string[]) => pickColumn(values, aliases);
    const category = p(['category', 'الفئة']);
    const hours = p(['processing hours', 'hours', 'estimated hours']);
    const policy = POLICY[p(['payment', 'payment policy']).toLowerCase()];
    const deposit = p(['deposit %', 'deposit', 'deposit percent']);
    const data: Record<string, unknown> = {
      code: p(['code', 'service code']),
      name: p(['name', 'service', 'service name']),
      nameAr: p(['arabic name', 'name arabic', 'الاسم']) || null,
      categoryId: categories.get(category.toLowerCase()) ?? (category ? `unknown:${category}` : ''),
      description: p(['description']) || null,
      descriptionAr: p(['arabic description', 'description arabic']) || null,
      ...(hours ? { estimatedProcessingHours: Number(hours) } : {}),
      ...(parseYesNo(p(['requires approval', 'approval'])) !== undefined ? { requiresApproval: parseYesNo(p(['requires approval', 'approval'])) } : {}),
      ...(parseYesNo(p(['online', 'online available'])) !== undefined ? { onlineAvailable: parseYesNo(p(['online', 'online available'])) } : {}),
      ...(policy ? { paymentPolicy: policy } : {}),
      ...(deposit ? { depositPercent: Number(deposit) } : {}),
      ...(TAX[p(['vat', 'tax', 'tax mode']).toLowerCase()] ? { taxMode: TAX[p(['vat', 'tax', 'tax mode']).toLowerCase()] } : {}),
      price: { serviceFee: money(p(['service fee', 'fee', 'price'])), governmentFeeEstimate: money(p(['government fee', 'gov fee'])) || '0', thirdPartyFeeEstimate: money(p(['third-party fee', 'third party fee', 'other charges'])) || '0' },
    };
    return data;
  }

  async preview(file: { originalname: string; buffer: Buffer; size: number } | undefined) {
    const table = await parseTable(file);
    const categories = await this.categories();
    const existing = await this.db.tx(async (tx) => new Set((await tx.service.findMany({ where: { tenantId: this.db.tenantId }, select: { code: true } })).map((s) => s.code.toUpperCase())));
    const seen = new Map<string, number>();
    const rows = table.rows.map((r) => {
      const data = this.map(r.values, categories);
      const errors: Array<{ field: string; message: string }> = [];
      if (typeof data.categoryId === 'string' && data.categoryId.startsWith('unknown:')) errors.push({ field: 'categoryId', message: `There is no category "${data.categoryId.slice(8)}". Use one of your categories, or add it first.` });
      if (!data.categoryId) errors.push({ field: 'categoryId', message: 'Enter the category.' });
      const parsed = serviceSchema.safeParse({ ...data, categoryId: errors.length ? '00000000-0000-0000-0000-000000000000' : data.categoryId });
      if (!parsed.success) for (const i of parsed.error.issues) errors.push({ field: i.path.join('.'), message: i.message });
      const code = String(data.code ?? '').trim().toUpperCase();
      let duplicate: { kind: 'FILE'; rowNo: number } | { kind: 'EXISTING'; code: string } | null = null;
      if (code && existing.has(code)) duplicate = { kind: 'EXISTING', code };
      else if (code && seen.has(code)) duplicate = { kind: 'FILE', rowNo: seen.get(code)! };
      if (code && !seen.has(code)) seen.set(code, r.rowNo);
      return { rowNo: r.rowNo, data, errors, duplicate };
    });
    return { rows, summary: { total: rows.length, valid: rows.filter((r) => !r.errors.length && !r.duplicate).length, invalid: rows.filter((r) => r.errors.length).length, duplicates: rows.filter((r) => !r.errors.length && r.duplicate).length } };
  }

  /** Creates each row on its own; an existing code is skipped, never overwritten. */
  async import(input: ServiceImportInput) {
    let created = 0;
    let skipped = 0;
    const failed: Array<{ rowNo: number; code: string; message: string }> = [];
    for (const row of input.rows) {
      const parsed = serviceSchema.safeParse(row.data);
      if (!parsed.success) {
        failed.push({ rowNo: row.rowNo, code: 'VALIDATION_FAILED', message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
        continue;
      }
      try {
        await this.catalogue.createService(parsed.data);
        created += 1;
      } catch (e) {
        if (e instanceof AppError && e.code === 'DUPLICATE_CODE') skipped += 1;
        else if (e instanceof AppError) failed.push({ rowNo: row.rowNo, code: e.code, message: e.message });
        else throw e;
      }
    }
    await this.db.tx((tx) => this.audit.log({ action: 'service.imported', resourceType: 'Tenant', resourceId: this.db.tenantId, summary: `Service import: ${created} created, ${skipped} existing codes skipped, ${failed.length} failed`, after: { created, skipped, failed: failed.length } }, tx));
    return { created, skipped, failed };
  }
}
