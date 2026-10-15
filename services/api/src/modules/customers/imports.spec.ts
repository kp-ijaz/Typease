import ExcelJS from 'exceljs';
import { Actor, TenantFixture, TestApp } from '../../../test/helpers';

const csv = (rows: string[][]) => Buffer.from(rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n'));

describe('Bulk import: customers and services', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let receptionist: Actor;
  let operator: Actor;

  beforeAll(async () => {
    t = await TestApp.create();
    alpha = await t.createTenant({ name: 'Alpha Typing' });
    beta = await t.createTenant({ name: 'Beta Typing' });
    receptionist = await t.addStaff(alpha, 'receptionist');
    operator = await t.addStaff(alpha, 'operator');
    await t.as(alpha.owner).post('/customers', { fullName: 'Existing Person', phone: '+971509990000' }).expect(201);
  });
  afterAll(() => t.close());

  describe('customers', () => {
    let preview: any;
    it('offers a template and previews every row without saving anything', async () => {
      const template = await t.as(receptionist).get('/customers/import/template').expect(200);
      expect(template.headers['content-type']).toContain('text/csv');
      expect(template.text).toContain('Full name');
      const file = csv([
        ['Full Name', 'Arabic name', 'Mobile', 'E-mail', 'Nationality', 'DOB', 'Passport', 'Favourite colour'],
        ['Fatima Al Mansoori', 'فاطمة المنصوري', '050 123 4567', 'Fatima@Example.com', 'ae', '12/04/1990', 'N1234567', 'blue'],
        ['', '', '0501112222', '', '', '', '', ''],
        ['Rahul Menon', '', '+971 55 111 2222', 'not-an-email', 'IN', '', '', ''],
        ['Same Phone', '', '0501234567', '', '', '', '', ''],
        ['Existing Again', '', '0509990000', '', '', '', '', ''],
      ]);
      await t.as(operator).upload('/customers/import/preview', 'file', file, 'customers.csv').expect(403);
      preview = (await t.as(receptionist).upload('/customers/import/preview', 'file', file, 'customers.csv').expect(200)).body;
      expect(preview.summary).toEqual({ total: 5, valid: 1, invalid: 2, duplicates: 2 });
      expect(preview.ignoredColumns).toEqual(['favouritecolour']);
      expect(preview.rows[0]).toMatchObject({ rowNo: 2, errors: [], duplicate: null, data: { fullName: 'Fatima Al Mansoori', fullNameAr: 'فاطمة المنصوري', phone: '+971501234567', email: 'fatima@example.com', nationality: 'AE', dateOfBirth: '1990-04-12', passportNo: 'N1234567' } });
      expect(preview.rows[1].errors.map((e: { field: string }) => e.field)).toContain('fullName');
      expect(preview.rows[2].errors.map((e: { field: string }) => e.field)).toContain('email');
      expect(preview.rows[3].duplicate).toEqual({ kind: 'FILE', rowNo: 2 });
      expect(preview.rows[4].duplicate).toMatchObject({ kind: 'EXISTING', fullName: 'Existing Person' });
      expect(await t.sys.customer.count({ where: { tenantId: alpha.id } })).toBe(1);
    });

    it('imports the accepted rows, skips duplicates, and reports the rest', async () => {
      const res = await t.as(receptionist).post('/customers/import', { rows: preview.rows.map((r: any) => ({ rowNo: r.rowNo, data: r.data })), skipDuplicates: true }).expect(201);
      // Fatima is created; "Same Phone" now matches her and is skipped like the existing person; two rows are invalid.
      expect(res.body).toMatchObject({ created: 1, skipped: 2 });
      expect(res.body.failed.map((f: { rowNo: number }) => f.rowNo)).toEqual([3, 4]);
      const fatima = await t.sys.customer.findFirstOrThrow({ where: { tenantId: alpha.id, fullName: 'Fatima Al Mansoori' } });
      expect(fatima).toMatchObject({ phone: '+971501234567', passportNoLast4: '4567' });
      expect(fatima.passportNoEnc).not.toContain('N1234567');
      expect(await t.sys.customer.count({ where: { tenantId: beta.id } })).toBe(0);
    });

    it('reads Excel files too, and refuses what is not a table', async () => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Customers');
      ws.addRow(['Name', 'Mobile', 'Date of birth']);
      ws.addRow(['Omar Haddad', '0552223333', new Date(Date.UTC(1985, 6, 9))]);
      const xlsx = Buffer.from(await wb.xlsx.writeBuffer());
      const body = (await t.as(receptionist).upload('/customers/import/preview', 'file', xlsx, 'customers.xlsx').expect(200)).body;
      expect(body.rows[0].data).toEqual({ fullName: 'Omar Haddad', phone: '+971552223333', dateOfBirth: '1985-07-09' });
      expect((await t.as(receptionist).upload('/customers/import/preview', 'file', Buffer.from('name\n'), 'x.csv')).body.code).toBe('FILE_EMPTY');
      await t.as(receptionist).post('/customers/import/preview').expect(400);
    });
  });

  describe('services', () => {
    it('previews and imports the catalogue with prices, matching categories by name', async () => {
      const category = await t.sys.serviceCategory.findFirstOrThrow({ where: { tenantId: alpha.id } });
      const file = csv([
        ['Code', 'Name', 'Arabic name', 'Category', 'Service fee', 'Government fee', 'Online', 'Payment'],
        ['eid-renew', 'Emirates ID renewal', 'تجديد الهوية', category.name.toUpperCase(), 'AED 70', '370', 'yes', 'after'],
        ['VISA-NEW', 'New visa typing', '', 'No such category', '150', '', '', ''],
        ['EID-RENEW', 'Same code again', '', category.key, '80', '', '', ''],
        ['FREE', 'No fee given', '', category.key, '', '', '', ''],
      ]);
      await t.as(receptionist).upload('/services/import/preview', 'file', file, 'services.csv').expect(403);
      const preview = (await t.as(alpha.owner).upload('/services/import/preview', 'file', file, 'services.csv').expect(200)).body;
      expect(preview.summary).toEqual({ total: 4, valid: 1, invalid: 2, duplicates: 1 });
      expect(preview.rows[0].data).toMatchObject({ code: 'eid-renew', categoryId: category.id, onlineAvailable: true, paymentPolicy: 'AFTER_COMPLETION', price: { serviceFee: '70', governmentFeeEstimate: '370', thirdPartyFeeEstimate: '0' } });
      expect(preview.rows[1].errors[0].message).toContain('No such category');
      const res = await t.as(alpha.owner).post('/services/import', { rows: [preview.rows[0], preview.rows[2]].map((r: any) => ({ rowNo: r.rowNo, data: r.data })) }).expect(201);
      expect(res.body).toEqual({ created: 1, skipped: 1, failed: [] });
      const svc = await t.sys.service.findFirstOrThrow({ where: { tenantId: alpha.id, code: 'EID-RENEW' }, include: { servicePrices: true } });
      expect(svc).toMatchObject({ name: 'Emirates ID renewal', nameAr: 'تجديد الهوية', paymentPolicy: 'AFTER_COMPLETION' });
      expect(svc.servicePrices[0]!.governmentFeeEstimate.toFixed(2)).toBe('370.00');
    });
  });
});
