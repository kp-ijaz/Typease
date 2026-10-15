import { crc32, deflateSync } from 'node:zlib';
import { Actor, TenantFixture, TestApp } from '../../../test/helpers';
import { PaperworkService } from './paperwork.service';

/** A real (tiny) PNG: a dark stroke on white, like a drawn signature. */
function signaturePng(): string {
  const w = 120;
  const h = 40;
  const rows: Buffer[] = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3, 255);
    row[0] = 0;
    for (let x = 0; x < w; x++) if (Math.abs(y - 20 - Math.round(10 * Math.sin(x / 8))) < 2) row.fill(20, 1 + x * 3, 4 + x * 3);
    rows.push(row);
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

describe('Ready-made documents', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let manager: Actor;
  let receptionist: Actor;
  let accountant: Actor;
  let customerId: string;
  let templateId: string;
  let documentId: string;
  const values = { employerName: 'Falcon Logistics LLC', designation: 'Accountant', joiningDate: '2023-03-01', monthlySalary: '12500', addressedTo: 'Emirates NBD', purpose: 'opening a bank account' };
  const tokenOf = async (id: string) => {
    const n = await t.sys.notification.findFirstOrThrow({ where: { relatedId: id, eventKey: 'paperwork.sign', channel: { in: ['EMAIL', 'SMS', 'WHATSAPP'] } } });
    return new URL(n.body.match(/https?:\/\/\S+/)![0].replace(/[).,]+$/, '')).searchParams.get('t')!;
  };

  beforeAll(async () => {
    t = await TestApp.create();
    alpha = await t.createTenant({ name: 'Alpha Typing' });
    beta = await t.createTenant({ name: 'Beta Typing' });
    manager = await t.addStaff(alpha, 'manager');
    receptionist = await t.addStaff(alpha, 'receptionist');
    accountant = await t.addStaff(alpha, 'accountant');
    customerId = (await t.as(alpha.owner).post('/customers', { fullName: 'Fatima Al Mansoori', fullNameAr: 'فاطمة المنصوري', nationality: 'IN', passportNo: 'N1234567', email: 'fatima@example.test', phone: '+971501234567' }).expect(201)).body.id;
  });
  afterAll(() => t.close());

  it('every centre has the built-in templates; managers edit the wording', async () => {
    const templates = (await t.as(receptionist).get('/paperwork/templates').expect(200)).body;
    expect(templates.map((x: { key: string }) => x.key).sort()).toEqual(['employment_contract', 'experience_letter', 'noc', 'salary_certificate']);
    const salary = templates.find((x: { key: string }) => x.key === 'salary_certificate');
    templateId = salary.id;
    await t.as(receptionist).patch(`/paperwork/templates/${templateId}`, { version: 1, titleEn: 'Salary Certificate' }).expect(403);
    await t.as(accountant).get('/paperwork/templates').expect(403);
    const edited = await t.as(manager).patch(`/paperwork/templates/${templateId}`, { version: 1, bodyEn: `${salary.bodyEn}\n\nOn the letterhead of {{employerName}}.` }).expect(200);
    expect(edited.body.version).toBe(2);
    await t.as(manager).patch(`/paperwork/templates/${templateId}`, { version: 1, titleEn: 'Stale' }).expect(409);
    expect((await t.as(beta.owner).get('/paperwork/templates').expect(200)).body.find((x: { key: string }) => x.key === 'salary_certificate').version).toBe(1);
  });

  it('drafts from the customer\'s record and the typed fields', async () => {
    const draft = await t.as(receptionist).post('/paperwork/documents', { templateId, customerId, values: { ...values, monthlySalary: '' } }).expect(201);
    documentId = draft.body.id;
    expect(draft.body).toMatchObject({ status: 'DRAFT', documentNo: expect.stringMatching(/^DOC-\d{6}$/), titleEn: 'Salary Certificate' });
    expect(draft.body.bodyEn).toContain('Fatima Al Mansoori');
    expect(draft.body.bodyEn).toContain('N1234567');
    expect(draft.body.bodyEn).toContain('since 1 March 2023');
    expect(draft.body.bodyEn).toContain('a national of India');
    expect(draft.body.bodyAr).toContain('الهند');
    expect(draft.body.bodyEn).toContain('AED __________');
    expect(draft.body.bodyAr).toContain('فاطمة المنصوري');
    expect((await t.as(receptionist).post(`/paperwork/documents/${documentId}/issue`)).body.code).toBe('FIELDS_MISSING');
    const filled = await t.as(receptionist).patch(`/paperwork/documents/${documentId}`, { values }).expect(200);
    expect(filled.body.bodyEn).toContain('AED 12,500.00');
    await t.as(beta.owner).get(`/paperwork/documents/${documentId}`).expect(404);
  });

  it('issuing freezes the text and sends the signer the link', async () => {
    const issued = await t.as(receptionist).post(`/paperwork/documents/${documentId}/issue`).expect(200);
    expect(issued.body.status).toBe('ISSUED');
    expect(issued.body.contentHash).toMatch(/^[0-9a-f]{64}$/);
    await t.as(receptionist).patch(`/paperwork/documents/${documentId}`, { values: { ...values, monthlySalary: '99999' } }).expect(409);
    await t.as(receptionist).delete(`/paperwork/documents/${documentId}`).expect(409);
    await expect(t.sys.generatedDocument.update({ where: { id: documentId }, data: { bodyEn: 'changed' } })).rejects.toThrow(/final/);
    await t.as(receptionist).post(`/paperwork/documents/${documentId}/hand-over`, { handedOverTo: 'Fatima' }).expect(409);
    await t.settle();
    expect(await tokenOf(documentId)).toBeTruthy();
  });

  it('the signer reads and signs from the link; the signature is final', async () => {
    const token = await tokenOf(documentId);
    const anon = t.as(null);
    const view = await anon.get(`/public/sign/${token}`).expect(200);
    expect(view.body).toMatchObject({ centreName: 'Alpha Typing', status: 'ISSUED', titleEn: 'Salary Certificate', suggestedSigner: 'Fatima Al Mansoori' });
    expect(view.body.bodyEn).toContain('12,500.00');
    await anon.post(`/public/sign/${token}`).send({ signerName: 'Fatima Al Mansoori', signatureImage: signaturePng() }).expect(400); // must agree
    await anon.post(`/public/sign/${token}`).send({ signerName: 'Fatima', signatureImage: 'data:image/png;base64,AAAA', agree: true }).expect(422);
    await anon.post(`/public/sign/${token}`).send({ signerName: 'Fatima Al Mansoori', signatureImage: signaturePng(), agree: true }).expect(200);
    expect((await anon.post(`/public/sign/${token}`).send({ signerName: 'Someone else', signatureImage: signaturePng(), agree: true })).body.code).toBe('ALREADY_SIGNED');
    const signed = await t.as(manager).get(`/paperwork/documents/${documentId}`).expect(200);
    expect(signed.body).toMatchObject({ status: 'SIGNED', signerName: 'Fatima Al Mansoori', signedVia: 'LINK', hasSignature: true });
    expect(signed.body.signatureImage).toBeUndefined();
    await expect(t.sys.generatedDocument.update({ where: { id: documentId }, data: { signerName: 'Forged' } })).rejects.toThrow(/final/);
    const pdf = await anon.get(`/public/sign/${token}/pdf`).expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    await anon.get(`/public/sign/${token.slice(0, -2)}xx`).expect(404);
  });

  it('is handed over, and a PDF is always available to staff', async () => {
    const done = await t.as(receptionist).post(`/paperwork/documents/${documentId}/hand-over`, { handedOverTo: 'Fatima Al Mansoori (in person)', note: 'Original with stamp' }).expect(200);
    expect(done.body).toMatchObject({ status: 'HANDED_OVER', handedOverTo: 'Fatima Al Mansoori (in person)' });
    const pdf = await t.as(manager).get(`/paperwork/documents/${documentId}/pdf`).expect(200);
    expect(pdf.body.subarray(0, 4).toString()).toBe('%PDF');
    const list = await t.as(manager).get('/paperwork/documents').query({ customerId }).expect(200);
    expect(list.body.data.map((d: { id: string }) => d.id)).toEqual([documentId]);
  });

  it('counter signing, voiding and erasure', async () => {
    const noc = (await t.as(manager).get('/paperwork/templates').expect(200)).body.find((x: { key: string }) => x.key === 'noc');
    const d = (await t.as(receptionist).post('/paperwork/documents', { templateId: noc.id, customerId, values: { issuerName: 'Falcon Logistics LLC', relationship: 'employee', addressedTo: 'Whom it may concern', noObjectionTo: 'travelling abroad' } }).expect(201)).body;
    await t.as(receptionist).post(`/paperwork/documents/${d.id}/issue`).expect(200);
    await t.as(receptionist).post(`/paperwork/documents/${d.id}/sign`, { signerName: 'Ahmed (HR manager)', signatureImage: signaturePng(), agree: true }).expect(200).expect((r) => expect(r.body.signedVia).toBe('COUNTER'));
    await t.as(receptionist).post(`/paperwork/documents/${d.id}/void`, { reason: 'Wrong employer' }).expect(200);
    await t.as(receptionist).post(`/paperwork/documents/${d.id}/void`, { reason: 'again' }).expect(409);

    const draft = (await t.as(receptionist).post('/paperwork/documents', { templateId, customerId, values }).expect(201)).body;
    const report = await t.inTenant(alpha.id, () => t.db.tx((tx) => t.get(PaperworkService).erase(tx, { tenantId: alpha.id, privacyRequestId: 'x', customerId, customerIds: [customerId] } as never)));
    expect(report).toEqual({ draftsDeleted: 1, documentsRedacted: 2 });
    expect(await t.sys.generatedDocument.count({ where: { id: draft.id } })).toBe(0);
    const erased = await t.sys.generatedDocument.findUniqueOrThrow({ where: { id: documentId } });
    expect(erased).toMatchObject({ status: 'VOID', bodyEn: '[erased]', signatureImage: null });
  });
});
