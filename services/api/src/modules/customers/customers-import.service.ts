import { Injectable } from '@nestjs/common';
import { customerSchema, type CustomerImportInput } from '@typease/validation';
import { AuditService } from '../../common/audit.service';
import { TenantDb } from '../../common/db/prisma.service';
import { AppError } from '../../common/errors';
import { normaliseDate, normalisePhone, parseTable, pickColumn, toCsv } from '../../common/tabular';
import { CustomersService } from './customers.service';
import { DuplicatesService } from './duplicates.service';

/** Column -> customer field, with the header names people actually use (English and Arabic). */
const COLUMNS: Array<{ field: string; aliases: string[]; kind?: 'phone' | 'date' | 'upper' | 'lower' }> = [
  { field: 'fullName', aliases: ['full name', 'name', 'customer name', 'customer', 'الاسم'] },
  { field: 'fullNameAr', aliases: ['full name arabic', 'arabic name', 'name arabic', 'name (arabic)', 'الاسم بالعربي', 'الاسم بالعربية'] },
  { field: 'type', aliases: ['type', 'customer type'], kind: 'upper' },
  { field: 'phone', aliases: ['phone', 'mobile', 'mobile number', 'whatsapp', 'phone number', 'الهاتف', 'الجوال'], kind: 'phone' },
  { field: 'email', aliases: ['email', 'e-mail', 'email address', 'البريد'], kind: 'lower' },
  { field: 'nationality', aliases: ['nationality', 'country', 'الجنسية'], kind: 'upper' },
  { field: 'dateOfBirth', aliases: ['date of birth', 'dob', 'birth date', 'تاريخ الميلاد'], kind: 'date' },
  { field: 'emiratesId', aliases: ['emirates id', 'eid', 'emirates id number', 'الهوية'] },
  { field: 'emiratesIdExpiry', aliases: ['emirates id expiry', 'eid expiry'], kind: 'date' },
  { field: 'passportNo', aliases: ['passport', 'passport no', 'passport number', 'الجواز'] },
  { field: 'passportExpiry', aliases: ['passport expiry'], kind: 'date' },
  { field: 'taxRegistrationNo', aliases: ['trn', 'tax registration number', 'vat number'] },
  { field: 'preferredLanguage', aliases: ['language', 'preferred language'], kind: 'lower' },
];

/**
 * Bulk import of customers from a CSV or Excel file: preview first (every row checked with the same rules as the
 * form, possible duplicates shown), then import the accepted rows. Each row is created through the normal
 * registration, so identity numbers are encrypted and the duplicate rules apply.
 */
@Injectable()
export class CustomersImportService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly customers: CustomersService,
    private readonly duplicates: DuplicatesService,
  ) {}

  template() {
    return toCsv([
      ['Full name', 'Arabic name', 'Type', 'Mobile', 'Email', 'Nationality', 'Date of birth', 'Emirates ID', 'Emirates ID expiry', 'Passport', 'Passport expiry', 'TRN', 'Language'],
      ['Fatima Al Mansoori', 'فاطمة المنصوري', 'INDIVIDUAL', '0501234567', 'fatima@example.com', 'AE', '1990-04-12', '784-1990-1234567-1', '2027-05-01', 'N1234567', '2030-01-31', '', 'ar'],
    ]);
  }

  private map(values: Record<string, string>) {
    const data: Record<string, unknown> = {};
    for (const c of COLUMNS) {
      let v = pickColumn(values, c.aliases);
      if (!v) continue;
      if (c.kind === 'phone') v = normalisePhone(v);
      if (c.kind === 'date') v = normaliseDate(v);
      if (c.kind === 'upper') v = v.toUpperCase();
      if (c.kind === 'lower') v = v.toLowerCase();
      data[c.field] = v;
    }
    if (data.type === 'COMPANY') data.type = 'BUSINESS';
    return data;
  }

  async preview(file: { originalname: string; buffer: Buffer; size: number } | undefined) {
    const table = await parseTable(file);
    const known = new Set(COLUMNS.flatMap((c) => c.aliases.map((a) => a.toLowerCase().replace(/[^a-z0-9؀-ۿ]/g, ''))));
    const ignored = table.headers.filter((h) => h && !known.has(h));
    const seen = new Map<string, number>();
    const rows = await this.db.tx(async (tx) => {
      const out = [];
      for (const r of table.rows) {
        const data = this.map(r.values);
        const parsed = customerSchema.safeParse(data);
        const errors = parsed.success ? [] : parsed.error.issues.map((i) => ({ field: String(i.path[0] ?? ''), message: i.message }));
        let duplicate: { kind: 'FILE'; rowNo: number } | { kind: 'EXISTING'; customerId: string; customerNo: string; fullName: string } | null = null;
        if (parsed.success) {
          for (const k of ['phone', 'email', 'emiratesId', 'passportNo'] as const) {
            const v = parsed.data[k];
            if (!v) continue;
            const first = seen.get(`${k}:${v}`);
            if (first) {
              duplicate = { kind: 'FILE', rowNo: first };
              break;
            }
            seen.set(`${k}:${v}`, r.rowNo);
          }
          if (!duplicate) {
            const strong = (await this.duplicates.find(tx, { fullName: parsed.data.fullName, email: parsed.data.email, phone: parsed.data.phone, emiratesId: parsed.data.emiratesId, passportNo: parsed.data.passportNo })).find((d) => d.strength === 'STRONG');
            if (strong) duplicate = { kind: 'EXISTING', customerId: strong.customer.id, customerNo: strong.customer.customerNo, fullName: strong.customer.fullName };
          }
        }
        out.push({ rowNo: r.rowNo, data, errors, duplicate });
      }
      return out;
    });
    return {
      rows,
      ignoredColumns: ignored,
      summary: { total: rows.length, valid: rows.filter((r) => !r.errors.length && !r.duplicate).length, invalid: rows.filter((r) => r.errors.length).length, duplicates: rows.filter((r) => !r.errors.length && r.duplicate).length },
    };
  }

  /** Creates each accepted row on its own: one bad row never undoes the others. */
  async import(input: CustomerImportInput) {
    let created = 0;
    let skipped = 0;
    const failed: Array<{ rowNo: number; code: string; message: string }> = [];
    for (const row of input.rows) {
      const parsed = customerSchema.safeParse({ ...row.data, confirmNotDuplicate: !input.skipDuplicates });
      if (!parsed.success) {
        failed.push({ rowNo: row.rowNo, code: 'VALIDATION_FAILED', message: parsed.error.issues.map((i) => `${String(i.path[0] ?? '')}: ${i.message}`).join('; ') });
        continue;
      }
      try {
        await this.customers.create(parsed.data, { source: 'IMPORT' });
        created += 1;
      } catch (e) {
        if (e instanceof AppError && e.code === 'POSSIBLE_DUPLICATE') skipped += 1;
        else if (e instanceof AppError) failed.push({ rowNo: row.rowNo, code: e.code, message: e.message });
        else throw e;
      }
    }
    await this.db.tx((tx) => this.audit.log({ action: 'customer.imported', resourceType: 'Tenant', resourceId: this.db.tenantId, summary: `Customer import: ${created} created, ${skipped} duplicates skipped, ${failed.length} failed`, after: { created, skipped, failed: failed.length } }, tx));
    return { created, skipped, failed };
  }
}
