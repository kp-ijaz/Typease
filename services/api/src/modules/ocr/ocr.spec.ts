import { Actor, TenantFixture, TestApp } from '../../../test/helpers';
import { env } from '../../config/env';
import { blindIndex, decryptText, encryptText, last4 } from '../../common/crypto';
import { addChecklistItem, createCustomer, createRequest, infectedPdfBytes, pngBytes, uploadDocument } from '../documents/fixtures';
import { formatEmiratesId } from './extractors';
import { buildTd1, buildTd3, daysFromNow, emiratesIdFrom, FakeOcrProvider, isoDate, mrzDate, passportPageText } from './fixtures';
import { DisabledOcrProvider, OcrProviders } from './providers';

describe('AI document assistant: extraction, human review and apply', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let operator: Actor; // ocr.run, no ocr.review
  let reviewer: Actor; // ocr.run + ocr.review
  let receptionist: Actor; // neither
  let fake: FakeOcrProvider;

  const expiry = daysFromNow(900);
  const passportMrz = (number = 'Z1234567') => buildTd3({ issuing: 'IND', surname: 'Sampleson', given: 'Rahul Kumar', number, nationality: 'IND', dob: '900214', sex: 'M', expiry: mrzDate(expiry) });
  const customerRow = (id: string) => t.sys.customer.findUniqueOrThrow({ where: { id } });
  const resultRow = (id: string) => t.sys.ocrExtractionResult.findUniqueOrThrow({ where: { id } });
  const aiPagesUsed = async (tenantId: string) => Number((await t.sys.usageRecord.findFirst({ where: { tenantId, metric: 'aiPages' } }))?.quantity ?? 0);
  const upload = (actor: Actor, fields: Record<string, unknown>) => uploadDocument(t, actor, fields, { content: pngBytes(), mime: 'image/png', filename: 'scan.png' });
  /** Upload + extract + run the job with the given recognised text. */
  const extract = async (fields: Record<string, unknown>, text: string, actor: Actor = operator) => {
    const doc = await upload(alpha.owner, fields);
    fake.willReturn(text);
    const queued = await t.as(actor).post(`/documents/${doc.documentId}/extract`).expect(202);
    await t.settle();
    return { doc, id: queued.body.id as string };
  };
  const fieldsOf = (body: any) => Object.fromEntries(body.fields.map((f: any) => [f.key, f]));

  beforeAll(async () => {
    t = await TestApp.create();
    alpha = await t.createTenant({ name: 'Alpha Typing' });
    beta = await t.createTenant({ name: 'Beta Typing' });
    operator = await t.addStaff(alpha, 'operator');
    reviewer = await t.addStaff(alpha, 'reviewer');
    receptionist = await t.addStaff(alpha, 'receptionist');
    fake = new FakeOcrProvider();
    t.get(OcrProviders).useForTesting(fake);
    await t.as(alpha.owner).patch('/tenant', { aiEnabled: true }).expect(200);
    await t.sys.tenant.update({ where: { id: beta.id }, data: { aiEnabled: true } });
  });
  afterAll(() => t.close());

  describe('switches: provider, tenant, plan, consent', () => {
    it('answers 503 while no OCR engine is configured, and never calls one', async () => {
      const providers = t.get(OcrProviders);
      const doc = await upload(alpha.owner, { customerId: (await createCustomer(t, alpha)).id });
      providers.useForTesting(new DisabledOcrProvider());
      try {
        const res = await t.as(operator).post(`/documents/${doc.documentId}/extract`);
        expect(res.status).toBe(503);
        expect(res.body.code).toBe('INTEGRATION_NOT_CONFIGURED');
        expect((await t.as(alpha.owner).get('/ocr/usage').expect(200)).body.provider).toEqual({ name: 'disabled', configured: false });
      } finally {
        providers.useForTesting(fake);
      }
      expect(await t.sys.ocrExtractionResult.count({ where: { documentId: doc.documentId } })).toBe(0);
      expect(fake.calls).toHaveLength(0);
    });

    it('respects the tenant switch, the plan feature and the monthly page limit', async () => {
      const off = await t.createTenant();
      const offDoc = await uploadDocument(t, off.owner, { customerId: (await createCustomer(t, off)).id }, { content: pngBytes(), mime: 'image/png' });
      const disabled = await t.as(off.owner).post(`/documents/${offDoc.documentId}/extract`);
      expect(disabled.status).toBe(403);
      expect(disabled.body.code).toBe('AI_DISABLED');

      // Starter plan: the assistant is not included, and cannot even be switched on.
      const starter = await t.createTenant({ plan: 'starter' });
      await t.as(starter.owner).patch('/tenant', { aiEnabled: true }).expect(402);
      await t.sys.tenant.update({ where: { id: starter.id }, data: { aiEnabled: true } });
      const starterDoc = await uploadDocument(t, starter.owner, { customerId: (await createCustomer(t, starter)).id }, { content: pngBytes(), mime: 'image/png' });
      const noFeature = await t.as(starter.owner).post(`/documents/${starterDoc.documentId}/extract`);
      expect(noFeature.status).toBe(402);
      expect(noFeature.body.details.limit).toBe('aiAssistant');

      // Professional plan: 200 pages a month.
      const pro = await t.createTenant({ plan: 'professional' });
      await t.as(pro.owner).patch('/tenant', { aiEnabled: true }).expect(200);
      const proDoc = await uploadDocument(t, pro.owner, { customerId: (await createCustomer(t, pro)).id }, { content: pngBytes(), mime: 'image/png' });
      const month = new Date().toISOString().slice(0, 7);
      await t.sys.usageRecord.create({ data: { tenantId: pro.id, metric: 'aiPages', periodKey: month, quantity: 200 } });
      const overLimit = await t.as(pro.owner).post(`/documents/${proDoc.documentId}/extract`);
      expect(overLimit.status).toBe(402);
      expect(overLimit.body.details.limit).toBe('aiPages');
      await t.sys.usageRecord.updateMany({ where: { tenantId: pro.id, metric: 'aiPages' }, data: { quantity: 199 } });
      await t.as(pro.owner).post(`/documents/${proDoc.documentId}/extract`).expect(202);
      t.jobs.clearInline();
      expect(fake.calls).toHaveLength(0);
    });

    it('never processes documents of a customer who withdrew consent for AI processing', async () => {
      const withdrawn = await createCustomer(t, alpha);
      await t.sys.customerConsent.create({ data: { tenantId: alpha.id, customerId: withdrawn.id, purpose: 'AI_PROCESSING', status: 'WITHDRAWN', withdrawnAt: new Date() } });
      const doc = await upload(alpha.owner, { customerId: withdrawn.id });
      const res = await t.as(operator).post(`/documents/${doc.documentId}/extract`);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('AI_CONSENT_WITHDRAWN');
      // Also when the document hangs off a request of that customer only.
      const request = await createRequest(t, alpha, withdrawn.id, { assignedToId: operator.membershipId });
      const viaRequest = await upload(alpha.owner, { requestId: request.id });
      expect((await t.as(operator).post(`/documents/${viaRequest.documentId}/extract`)).body.code).toBe('AI_CONSENT_WITHDRAWN');

      // Granted consent, or no record at all (staff-initiated, contract basis), is processed.
      const granted = await createCustomer(t, alpha);
      await t.sys.customerConsent.create({ data: { tenantId: alpha.id, customerId: granted.id, purpose: 'AI_PROCESSING', status: 'GRANTED', grantedAt: new Date() } });
      const ok = await upload(alpha.owner, { customerId: granted.id });
      fake.willReturn('nothing readable');
      await t.as(operator).post(`/documents/${ok.documentId}/extract`).expect(202);
      await t.settle();

      // Withdrawn while the job was waiting: the engine is not called.
      const late = await createCustomer(t, alpha);
      const lateDoc = await upload(alpha.owner, { customerId: late.id });
      const queued = await t.as(operator).post(`/documents/${lateDoc.documentId}/extract`).expect(202);
      await t.sys.customerConsent.create({ data: { tenantId: alpha.id, customerId: late.id, purpose: 'AI_PROCESSING', status: 'WITHDRAWN', withdrawnAt: new Date() } });
      const callsBefore = fake.calls.length;
      await t.settle();
      expect(fake.calls).toHaveLength(callsBefore);
      expect(await resultRow(queued.body.id)).toMatchObject({ status: 'FAILED', error: 'The customer has withdrawn consent for AI processing.' });
    });

    it('refuses files the engine cannot read and documents that are not available', async () => {
      const c = await createCustomer(t, alpha);
      const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(40, 1)]);
      const unsupported = await uploadDocument(t, alpha.owner, { customerId: c.id }, { content: webp, mime: 'image/webp', filename: 'scan.webp' });
      const res = await t.as(operator).post(`/documents/${unsupported.documentId}/extract`);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('OCR_UNSUPPORTED_FILE');
      const infected = await uploadDocument(t, alpha.owner, { customerId: c.id }, { content: infectedPdfBytes() });
      expect((await t.as(operator).post(`/documents/${infected.documentId}/extract`)).body.code).toBe('DOCUMENT_QUARANTINED');
      await t.as(operator).post(`/documents/${infected.documentId}/extract`, { profile: 'DRIVING_LICENCE' }).expect(400);
    });
  });

  describe('passport pipeline', () => {
    let customerId: string;
    let documentId: string;
    let resultId: string;
    const text = passportPageText(passportMrz(), 'UNIQUE-RAW-TEXT-MARKER-7731');

    beforeAll(async () => {
      const number = 'Z7654321';
      const c = await createCustomer(t, alpha, {
        fullName: 'Rahul Sampleson', nationality: 'IND', dateOfBirth: new Date('1990-02-14'),
        passportNoEnc: encryptText(number), passportNoHash: blindIndex(alpha.id, 'passport', number), passportNoLast4: last4(number),
      });
      customerId = c.id;
      const doc = await upload(alpha.owner, { customerId, documentTypeKey: 'passport' });
      documentId = doc.documentId;
      fake.willReturn(text, 1, 0.9);
      const before = fake.calls.length;
      const queued = await t.as(operator).post(`/documents/${documentId}/extract`).expect(202);
      expect(queued.body).toMatchObject({ status: 'QUEUED', unverified: true, provider: 'fake-test-provider', profile: 'PASSPORT', fieldCount: 0 });
      resultId = queued.body.id;
      // Asking again while it is queued returns the same job instead of starting a second one.
      expect((await t.as(operator).post(`/documents/${documentId}/extract`).expect(202)).body.id).toBe(resultId);
      await t.settle();
      expect(fake.calls.slice(before)).toEqual([{ bytes: doc.content.length, mime: 'image/png' }]);
    });

    it('stores confidence-scored suggestions and warnings, marked as unverified', async () => {
      const res = await t.as(operator).get(`/ocr/results/${resultId}`).expect(200);
      expect(res.body).toMatchObject({ status: 'COMPLETED', unverified: true, classification: 'PASSPORT', classificationConfidence: 0.99, pages: 1, customerId, documentId });
      expect(res.body.notice).toMatch(/Not verified/);
      const f = fieldsOf(res.body);
      expect(f.passportNumber).toEqual({
        key: 'passportNumber', label: 'Passport number', canApply: true, reviewed: null,
        extracted: { value: 'Z1234567', confidence: 0.99, source: 'MRZ' },
        // What is on file is shown masked; "matches" is computed on the server from the decrypted value.
        onFile: { value: '•••• 4321', matches: false },
      });
      expect(f.fullName).toMatchObject({ extracted: { value: 'RAHUL KUMAR SAMPLESON' }, onFile: { value: 'Rahul Sampleson', matches: true } });
      expect(f.dateOfBirth).toMatchObject({ extracted: { value: '1990-02-14', confidence: 0.99 }, onFile: { value: '1990-02-14', matches: true } });
      expect(f.nationality.onFile).toEqual({ value: 'IND', matches: true });
      expect(f.expiryDate).toMatchObject({ extracted: { value: isoDate(expiry) }, onFile: { value: null, matches: null } });
      expect(f.issueDate.extracted).toMatchObject({ value: '2022-04-16', source: 'TEXT' });
      expect(f.issueDate.extracted.confidence).toBeLessThan(0.6);
      expect(f.sex.onFile).toBeNull(); // nothing comparable is kept on file
      expect(res.body.warnings.map((w: any) => `${w.severity} ${w.code} ${w.field}`).sort()).toEqual([
        'HIGH DOCUMENT_NUMBER_MISMATCH passportNumber', 'LOW LOW_CONFIDENCE issueDate', 'LOW NAME_PARTIAL_MATCH fullName', 'LOW NOT_ON_FILE expiryDate',
      ]);
      expect(res.body.warnings[0].severity).toBe('HIGH'); // most severe first
      expect(res.body.warnings.find((w: any) => w.code === 'DOCUMENT_NUMBER_MISMATCH').suggestion).toEqual({ target: 'customer.passportNo', fieldKey: 'passportNumber' });
      // The number on file never travels to the client.
      expect(JSON.stringify(res.body)).not.toContain('Z7654321');

      const list = await t.as(reviewer).get('/ocr/results?status=COMPLETED').expect(200);
      const row = list.body.data.find((r: any) => r.id === resultId);
      expect(row).toMatchObject({ unverified: true, fieldCount: 10, warningCount: { high: 1, medium: 0, low: 3 } });
      expect(row.fields).toBeUndefined();
      expect((await t.as(reviewer).get(`/documents/${documentId}/extractions`).expect(200)).body.data.map((r: any) => r.id)).toEqual([resultId]);
    });

    it('does not persist the recognised text and encrypts identity numbers at rest', async () => {
      const row = await resultRow(resultId);
      const stored = JSON.stringify(row);
      expect(stored).not.toContain('UNIQUE-RAW-TEXT-MARKER-7731');
      expect(stored).not.toContain('PASSEPORT');
      expect(stored).not.toContain(passportMrz()[1]);
      expect(stored).not.toContain('Z1234567');
      const number = (row.fields as any[]).find((f) => f.key === 'passportNumber');
      expect(number.value).toBeNull();
      expect(decryptText(number.valueEnc)).toBe('Z1234567');
      // Neither does the audit trail, the usage log or any outbox event carry values or text.
      const audit = JSON.stringify(await t.sys.auditLog.findMany({ where: { tenantId: alpha.id, resourceId: resultId } }));
      expect(audit).toContain('ocr.completed');
      for (const secret of ['Z1234567', 'SAMPLESON', 'UNIQUE-RAW-TEXT', '1990-02-14']) expect(audit).not.toContain(secret);
    });

    it('logs usage, cost and the read of the document', async () => {
      expect(await t.sys.aiUsageLog.findMany({ where: { tenantId: alpha.id, documentId } })).toEqual([
        expect.objectContaining({ provider: 'fake-test-provider', operation: 'ocr.extract', pages: 1, success: true, actorId: operator.userId }),
      ]);
      expect(await t.sys.documentAccessLog.count({ where: { documentId, action: 'OCR_PROCESSED', actorType: 'SYSTEM' } })).toBe(1);
      expect(await aiPagesUsed(alpha.id)).toBeGreaterThanOrEqual(1);
    });

    it('changes nothing on the customer profile or the document by itself', async () => {
      const c = await customerRow(customerId);
      expect(c).toMatchObject({ fullName: 'Rahul Sampleson', passportNoLast4: '4321', passportExpiry: null, version: 1 });
      expect(decryptText(c.passportNoEnc!)).toBe('Z7654321');
      expect(await t.sys.document.findUniqueOrThrow({ where: { id: documentId } })).toMatchObject({ expiryDate: null, expiryVerified: false, verificationStatus: 'UNVERIFIED' });
      // Running the finished job again does not call the engine or bill twice.
      const calls = fake.calls.length;
      await t.jobs.execute('ocr.extract', { tenantId: alpha.id, resultId }, { attempt: 1, maxAttempts: 1 });
      expect(fake.calls).toHaveLength(calls);
      expect(await t.sys.aiUsageLog.count({ where: { documentId } })).toBe(1);
    });

    it('applies nothing before a person has reviewed the result', async () => {
      const res = await t.as(reviewer).post(`/ocr/results/${resultId}/apply`, { fields: ['passportNumber'] });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('OCR_NOT_REVIEWED');
      expect((await customerRow(customerId)).passportNoLast4).toBe('4321');
    });

    it('records the human review: confirmed, corrected, added and rejected values', async () => {
      const invalid = await t.as(reviewer).post(`/ocr/results/${resultId}/review`, {
        fields: [{ key: 'expiryDate', value: '31/12/2030' }, { key: 'passportNumber', value: 'Z 12' }, { key: 'nationality', value: 'India' }, { key: 'dateOfBirth', value: '1990-02-30' }],
      });
      expect(invalid.status).toBe(422);
      expect(invalid.body.code).toBe('INVALID_REVIEW_VALUE');
      expect(invalid.body.details.map((d: any) => d.path)).toEqual(['fields.0.value', 'fields.1.value', 'fields.2.value', 'fields.3.value']);
      expect((await resultRow(resultId)).status).toBe('COMPLETED');
      await t.as(reviewer).post(`/ocr/results/${resultId}/review`, { fields: [] }).expect(400);
      await t.as(reviewer).post(`/ocr/results/${resultId}/review`, { fields: [{ key: 'sex', value: 'M' }, { key: 'sex', value: 'F' }] }).expect(400);
      await t.as(reviewer).post(`/ocr/results/${resultId}/review`, { fields: [{ key: 'height', value: '180' }] }).expect(400);

      const res = await t
        .as(reviewer)
        .post(`/ocr/results/${resultId}/review`, {
          fields: [
            { key: 'passportNumber', value: ' z1234567 ' },
            { key: 'fullName', value: 'Rahul Kumar  Sampleson' },
            { key: 'dateOfBirth', value: '1990-02-14' },
            { key: 'nationality', value: 'ind' },
            { key: 'issuingState', value: 'IND' },
            { key: 'expiryDate', value: isoDate(expiry) },
            { key: 'issueDate', value: null },
            { key: 'emiratesIdNumber', value: '784-1990-1234567-1' },
          ],
          note: 'Checked against the original passport at the counter.',
        })
        .expect(200);
      expect(res.body).toMatchObject({ status: 'REVIEWED', unverified: false, notice: null, reviewedById: reviewer.userId, reviewNote: 'Checked against the original passport at the counter.' });
      const f = fieldsOf(res.body);
      expect(f.passportNumber.reviewed).toEqual({ value: 'Z1234567', decision: 'CONFIRMED' });
      expect(f.fullName.reviewed).toEqual({ value: 'Rahul Kumar Sampleson', decision: 'CORRECTED' });
      expect(f.nationality.reviewed).toEqual({ value: 'IND', decision: 'CONFIRMED' });
      expect(f.issueDate.reviewed).toEqual({ value: null, decision: 'REJECTED' });
      expect(f.emiratesIdNumber).toMatchObject({ extracted: null, reviewed: { value: '784-1990-1234567-1', decision: 'ADDED' } });
      expect(f.sex.reviewed).toBeNull(); // not looked at by the reviewer
      // Reviewed identity numbers are encrypted at rest too, and the audit entry lists decisions only.
      const row = await resultRow(resultId);
      expect(JSON.stringify(row.reviewedFields)).not.toMatch(/Z1234567|784-1990|784199012345671/);
      const audit = await t.sys.auditLog.findFirstOrThrow({ where: { action: 'ocr.reviewed', resourceId: resultId } });
      expect((audit.after as any).decisions).toMatchObject({ passportNumber: 'CONFIRMED', fullName: 'CORRECTED', issueDate: 'REJECTED' });
      expect(JSON.stringify(audit)).not.toContain('Z1234567');
      // Still nothing on the profile.
      expect((await customerRow(customerId)).fullName).toBe('Rahul Sampleson');
    });

    it('applies only the reviewed fields the reviewer selects, with the customers encryption scheme', async () => {
      const refuse = async (fields: string[], status: number, code: string) => {
        const res = await t.as(reviewer).post(`/ocr/results/${resultId}/apply`, { fields });
        expect([fields.join(), res.status, res.body.code]).toEqual([fields.join(), status, code]);
      };
      await refuse(['sex'], 422, 'FIELD_NOT_APPLICABLE'); // extracted but never reviewed, and not a profile field
      await refuse(['surname'], 422, 'FIELD_NOT_APPLICABLE');
      await refuse(['issueDate'], 422, 'FIELD_NOT_REVIEWED'); // rejected by the reviewer
      // Another customer already has this passport number.
      const twin = await createCustomer(t, alpha, { passportNoEnc: encryptText('Z1234567'), passportNoHash: blindIndex(alpha.id, 'passport', 'Z1234567'), passportNoLast4: '4567' });
      await refuse(['passportNumber'], 409, 'IDENTITY_NUMBER_IN_USE');
      await t.sys.customer.update({ where: { id: twin.id }, data: { passportNoHash: null } });
      expect(await customerRow(customerId)).toMatchObject({ fullName: 'Rahul Sampleson', passportNoLast4: '4321', version: 1 });

      const res = await t.as(reviewer).post(`/ocr/results/${resultId}/apply`, { fields: ['passportNumber', 'fullName', 'expiryDate', 'issuingState'] }).expect(200);
      expect(res.body.applied).toEqual([{ at: expect.any(String), by: reviewer.userId, keys: ['passportNumber', 'fullName', 'expiryDate', 'issuingState'] }]);
      const c = await customerRow(customerId);
      expect(c).toMatchObject({ fullName: 'Rahul Kumar Sampleson', passportNoLast4: '4567', passportCountry: 'IND', passportNoHash: blindIndex(alpha.id, 'passport', 'Z1234567'), version: 2 });
      expect(decryptText(c.passportNoEnc!)).toBe('Z1234567');
      expect(c.passportExpiry!.toISOString().slice(0, 10)).toBe(isoDate(expiry));
      // Not selected, so not applied - although it was reviewed.
      expect(c.emiratesIdEnc).toBeNull();
      const d = await t.sys.document.findUniqueOrThrow({ where: { id: documentId } });
      expect(d.expiryDate!.toISOString().slice(0, 10)).toBe(isoDate(expiry));
      expect(d.expiryVerified).toBe(true);
      expect(d.issuedDate).toBeNull();

      const audit = await t.sys.auditLog.findMany({ where: { tenantId: alpha.id, action: { in: ['ocr.applied', 'customer.updated_from_document'] }, actorUserId: reviewer.userId }, orderBy: { createdAt: 'desc' }, take: 2 });
      expect(audit.map((a) => a.action).sort()).toEqual(['customer.updated_from_document', 'ocr.applied']);
      expect(JSON.stringify(audit)).not.toMatch(/Z1234567|Z7654321/);
      expect(JSON.stringify(audit)).toContain('•••• 4321');
      // The review screen now shows the profile and document in agreement.
      const after = fieldsOf((await t.as(reviewer).get(`/ocr/results/${resultId}`).expect(200)).body);
      expect(after.passportNumber.onFile).toEqual({ value: '•••• 4567', matches: true });
      expect(after.expiryDate.onFile).toEqual({ value: isoDate(expiry), matches: true });
    });
  });

  describe('Emirates ID and other documents', () => {
    it('extracts the back of an Emirates ID and applies the reviewed identity number', async () => {
      const eid = emiratesIdFrom('78419901234567');
      const c = await createCustomer(t, alpha, { fullName: 'Rahul Kumar Sampleson' });
      const mrz = buildTd1({ docCode: 'IL', issuing: 'ARE', number: '123456789', optional1: eid, dob: '900214', sex: 'M', expiry: mrzDate(daysFromNow(100)), nationality: 'IND', surname: 'Sampleson', given: 'Rahul Kumar' });
      const { id, doc } = await extract({ customerId: c.id, documentTypeKey: 'emirates_id' }, mrz.join('\n'), reviewer);
      const res = await t.as(reviewer).get(`/ocr/results/${id}`).expect(200);
      expect(res.body).toMatchObject({ classification: 'EMIRATES_ID', classificationConfidence: 0.98, profile: 'EMIRATES_ID' });
      const f = fieldsOf(res.body);
      expect(f.emiratesIdNumber.extracted).toEqual({ value: formatEmiratesId(eid), confidence: 0.95, source: 'MRZ' });
      expect(f.emiratesIdNumber.onFile).toEqual({ value: null, matches: null });
      expect(res.body.warnings.map((w: any) => w.code)).toEqual(expect.arrayContaining(['DOCUMENT_EXPIRING_SOON', 'NOT_ON_FILE']));
      expect(JSON.stringify(await resultRow(id))).not.toContain(eid);

      await t.as(reviewer).post(`/ocr/results/${id}/review`, { fields: [{ key: 'emiratesIdNumber', value: eid }, { key: 'expiryDate', value: isoDate(daysFromNow(100)) }, { key: 'issuingState', value: 'ARE' }] }).expect(200);
      const notPassport = await t.as(reviewer).post(`/ocr/results/${id}/apply`, { fields: ['issuingState'] });
      expect(notPassport.body.code).toBe('FIELD_NOT_APPLICABLE');
      await t.as(reviewer).post(`/ocr/results/${id}/apply`, { fields: ['emiratesIdNumber', 'expiryDate'] }).expect(200);
      const row = await customerRow(c.id);
      expect(decryptText(row.emiratesIdEnc!)).toBe(eid);
      expect(row).toMatchObject({ emiratesIdHash: blindIndex(alpha.id, 'emiratesId', eid), emiratesIdLast4: eid.slice(-4), passportExpiry: null });
      expect(row.emiratesIdExpiry!.toISOString().slice(0, 10)).toBe(isoDate(daysFromNow(100)));
      expect((await t.sys.document.findUniqueOrThrow({ where: { id: doc.documentId } })).expiryVerified).toBe(true);
    });

    it('reports an unreadable scan honestly: no fields, missing-field warnings, still billed as a processed page', async () => {
      const c = await createCustomer(t, alpha);
      const { id } = await extract({ customerId: c.id, documentTypeKey: 'passport' }, '~~ ,, ..\n \n');
      const res = await t.as(reviewer).get(`/ocr/results/${id}`).expect(200);
      expect(res.body).toMatchObject({ status: 'COMPLETED', classification: 'UNKNOWN', classificationConfidence: 0, fields: [] });
      expect(res.body.warnings.map((w: any) => [w.code, w.field])).toEqual([
        ['MISSING_FIELD', 'passportNumber'], ['MISSING_FIELD', 'fullName'], ['MISSING_FIELD', 'nationality'], ['MISSING_FIELD', 'dateOfBirth'], ['MISSING_FIELD', 'expiryDate'],
      ]);
    });

    it('flags a document that was filed under the wrong type and a company document without a customer', async () => {
      const c = await createCustomer(t, alpha);
      const wrongType = await extract({ customerId: c.id, documentTypeKey: 'emirates_id' }, passportPageText(passportMrz('Y0000001')));
      const res = await t.as(reviewer).get(`/ocr/results/${wrongType.id}`).expect(200);
      expect(res.body.classification).toBe('PASSPORT');
      expect(res.body.warnings.map((w: any) => w.code)).toContain('CLASSIFICATION_MISMATCH');

      const account = await t.sys.corporateAccount.create({ data: { tenantId: alpha.id, accountNo: `CORP-${Date.now()}`, companyName: 'Sample Trading LLC' } });
      const licence = await extract(
        { corporateAccountId: account.id, documentTypeKey: 'trade_licence' },
        'Department of Economy and Tourism\nCommercial License\nLicense No. 998877\nTrade Name: SAMPLE TRADING L.L.C\nExpiry Date: 31/12/2031',
        reviewer,
      );
      const lic = await t.as(reviewer).get(`/ocr/results/${licence.id}`).expect(200);
      expect(lic.body).toMatchObject({ classification: 'TRADE_LICENCE', customerId: null });
      expect(fieldsOf(lic.body).licenceNumber.extracted).toEqual({ value: '998877', confidence: 0.465, source: 'HEURISTIC' });
      await t.as(reviewer).post(`/ocr/results/${licence.id}/review`, { fields: [{ key: 'expiryDate', value: '2031-12-31' }, { key: 'fullName', value: 'Someone' }] }).expect(200);
      // The expiry goes to the document; there is no customer profile to write a name to.
      const noCustomer = await t.as(reviewer).post(`/ocr/results/${licence.id}/apply`, { fields: ['fullName'] });
      expect(noCustomer.status).toBe(422);
      expect(noCustomer.body.code).toBe('NO_CUSTOMER_FOR_DOCUMENT');
      await t.as(reviewer).post(`/ocr/results/${licence.id}/apply`, { fields: ['expiryDate'] }).expect(200);
      const d = await t.sys.document.findUniqueOrThrow({ where: { id: licence.doc.documentId } });
      expect([d.expiryDate!.toISOString().slice(0, 10), d.expiryVerified]).toEqual(['2031-12-31', true]);
    });
  });

  describe('engine failures', () => {
    it('retries an outage and fails cleanly when the engine keeps failing', async () => {
      const c = await createCustomer(t, alpha);
      const flaky = await upload(alpha.owner, { customerId: c.id });
      fake.willFail('connect ECONNREFUSED').willReturn(passportPageText(passportMrz('R0000001')));
      const first = await t.as(operator).post(`/documents/${flaky.documentId}/extract`).expect(202);
      await t.settle();
      expect((await resultRow(first.body.id)).status).toBe('COMPLETED');

      const pagesBefore = await aiPagesUsed(alpha.id);
      const dead = await upload(alpha.owner, { customerId: c.id });
      fake.willFail('boom 1 with internal detail /var/secret').willFail('boom 2').willFail('boom 3');
      const second = await t.as(operator).post(`/documents/${dead.documentId}/extract`).expect(202);
      await t.settle();
      const row = await resultRow(second.body.id);
      expect(row).toMatchObject({ status: 'FAILED', error: 'The OCR engine could not read this document. Please try again later.', pages: 0 });
      expect(await t.sys.aiUsageLog.findMany({ where: { documentId: dead.documentId } })).toEqual([expect.objectContaining({ success: false, pages: 0 })]);
      expect(await aiPagesUsed(alpha.id)).toBe(pagesBefore);
      const view = await t.as(reviewer).get(`/ocr/results/${second.body.id}`).expect(200);
      expect(view.body).toMatchObject({ status: 'FAILED', fields: [] });
      expect((await t.as(reviewer).post(`/ocr/results/${second.body.id}/review`, { fields: [{ key: 'sex', value: 'M' }] })).body.code).toBe('OCR_NOT_READY');
      // A failed run can be started again.
      fake.willReturn('still nothing');
      const again = await t.as(operator).post(`/documents/${dead.documentId}/extract`).expect(202);
      expect(again.body.id).not.toBe(second.body.id);
      await t.settle();
    });
  });

  describe('permissions and isolation', () => {
    let resultId: string;
    let documentId: string;
    beforeAll(async () => {
      const c = await createCustomer(t, alpha);
      const out = await extract({ customerId: c.id }, passportPageText(passportMrz('P0000009')));
      resultId = out.id;
      documentId = out.doc.documentId;
    });

    it('requires ocr.run to start and ocr.review to review or apply', async () => {
      await t.as(receptionist).post(`/documents/${documentId}/extract`).expect(403);
      await t.as(receptionist).get(`/ocr/results/${resultId}`).expect(403);
      await t.as(receptionist).get('/ocr/results').expect(403);
      await t.as(receptionist).get('/ocr/usage').expect(403);
      await t.as(operator).get(`/ocr/results/${resultId}`).expect(200);
      await t.as(operator).post(`/ocr/results/${resultId}/review`, { fields: [{ key: 'sex', value: 'M' }] }).expect(403);
      await t.as(operator).post(`/ocr/results/${resultId}/apply`, { fields: ['fullName'] }).expect(403);
      const customer = await t.addCustomer(alpha);
      const own = await uploadDocument(t, customer, {}, { content: pngBytes(), mime: 'image/png' });
      await t.as(customer).post(`/documents/${own.documentId}/extract`).expect(403);
      await t.as(customer).get('/ocr/results').expect(403);
      await t.as(null).get(`/ocr/results/${resultId}`).expect(401);
    });

    it('keeps extractions inside the tenant and inside the document access rules', async () => {
      await t.as(beta.owner).get(`/ocr/results/${resultId}`).expect(404);
      await t.as(beta.owner).post(`/ocr/results/${resultId}/review`, { fields: [{ key: 'sex', value: 'M' }] }).expect(404);
      await t.as(beta.owner).post(`/ocr/results/${resultId}/apply`, { fields: ['fullName'] }).expect(404);
      await t.as(beta.owner).post(`/documents/${documentId}/extract`).expect(404);
      // A document of another centre, or one that does not exist, is "not found" - never an empty list that reads like "no extractions yet".
      expect((await t.as(beta.owner).get(`/documents/${documentId}/extractions`).expect(404)).body.code).toBe('NOT_FOUND');
      await t.as(reviewer).get('/documents/6f1c2f0e-3a55-4c56-9a39-0d1f0a5a7e11/extractions').expect(404);
      await t.as(reviewer).get('/documents/not-a-uuid/extractions').expect(400);
      // A readable document without any extraction is an empty page, with 200.
      const untouched = await uploadDocument(t, alpha.owner, { customerId: (await createCustomer(t, alpha)).id, title: 'Never read' });
      expect((await t.as(reviewer).get(`/documents/${untouched.documentId}/extractions`).expect(200)).body).toMatchObject({ data: [], meta: { total: 0 } });
      expect((await t.as(beta.owner).get('/ocr/results').expect(200)).body.data).toEqual([]);
      expect((await t.as(beta.owner).get('/ocr/usage').expect(200)).body.totals).toMatchObject({ extractions: 0, pages: 0 });
      const seen = await t.inTenant(beta.id, () => t.db.tx(async (tx) => [await tx.ocrExtractionResult.count(), await tx.aiUsageLog.count()]));
      expect(seen).toEqual([0, 0]);
      expect((await resultRow(resultId)).status).toBe('COMPLETED');

      // An operator who is not assigned to the request does not see extractions of its documents.
      const c = await createCustomer(t, alpha);
      const assigned = await t.addStaff(alpha, 'operator');
      const request = await createRequest(t, alpha, c.id, { assignedToId: assigned.membershipId });
      await addChecklistItem(t, alpha, request.id, 'passport');
      const onRequest = await extract({ requestId: request.id }, 'no text', assigned);
      await t.as(assigned).get(`/ocr/results/${onRequest.id}`).expect(200);
      await t.as(operator).get(`/ocr/results/${onRequest.id}`).expect(404);
      // ... and the list for that document is closed to them in the same way.
      await t.as(operator).get(`/documents/${onRequest.doc.documentId}/extractions`).expect(404);
      expect((await t.as(assigned).get(`/documents/${onRequest.doc.documentId}/extractions`).expect(200)).body.data.map((r: any) => r.id)).toEqual([onRequest.id]);
      await t.as(operator).post(`/documents/${onRequest.doc.documentId}/extract`).expect(404);
      expect((await t.as(operator).get('/ocr/results?pageSize=100').expect(200)).body.data.map((r: any) => r.id)).not.toContain(onRequest.id);
    });

    it('extraction results are removed when the document is purged', async () => {
      await t.as(alpha.owner).delete(`/documents/${documentId}`).expect(200);
      await t.sys.document.update({ where: { id: documentId }, data: { purgeAfter: new Date(Date.now() - 1000) } });
      await t.jobs.runScheduled('documents.purge');
      expect(await t.sys.ocrExtractionResult.count({ where: { documentId } })).toBe(0);
      await t.as(reviewer).get(`/ocr/results/${resultId}`).expect(404);
    });
  });

  describe('usage and cost', () => {
    it('reports pages and estimated cost per tenant', async () => {
      const tenant = await t.createTenant({ plan: 'professional' });
      await t.as(tenant.owner).patch('/tenant', { aiEnabled: true }).expect(200);
      const c = await createCustomer(t, tenant);
      const config = env() as any;
      config.OCR_COST_PER_PAGE = 0.015;
      try {
        for (const pages of [1, 3]) {
          const doc = await uploadDocument(t, tenant.owner, { customerId: c.id }, { content: pngBytes(), mime: 'image/png' });
          fake.willReturn('no text', pages);
          await t.as(tenant.owner).post(`/documents/${doc.documentId}/extract`).expect(202);
          await t.settle();
        }
      } finally {
        config.OCR_COST_PER_PAGE = 0;
      }
      const res = await t.as(tenant.owner).get('/ocr/usage').expect(200);
      expect(res.body).toMatchObject({
        aiEnabled: true,
        provider: { name: 'fake-test-provider', configured: true },
        plan: { includesAiAssistant: true, monthlyPageLimit: 200 },
        currentMonth: { pagesUsed: 4, pagesRemaining: 196 },
        totals: { extractions: 2, failed: 0, pages: 4, costEstimate: '0.0600', currency: 'USD' },
      });
      expect(res.body.recent.map((l: any) => [l.pages, l.costEstimate]).sort()).toEqual([[1, '0.0150'], [3, '0.0450']]);
      expect(res.body.byProvider).toEqual([{ provider: 'fake-test-provider', operation: 'ocr.extract', success: true, count: 2, pages: 4, costEstimate: '0.0600' }]);
      const rows = await t.sys.ocrExtractionResult.findMany({ where: { tenantId: tenant.id }, orderBy: { pages: 'asc' } });
      expect(rows.map((r) => r.costUnits.toString())).toEqual(['0.015', '0.045']);
      // Outside the date range: nothing.
      expect((await t.as(tenant.owner).get('/ocr/usage?from=2020-01-01&to=2020-12-31').expect(200)).body.totals.extractions).toBe(0);
      // The usage log cannot be edited or deleted by the tenant connection.
      await expect(t.inTenant(tenant.id, () => t.db.tx((tx) => tx.aiUsageLog.deleteMany({})))).rejects.toThrow(/permission denied/i);
    });
  });
  // An applied expiry date must reach the reminders module exactly like a date set on the document by hand.
  describe('applied expiry dates feed expiry reminders', () => {
    const schedulesOf = (customerId: string) => t.sys.reminderSchedule.findMany({ where: { tenantId: alpha.id, customerId }, orderBy: { createdAt: 'asc' } });
    const expiryEvents = async (documentId: string) =>
      (await t.sys.outboxEvent.findMany({ where: { tenantId: alpha.id, type: 'document.expiry_changed' }, orderBy: { createdAt: 'asc' } })).map((e) => e.payload as any).filter((p) => p.documentId === documentId);
    const reviewAndApply = async (id: string, date: Date) => {
      await t.as(reviewer).post(`/ocr/results/${id}/review`, { fields: [{ key: 'expiryDate', value: isoDate(date) }] }).expect(200);
      await t.as(reviewer).post(`/ocr/results/${id}/apply`, { fields: ['expiryDate'] }).expect(200);
      await t.settle();
    };

    it('applying a reviewed expiry date schedules the reminders; a corrected date reschedules them', async () => {
      const customer = await createCustomer(t, alpha, { fullName: 'Rahul Sampleson' });
      const { doc, id } = await extract({ customerId: customer.id }, passportPageText(passportMrz('Z5550001')));
      // Extraction and review alone schedule nothing.
      await t.as(reviewer).post(`/ocr/results/${id}/review`, { fields: [{ key: 'expiryDate', value: isoDate(expiry) }] }).expect(200);
      await t.settle();
      expect(await schedulesOf(customer.id)).toEqual([]);
      expect(await expiryEvents(doc.documentId)).toEqual([]);

      await t.as(reviewer).post(`/ocr/results/${id}/apply`, { fields: ['expiryDate'] }).expect(200);
      expect(await expiryEvents(doc.documentId)).toEqual([
        expect.objectContaining({ documentId: doc.documentId, customerId: customer.id, documentTypeKey: 'passport', expiryDate: isoDate(expiry), previousExpiryDate: null, expiryVerified: true, source: 'OCR', _actor: { userId: reviewer.userId, type: 'STAFF' } }),
      ]);
      await t.settle();
      const [schedule] = await schedulesOf(customer.id);
      expect(schedule).toMatchObject({ documentId: doc.documentId, documentTypeKey: 'passport', subjectLabel: 'Rahul Sampleson', status: 'ACTIVE', offsetsDays: [90, 60, 30, 15, 7] });
      expect(schedule.expiryDate.toISOString().slice(0, 10)).toBe(isoDate(expiry));
      expect(await schedulesOf(customer.id)).toHaveLength(1);
      // Staff see it where they look for reminders.
      const listed = (await t.as(alpha.owner).get(`/reminders?customerId=${customer.id}`).expect(200)).body.data;
      expect(listed).toEqual([expect.objectContaining({ id: schedule.id, expiryDate: isoDate(expiry), documentTypeKey: 'passport' })]);
      const created = await t.sys.auditLog.findFirstOrThrow({ where: { tenantId: alpha.id, action: 'reminder.created', resourceId: schedule.id } });
      expect(created.summary).toMatch(/reviewed extraction/);

      // The reviewer corrects the date in a second review and applies it again: same schedule, new date, fresh round.
      await t.sys.reminderDispatch.create({ data: { tenantId: alpha.id, scheduleId: schedule.id, offsetDays: 90, dueOn: new Date(), status: 'SENT', processedAt: new Date() } });
      const corrected = daysFromNow(400);
      await reviewAndApply(id, corrected);
      const after = await schedulesOf(customer.id);
      expect(after).toHaveLength(1);
      expect(after[0].id).toBe(schedule.id);
      expect(after[0].expiryDate.toISOString().slice(0, 10)).toBe(isoDate(corrected));
      expect(await t.sys.reminderDispatch.count({ where: { scheduleId: schedule.id } })).toBe(0);
      const updated = await t.sys.auditLog.findFirstOrThrow({ where: { tenantId: alpha.id, action: 'reminder.updated', resourceId: schedule.id } });
      expect(updated).toMatchObject({ before: { expiryDate: isoDate(expiry) }, after: { expiryDate: isoDate(corrected) } });
      expect((await expiryEvents(doc.documentId)).map((p) => [p.previousExpiryDate, p.expiryDate, p.source])).toEqual([[null, isoDate(expiry), 'OCR'], [isoDate(expiry), isoDate(corrected), 'OCR']]);
      // Delivering the events again changes nothing (at-least-once delivery).
      await t.sys.outboxEvent.updateMany({ where: { tenantId: alpha.id, type: 'document.expiry_changed' }, data: { status: 'PENDING' } });
      await t.settle();
      expect((await schedulesOf(customer.id)).map((r) => [r.id, r.expiryDate.toISOString().slice(0, 10)])).toEqual([[schedule.id, isoDate(corrected)]]);
    });

    it('a date typed on the document moves a running schedule but does not start one; a date already expired starts none', async () => {
      const customer = await createCustomer(t, alpha, { fullName: 'Manual Date' });
      const { doc, id } = await extract({ customerId: customer.id }, passportPageText(passportMrz('Z5550002')));
      // Typed by staff, not confirmed against the document: no schedule yet.
      const typed = daysFromNow(300);
      await t.as(alpha.owner).patch(`/documents/${doc.documentId}`, { expiryDate: isoDate(typed) }).expect(200);
      await t.settle();
      expect(await expiryEvents(doc.documentId)).toEqual([expect.objectContaining({ expiryDate: isoDate(typed), previousExpiryDate: null, expiryVerified: false, source: 'MANUAL' })]);
      expect(await schedulesOf(customer.id)).toEqual([]);
      // Sending the same date again is not a change.
      await t.as(alpha.owner).patch(`/documents/${doc.documentId}`, { expiryDate: isoDate(typed), title: 'Passport scan' }).expect(200);
      expect(await expiryEvents(doc.documentId)).toHaveLength(1);

      // The reviewed extraction confirms a date: now there is a schedule ...
      await reviewAndApply(id, expiry);
      const [schedule] = await schedulesOf(customer.id);
      expect(schedule.expiryDate.toISOString().slice(0, 10)).toBe(isoDate(expiry));
      // ... and a later manual change of the date moves it.
      const moved = daysFromNow(500);
      await t.as(alpha.owner).patch(`/documents/${doc.documentId}`, { expiryDate: isoDate(moved) }).expect(200);
      await t.settle();
      const after = await schedulesOf(customer.id);
      expect(after.map((r) => [r.id, r.expiryDate.toISOString().slice(0, 10)])).toEqual([[schedule.id, isoDate(moved)]]);

      // A document that has already expired gets no schedule; neither does a type without reminders.
      const expired = await createCustomer(t, alpha);
      const old = await extract({ customerId: expired.id }, passportPageText(passportMrz('Z5550003')));
      await reviewAndApply(old.id, daysFromNow(-30));
      expect(await schedulesOf(expired.id)).toEqual([]);
      const other = await createCustomer(t, alpha);
      const photo = await extract({ customerId: other.id, documentTypeKey: 'photo' }, passportPageText(passportMrz('Z5550004')));
      await reviewAndApply(photo.id, expiry);
      expect((await t.sys.document.findUniqueOrThrow({ where: { id: photo.doc.documentId } })).expiryVerified).toBe(true);
      expect(await schedulesOf(other.id)).toEqual([]);
      // Nothing of this is visible to, or scheduled for, another centre.
      expect(await t.sys.reminderSchedule.count({ where: { tenantId: beta.id } })).toBe(0);
    });
  });
});
