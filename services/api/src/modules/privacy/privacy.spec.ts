import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Actor, TenantFixture, TestApp } from '../../../test/helpers';
import { blindIndex, encryptText, last4 } from '../../common/crypto';
import { createCustomer, createRequest, fetchBytes, pngBytes, uploadDocument } from '../documents/fixtures';
import { StorageService } from '../storage/storage.service';
import { createInvoice, createPayment } from './fixtures';

const DAY = 86400_000;

describe('Privacy: data subject requests, retention, consent overview, incident and processor registers', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let manager: Actor; // staff WITHOUT privacy.manage
  let receptionist: Actor;

  beforeAll(async () => {
    t = await TestApp.create();
    alpha = await t.createTenant({ name: 'Alpha Typing' });
    beta = await t.createTenant({ name: 'Beta Typing' });
    manager = await t.addStaff(alpha, 'manager');
    receptionist = await t.addStaff(alpha, 'receptionist');
  });
  afterAll(() => t.close());

  const approve = async (id: string, owner: Actor = alpha.owner) => t.as(owner).post(`/privacy/requests/${id}/decision`, { decision: 'APPROVED', decisionNote: 'Identity checked at the counter.' }).expect(200);

  describe('retention policies', () => {
    it('gives a new centre starting policies and says which ones the platform enforces', async () => {
      const res = await t.as(alpha.owner).get('/privacy/retention-policies').expect(200);
      expect(res.body.map((p: any) => [p.entity, p.documentTypeKey, p.retainDays, p.action, p.isActive, p.enforced])).toEqual([
        ['CUSTOMER', null, 2555, 'ANONYMISE', false, false],
        ['DOCUMENT', 'data_export', 30, 'DELETE', true, true],
        ['DOCUMENT', null, 1825, 'DELETE', true, true],
        ['NOTIFICATION', null, 365, 'DELETE', false, false],
        ['SUPPORT_TICKET', null, 730, 'DELETE', false, false],
      ]);
      expect(res.body.every((p: any) => p.tenantId === alpha.id && /not legal advice/.test(p.legalBasisNote))).toBe(true);
    });

    it('lets the privacy officer add, change and remove policies, with validation', async () => {
      const created = await t.as(alpha.owner).post('/privacy/retention-policies', { entity: 'DOCUMENT', documentTypeKey: 'photo', retainDays: 90, legalBasisNote: 'Photos are only needed for the application.' }).expect(201);
      expect(created.body).toMatchObject({ entity: 'DOCUMENT', documentTypeKey: 'photo', retainDays: 90, action: 'DELETE', isActive: true, enforced: true });
      const dup = await t.as(alpha.owner).post('/privacy/retention-policies', { entity: 'DOCUMENT', documentTypeKey: 'photo', retainDays: 10 });
      expect(dup.status).toBe(409);
      expect(dup.body.code).toBe('POLICY_EXISTS');
      await t.as(alpha.owner).post('/privacy/retention-policies', { entity: 'DOCUMENT', documentTypeKey: 'passport', retainDays: 10, action: 'ANONYMISE' }).expect(400);
      await t.as(alpha.owner).post('/privacy/retention-policies', { entity: 'CUSTOMER', documentTypeKey: 'passport', retainDays: 10 }).expect(400);
      await t.as(alpha.owner).post('/privacy/retention-policies', { entity: 'INVOICE', retainDays: 10 }).expect(400);
      await t.as(alpha.owner).post('/privacy/retention-policies', { entity: 'DOCUMENT', documentTypeKey: 'certificate', retainDays: 0 }).expect(400);

      const updated = await t.as(alpha.owner).patch(`/privacy/retention-policies/${created.body.id}`, { retainDays: 120, isActive: false }).expect(200);
      expect(updated.body).toMatchObject({ retainDays: 120, isActive: false, enforced: false, updatedById: alpha.owner.userId });
      const invalid = await t.as(alpha.owner).patch(`/privacy/retention-policies/${created.body.id}`, { action: 'ANONYMISE' });
      expect(invalid.status).toBe(422);
      await t.as(alpha.owner).patch(`/privacy/retention-policies/${created.body.id}`, {}).expect(400);
      expect(await t.sys.auditLog.count({ where: { tenantId: alpha.id, resourceId: created.body.id, action: { startsWith: 'privacy.retention_policy' } } })).toBe(2);

      // Another centre cannot touch it; staff without privacy.manage cannot see it.
      await t.as(beta.owner).patch(`/privacy/retention-policies/${created.body.id}`, { retainDays: 1 }).expect(404);
      await t.as(beta.owner).delete(`/privacy/retention-policies/${created.body.id}`).expect(404);
      expect((await t.as(beta.owner).get('/privacy/retention-policies').expect(200)).body.every((p: any) => p.tenantId === beta.id)).toBe(true);
      await t.as(manager).get('/privacy/retention-policies').expect(403);
      await t.as(manager).post('/privacy/retention-policies', { entity: 'DOCUMENT', documentTypeKey: 'other', retainDays: 5 }).expect(403);
      await t.as(receptionist).delete(`/privacy/retention-policies/${created.body.id}`).expect(403);

      await t.as(alpha.owner).delete(`/privacy/retention-policies/${created.body.id}`).expect(200);
      await t.as(alpha.owner).delete(`/privacy/retention-policies/${created.body.id}`).expect(404);
      expect((await t.sys.dataRetentionPolicy.findMany({ where: { tenantId: alpha.id } })).length).toBe(5);
    });
  });

  describe('data subject requests: filing and deciding', () => {
    let ahmed: Actor;
    let sara: Actor;
    beforeAll(async () => {
      ahmed = await t.addCustomer(alpha, { fullName: 'Ahmed Example' });
      sara = await t.addCustomer(alpha, { fullName: 'Sara Example' });
    });

    it('customers file requests for themselves only, due in 30 days', async () => {
      const res = await t.as(ahmed).post('/privacy/my/requests', { type: 'CORRECTION', details: 'My date of birth is wrong.' }).expect(201);
      expect(res.body).toMatchObject({ type: 'CORRECTION', status: 'RECEIVED', customerId: ahmed.customerId, details: 'My date of birth is wrong.', overdue: false, exportDocumentId: null });
      expect(res.body).not.toHaveProperty('handledById');
      const due = new Date(res.body.dueAt).getTime();
      expect(Math.abs(due - (Date.now() + 30 * DAY))).toBeLessThan(60_000);
      // One open request per kind.
      const again = await t.as(ahmed).post('/privacy/my/requests', { type: 'CORRECTION' });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('REQUEST_ALREADY_OPEN');
      await t.as(ahmed).post('/privacy/my/requests', { type: 'EXPORT' }).expect(201);
      await t.as(ahmed).post('/privacy/my/requests', { type: 'FORGET_ME' }).expect(400);
      // A customer id in the body is ignored: the request is always for the caller.
      const forged = await t.as(sara).post('/privacy/my/requests', { type: 'ACCESS', customerId: ahmed.customerId }).expect(201);
      expect(forged.body.customerId).toBe(sara.customerId);

      expect((await t.as(ahmed).get('/privacy/my/requests').expect(200)).body.map((r: any) => r.type).sort()).toEqual(['CORRECTION', 'EXPORT']);
      await t.as(ahmed).get(`/privacy/my/requests/${res.body.id}`).expect(200);
      await t.as(sara).get(`/privacy/my/requests/${res.body.id}`).expect(404);
      // Customers have no access to the staff side, staff without the permission neither.
      await t.as(ahmed).get('/privacy/requests').expect(403);
      await t.as(ahmed).post(`/privacy/requests/${res.body.id}/decision`, { decision: 'APPROVED', decisionNote: 'approve myself' }).expect(403);
      await t.as(ahmed).get('/privacy/overview').expect(403);
      await t.as(manager).get('/privacy/requests').expect(403);
      await t.as(receptionist).post(`/privacy/requests/${res.body.id}/complete`, {}).expect(403);
      // Staff are not data subjects here.
      await t.as(alpha.owner).post('/privacy/my/requests', { type: 'ACCESS' }).expect(403);
      await t.as(null).post('/privacy/my/requests', { type: 'ACCESS' }).expect(401);
      expect(await t.sys.auditLog.count({ where: { tenantId: alpha.id, action: 'privacy.request_received', resourceId: res.body.id } })).toBe(1);
    });

    it('staff review, approve or reject with a note; nothing is completed before a decision', async () => {
      const list = await t.as(alpha.owner).get(`/privacy/requests?customerId=${ahmed.customerId}&type=CORRECTION`).expect(200);
      expect(list.body.meta.total).toBe(1);
      const id = list.body.data[0].id;
      expect(list.body.data[0].customer).toMatchObject({ id: ahmed.customerId, fullName: 'Ahmed Example' });

      const early = await t.as(alpha.owner).post(`/privacy/requests/${id}/complete`, { note: 'done' });
      expect(early.status).toBe(409);
      expect(early.body.code).toBe('NOT_APPROVED');
      expect((await t.as(alpha.owner).post(`/privacy/requests/${id}/review`).expect(200)).body).toMatchObject({ status: 'IN_REVIEW', handledById: alpha.owner.userId });
      await t.as(alpha.owner).post(`/privacy/requests/${id}/review`).expect(409);
      await t.as(alpha.owner).post(`/privacy/requests/${id}/decision`, { decision: 'APPROVED' }).expect(400); // a note is mandatory
      await t.as(alpha.owner).post(`/privacy/requests/${id}/decision`, { decision: 'MAYBE', decisionNote: 'not sure' }).expect(400);
      await approve(id);
      await t.as(alpha.owner).post(`/privacy/requests/${id}/decision`, { decision: 'REJECTED', decisionNote: 'changed my mind' }).expect(409);
      // A correction is made in the customer record by staff; completing needs a note saying what was done.
      expect((await t.as(alpha.owner).post(`/privacy/requests/${id}/complete`, {})).body.code).toBe('NOTE_REQUIRED');
      const done = await t.as(alpha.owner).post(`/privacy/requests/${id}/complete`, { note: 'Date of birth corrected from the passport.' }).expect(200);
      expect(done.body).toMatchObject({ status: 'COMPLETED', decisionNote: 'Identity checked at the counter.\n\nCompletion: Date of birth corrected from the passport.' });
      expect(done.body.completedAt).not.toBeNull();
      // The customer can see the outcome; completing twice is harmless.
      expect((await t.as(ahmed).get(`/privacy/my/requests/${id}`).expect(200)).body).toMatchObject({ status: 'COMPLETED' });
      await t.as(alpha.owner).post(`/privacy/requests/${id}/complete`, { note: 'again' }).expect(200);

      // Rejection closes the request with the reason.
      const sarasId = (await t.as(alpha.owner).get(`/privacy/requests?customerId=${sara.customerId}`).expect(200)).body.data[0].id;
      const rejected = await t.as(alpha.owner).post(`/privacy/requests/${sarasId}/decision`, { decision: 'REJECTED', decisionNote: 'Identity could not be confirmed.' }).expect(200);
      expect(rejected.body).toMatchObject({ status: 'REJECTED', decisionNote: 'Identity could not be confirmed.' });
      expect((await t.as(alpha.owner).post(`/privacy/requests/${sarasId}/complete`, {})).status).toBe(409);
      expect(await t.sys.auditLog.count({ where: { tenantId: alpha.id, action: { in: ['privacy.request_in_review', 'privacy.request_approved', 'privacy.request_completed', 'privacy.request_rejected'] } } })).toBe(4);
    });

    it('staff can record a request received by another channel; overdue requests are flagged; tenants are isolated', async () => {
      const walkIn = await createCustomer(t, alpha);
      const res = await t.as(alpha.owner).post('/privacy/requests', { customerId: walkIn.id, type: 'ACCESS', details: 'Asked at the counter.' }).expect(201);
      expect(res.body).toMatchObject({ status: 'RECEIVED', requestedByUserId: alpha.owner.userId });
      await t.as(alpha.owner).post('/privacy/requests', { customerId: walkIn.id, type: 'DELETION', dueAt: '2020-01-01' }).expect(422);
      await t.as(beta.owner).post('/privacy/requests', { customerId: walkIn.id, type: 'ACCESS' }).expect(404);
      await t.as(beta.owner).get(`/privacy/requests/${res.body.id}`).expect(404);
      await t.as(beta.owner).post(`/privacy/requests/${res.body.id}/decision`, { decision: 'APPROVED', decisionNote: 'not my tenant' }).expect(404);
      await t.as(beta.owner).post(`/privacy/requests/${res.body.id}/complete`, {}).expect(404);
      expect((await t.as(beta.owner).get('/privacy/requests').expect(200)).body.data).toEqual([]);

      await t.sys.dataSubjectRequest.update({ where: { id: res.body.id }, data: { dueAt: new Date(Date.now() - DAY) } });
      const overdue = await t.as(alpha.owner).get('/privacy/requests?overdue=true').expect(200);
      expect(overdue.body.data.map((r: any) => [r.id, r.overdue])).toEqual([[res.body.id, true]]);
      const seen = await t.inTenant(beta.id, () => t.db.tx((tx) => tx.dataSubjectRequest.count()));
      expect(seen).toBe(0);
    });
  });

  describe('export of personal data', () => {
    it('builds a JSON export in the vault that only the customer and privacy staff can reach', async () => {
      const customer = await t.addCustomer(alpha, { fullName: 'Export Person' });
      const other = await t.addCustomer(alpha);
      const customerId = customer.customerId!;
      const eid = '784199012345671';
      await t.sys.customer.update({
        where: { id: customerId },
        data: {
          nationality: 'IND', dateOfBirth: new Date('1990-02-14'), phone: '+971501112223',
          emiratesIdEnc: encryptText(eid), emiratesIdHash: blindIndex(alpha.id, 'emiratesId', eid), emiratesIdLast4: last4(eid),
          passportNoEnc: encryptText('Z1234567'), passportNoHash: blindIndex(alpha.id, 'passport', 'Z1234567'), passportNoLast4: '4567',
        },
      });
      await t.sys.customerContact.create({ data: { tenantId: alpha.id, customerId, type: 'PHONE', value: '+971509998887', label: 'Work' } });
      await t.sys.customerNote.create({ data: { tenantId: alpha.id, customerId, body: 'INTERNAL-NOTE-DO-NOT-EXPORT', authorId: alpha.owner.userId } });
      const request = await createRequest(t, alpha, customerId, { status: 'COMPLETED', completedAt: new Date() });
      await t.sys.requestField.create({ data: { tenantId: alpha.id, requestId: request.id, key: 'sponsorName', value: 'Sample Sponsor LLC', source: 'CUSTOMER' } });
      const visible = await uploadDocument(t, alpha.owner, { customerId, title: 'Passport copy' }, { content: pngBytes(), mime: 'image/png', filename: 'passport.png' });
      await uploadDocument(t, alpha.owner, { customerId, title: 'Internal checklist scan', customerVisible: false });
      const invoice = await createInvoice(t, alpha, customerId, { total: 150, paid: 150 });
      const payment = await createPayment(t, alpha, customerId, 150);

      const filed = await t.as(customer).post('/privacy/my/requests', { type: 'EXPORT' }).expect(201);
      await approve(filed.body.id);
      const done = await t.as(alpha.owner).post(`/privacy/requests/${filed.body.id}/complete`, {}).expect(200);
      expect(done.body).toMatchObject({ status: 'COMPLETED', retentionException: null });
      const exportId = done.body.exportDocumentId;
      expect(exportId).toEqual(expect.any(String));

      // The customer finds it among their documents and downloads it through a short-lived link.
      const mine = await t.as(customer).get('/documents?type=data_export').expect(200);
      expect(mine.body.data.map((d: any) => d.id)).toEqual([exportId]);
      const link = await t.as(customer).post(`/documents/${exportId}/download-link`).expect(200);
      expect(link.body).toMatchObject({ mime: 'application/json', disposition: 'attachment' });
      expect(link.body.filename).toMatch(/^personal-data-export-CUS-.*\.json$/);
      const file = await fetchBytes(t, link.body.url);
      const data = JSON.parse(file.body.toString('utf8'));
      expect(data.meta).toMatchObject({ format: 'typease.personal-data-export/v1', privacyRequestId: filed.body.id, requestType: 'EXPORT' });
      expect(data.profile).toMatchObject({ fullName: 'Export Person', nationality: 'IND', dateOfBirth: '1990-02-14', emiratesId: eid, passportNo: 'Z1234567', phone: '+971501112223' });
      expect(data.contacts).toEqual([{ type: 'PHONE', value: '+971509998887', label: 'Work', isPrimary: false }]);
      expect(data.consents.current.map((c: any) => c.purpose).sort()).toEqual(['MARKETING', 'SERVICE_PROCESSING']);
      expect(data.consents.history.length).toBeGreaterThanOrEqual(2);
      expect(data.requests).toEqual([expect.objectContaining({ requestNo: request.requestNo, status: 'COMPLETED', formData: [{ key: 'sponsorName', value: 'Sample Sponsor LLC', source: 'CUSTOMER' }] })]);
      expect(data.documents).toEqual([expect.objectContaining({ id: visible.documentId, title: 'Passport copy', files: [expect.objectContaining({ filename: 'passport.png', mime: 'image/png' })] })]);
      expect(data.invoices).toEqual([expect.objectContaining({ invoiceNo: invoice.invoiceNo, total: '150.00', balanceDue: '0.00', status: 'PAID' })]);
      expect(data.payments).toEqual([expect.objectContaining({ paymentNo: payment.paymentNo, amount: '150.00', method: 'CASH' })]);
      // Internal material and storage details stay out.
      const text = file.body.toString('utf8');
      expect(text).not.toMatch(/INTERNAL-NOTE-DO-NOT-EXPORT|Internal checklist scan|storageKey|passwordHash/);
      expect(data.meta.notes.join(' ')).toMatch(/1 internal working document/);
      expect(text).not.toContain((await t.sys.documentVersion.findFirstOrThrow({ where: { documentId: visible.documentId } })).storageKey);

      // At rest the export is encrypted like every other file; other customers cannot reach it.
      const key = (await t.sys.documentVersion.findFirstOrThrow({ where: { documentId: exportId } })).storageKey;
      const raw = readFileSync(join(t.get(StorageService).local!.root, `${key}.obj`));
      expect(raw.includes(Buffer.from(eid))).toBe(false);
      await t.as(other).post(`/documents/${exportId}/download-link`).expect(404);
      await t.as(beta.owner).get(`/documents/${exportId}`).expect(404);
      // The audit trail records that an export with identity numbers was made, without the numbers.
      const audit = await t.sys.auditLog.findFirstOrThrow({ where: { tenantId: alpha.id, action: 'privacy.export_generated', resourceId: customerId } });
      expect(JSON.stringify(audit)).not.toMatch(/784199012345671|Z1234567/);
      expect((audit.after as any).documentId).toBe(exportId);
      // The default 30-day policy for exports removes the file automatically.
      await t.sys.document.update({ where: { id: exportId }, data: { createdAt: new Date(Date.now() - 31 * DAY) } });
      await t.jobs.runScheduled('documents.purge');
      expect(await t.get(StorageService).head(key)).toBeNull();
      await t.as(customer).post(`/documents/${exportId}/download-link`).expect(404);

      // An ACCESS request is answered the same way.
      const access = await t.as(alpha.owner).post('/privacy/requests', { customerId, type: 'ACCESS' }).expect(201);
      await approve(access.body.id);
      const answered = await t.as(alpha.owner).post(`/privacy/requests/${access.body.id}/complete`, {}).expect(200);
      expect(answered.body.exportDocumentId).not.toBe(exportId);
    });
  });

  describe('deletion (erasure) subject to what must be kept', () => {
    let customer: Actor;
    let customerId: string;
    let dsrId: string;
    let openRequestId: string;
    let unpaidInvoiceId: string;
    let docs: { normal: string; held: string; normalKey: string; heldKey: string };
    let paid: { invoiceId: string; paymentId: string };

    beforeAll(async () => {
      customer = await t.addCustomer(alpha, { fullName: 'Forget Me Please' });
      customerId = customer.customerId!;
      await t.sys.customer.update({
        where: { id: customerId },
        data: {
          phone: '+971507776665', nationality: 'PHL', dateOfBirth: new Date('1988-03-03'), address: { line1: 'Sample street 1', city: 'Dubai' },
          emiratesIdEnc: encryptText('784198812345678'), emiratesIdHash: blindIndex(alpha.id, 'emiratesId', '784198812345678'), emiratesIdLast4: '5678',
          passportNoEnc: encryptText('P7654321'), passportNoHash: blindIndex(alpha.id, 'passport', 'P7654321'), passportNoLast4: '4321', marketingOptIn: true,
        },
      });
      await t.sys.customerContact.create({ data: { tenantId: alpha.id, customerId, type: 'EMAIL', value: 'alt@example.test' } });
      await t.sys.customerNote.create({ data: { tenantId: alpha.id, customerId, body: 'Prefers to be called after 5 pm.', authorId: alpha.owner.userId } });
      const open = await createRequest(t, alpha, customerId, { status: 'IN_PREPARATION' });
      openRequestId = open.id;
      await createRequest(t, alpha, customerId, { status: 'COMPLETED', completedAt: new Date() });
      const normal = await uploadDocument(t, alpha.owner, { customerId, title: 'Passport of Forget Me Please' });
      const held = await uploadDocument(t, alpha.owner, { customerId, title: 'Disputed contract' });
      await t.as(alpha.owner).put(`/documents/${held.documentId}/legal-hold`, { legalHold: true, reason: 'Open dispute' }).expect(200);
      const key = async (versionId: string) => (await t.sys.documentVersion.findUniqueOrThrow({ where: { id: versionId } })).storageKey;
      docs = { normal: normal.documentId, held: held.documentId, normalKey: await key(normal.versionId), heldKey: await key(held.versionId) };
      await t.sys.ocrExtractionResult.create({ data: { tenantId: alpha.id, documentId: normal.documentId, versionId: normal.versionId, provider: 'test', profile: 'PASSPORT', status: 'COMPLETED', fields: [{ key: 'fullName', value: 'FORGET ME PLEASE', confidence: 0.9, source: 'MRZ' }] } });
      const paidInvoice = await createInvoice(t, alpha, customerId, { total: 200, paid: 200 });
      const payment = await createPayment(t, alpha, customerId, 200);
      paid = { invoiceId: paidInvoice.id, paymentId: payment.id };
      unpaidInvoiceId = (await createInvoice(t, alpha, customerId, { total: 80, paid: 0 })).id;
      dsrId = (await t.as(customer).post('/privacy/my/requests', { type: 'DELETION', details: 'Please delete everything.' }).expect(201)).body.id;
    });

    it('shows staff what stands in the way before they decide', async () => {
      const res = await t.as(alpha.owner).get(`/privacy/requests/${dsrId}`).expect(200);
      expect(res.body.erasureImpact).toEqual({ openRequests: 1, unpaidInvoices: 1, closedRequests: 1, invoices: 2, payments: 1, documents: 2, heldDocuments: 1, canProceed: false });
    });

    it('refuses while a request is open or an invoice is unpaid, and records why', async () => {
      await approve(dsrId);
      const blocked = await t.as(alpha.owner).post(`/privacy/requests/${dsrId}/complete`, {});
      expect(blocked.status).toBe(409);
      expect(blocked.body.code).toBe('ERASURE_BLOCKED');
      // The message and the details name what is in the way, so staff know which request and which invoice to deal with.
      const openRequest = await t.sys.serviceRequest.findUniqueOrThrow({ where: { id: openRequestId } });
      const unpaidInvoice = await t.sys.invoice.findUniqueOrThrow({ where: { id: unpaidInvoiceId } });
      expect(blocked.body.message).toBe(
        `The data cannot be deleted yet: 1 service request(s) are still open (${openRequest.requestNo}) and 1 invoice(s) are unpaid (${unpaidInvoice.invoiceNo}). ` +
          'Close or cancel the requests and settle or void the invoices, then complete this request again.',
      );
      expect(blocked.body.details).toMatchObject({
        openRequests: 1, unpaidInvoices: 1,
        blocking: { requests: [{ id: openRequestId, requestNo: openRequest.requestNo, status: 'IN_PREPARATION' }], invoices: [{ id: unpaidInvoiceId, invoiceNo: unpaidInvoice.invoiceNo, balanceDue: '80.00', currency: 'AED' }] },
      });
      // Nothing was erased; the reason is stored on the request and visible to the customer.
      const row = await t.sys.dataSubjectRequest.findUniqueOrThrow({ where: { id: dsrId } });
      expect(row.status).toBe('APPROVED');
      expect(row.retentionException).toMatch(/cannot be deleted yet/);
      expect((await t.as(customer).get(`/privacy/my/requests/${dsrId}`).expect(200)).body.retentionException).toMatch(/still open/);
      expect(await t.sys.customer.findUniqueOrThrow({ where: { id: customerId } })).toMatchObject({ status: 'ACTIVE', fullName: 'Forget Me Please', passportNoLast4: '4321' });
      expect((await t.sys.document.findUniqueOrThrow({ where: { id: docs.normal } })).status).toBe('AVAILABLE');
      expect(await t.sys.auditLog.count({ where: { tenantId: alpha.id, action: 'privacy.erasure_blocked', resourceId: dsrId } })).toBe(1);

      // Only the open request resolved: still blocked by the unpaid invoice.
      await t.sys.serviceRequest.update({ where: { id: openRequestId }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
      const still = await t.as(alpha.owner).post(`/privacy/requests/${dsrId}/complete`, {});
      expect(still.status).toBe(409);
      expect(still.body.message).toMatch(/1 invoice\(s\) are unpaid/);
      expect(still.body.message).not.toMatch(/service request/);
    });

    it('anonymises the customer, deletes their documents, removes portal access and keeps financial records intact', async () => {
      await t.sys.invoice.update({ where: { id: unpaidInvoiceId }, data: { amountPaid: 80, balanceDue: 0, status: 'PAID' } });
      const before = { invoice: await t.sys.invoice.findUniqueOrThrow({ where: { id: paid.invoiceId } }), payment: await t.sys.payment.findUniqueOrThrow({ where: { id: paid.paymentId } }) };
      await t.as(customer).get('/documents').expect(200);

      const done = await t.as(alpha.owner).post(`/privacy/requests/${dsrId}/complete`, { note: 'Customer informed by email.' }).expect(200);
      expect(done.body.status).toBe('COMPLETED');
      expect(done.body.retentionException).toBe(
        'Retained: 2 issued invoice(s) and 1 payment record(s) are kept unchanged because financial records are immutable; they remain linked to the anonymised customer record; ' +
          '2 closed service request(s) are kept as business records, without the submitted form data, instructions, comments and messages; ' +
          '1 document(s) are kept because they are under legal hold, a fixed retention date or used by another open request.',
      );

      const c = await t.sys.customer.findUniqueOrThrow({ where: { id: customerId } });
      expect(c).toMatchObject({
        status: 'ANONYMISED', fullName: 'Erased customer', fullNameAr: null, email: null, phone: null, nationality: null, dateOfBirth: null, address: null,
        emiratesIdEnc: null, emiratesIdHash: null, emiratesIdLast4: null, emiratesIdExpiry: null, passportNoEnc: null, passportNoHash: null, passportNoLast4: null, passportCountry: null, passportExpiry: null,
        marketingOptIn: false, communicationPrefs: { email: false, sms: false, whatsapp: false, push: false },
      });
      expect(c.deletedAt).not.toBeNull();
      expect(await t.sys.customerContact.count({ where: { customerId } })).toBe(0);
      expect(await t.sys.customerNote.count({ where: { customerId } })).toBe(0);
      // Portal access is gone at once: the membership no longer exists and the old token is refused.
      expect(await t.sys.tenantMembership.count({ where: { tenantId: alpha.id, customerId } })).toBe(0);
      expect(await t.sys.tenantMembership.count({ where: { tenantId: alpha.id, userId: customer.userId } })).toBe(0);
      await t.as(customer).get('/documents').expect(401);
      await t.as(customer).get('/privacy/my/requests').expect(401);

      // Documents: deleted (title scrubbed, share links revoked, extraction results removed) except the one under legal hold.
      expect(await t.sys.document.findUniqueOrThrow({ where: { id: docs.normal } })).toMatchObject({ status: 'DELETED', title: 'Erased document' });
      expect(await t.sys.document.findUniqueOrThrow({ where: { id: docs.held } })).toMatchObject({ status: 'AVAILABLE', title: 'Disputed contract', legalHold: true });
      expect(await t.sys.ocrExtractionResult.count({ where: { documentId: docs.normal } })).toBe(0);
      await t.as(alpha.owner).post(`/documents/${docs.normal}/download-link`).expect(404);
      const storage = t.get(StorageService);
      expect(await storage.head(docs.normalKey)).not.toBeNull();
      await t.jobs.runScheduled('documents.purge'); // no grace period for an erasure
      expect(await storage.head(docs.normalKey)).toBeNull();
      expect(await storage.head(docs.heldKey)).not.toBeNull();
      expect((await t.as(alpha.owner).post(`/documents/${docs.normal}/restore`)).body.code).toBe('DOCUMENT_PURGED');

      // Financial records are untouched and still point at the (now anonymous) customer record.
      expect(await t.sys.invoice.findUniqueOrThrow({ where: { id: paid.invoiceId } })).toEqual(before.invoice);
      expect(await t.sys.payment.findUniqueOrThrow({ where: { id: paid.paymentId } })).toEqual(before.payment);
      expect(await t.sys.serviceRequest.count({ where: { customerId } })).toBe(2);

      const audit = await t.sys.auditLog.findFirstOrThrow({ where: { tenantId: alpha.id, action: 'privacy.customer_anonymised', resourceId: customerId } });
      expect(audit.after).toMatchObject({ deletedDocuments: 1, keptDocuments: 1, invoices: 2, payments: 1 });
      expect(JSON.stringify(audit)).not.toMatch(/Forget Me Please|P7654321|784198812345678/);
      // Repeating the completion changes nothing; new requests for an anonymised record are refused.
      await t.as(alpha.owner).post(`/privacy/requests/${dsrId}/complete`, {}).expect(200);
      const more = await t.as(alpha.owner).post('/privacy/requests', { customerId, type: 'EXPORT' });
      expect(more.status).toBe(409);
      expect(more.body.code).toBe('CUSTOMER_ERASED');
      // Nothing can be uploaded for the anonymised record any more (staff can still open the stub, so the answer is 409, not 404).
      const upload = await t.as(alpha.owner).post('/documents/upload-intents', { customerId, documentTypeKey: 'passport', filename: 'a.pdf', mime: 'application/pdf', sizeBytes: 10 });
      expect([upload.status, upload.body.code]).toEqual([409, 'CUSTOMER_ERASED']);
    });

    it('erases completely when nothing has to be kept', async () => {
      const simple = await t.addCustomer(alpha, { fullName: 'Nothing To Keep' });
      const doc = await uploadDocument(t, simple, {});
      // A document deleted last week is still inside its 30-day restore window.
      const earlier = await uploadDocument(t, simple, {});
      await t.as(alpha.owner).delete(`/documents/${earlier.documentId}`).expect(200);
      expect((await t.sys.document.findUniqueOrThrow({ where: { id: earlier.documentId } })).purgeAfter!.getTime()).toBeGreaterThan(Date.now() + 20 * DAY);
      const id = (await t.as(simple).post('/privacy/my/requests', { type: 'DELETION' }).expect(201)).body.id;
      expect((await t.as(alpha.owner).get(`/privacy/requests/${id}`).expect(200)).body.erasureImpact).toMatchObject({ canProceed: true, documents: 1, invoices: 0 });
      await approve(id);
      const done = await t.as(alpha.owner).post(`/privacy/requests/${id}/complete`, {}).expect(200);
      expect(done.body).toMatchObject({ status: 'COMPLETED', retentionException: null });
      expect((await t.sys.customer.findUniqueOrThrow({ where: { id: simple.customerId! } })).status).toBe('ANONYMISED');
      expect((await t.sys.document.findUniqueOrThrow({ where: { id: doc.documentId } })).status).toBe('DELETED');
      // The restore window of the earlier deletion is cut short: both files go with the next purge run.
      expect(await t.sys.document.findUniqueOrThrow({ where: { id: earlier.documentId } })).toMatchObject({ status: 'DELETED', title: 'Erased document' });
      await t.jobs.runScheduled('documents.purge');
      for (const d of [doc, earlier]) expect((await t.sys.documentVersion.findUniqueOrThrow({ where: { id: d.versionId } })).uploadStatus).toBe('PURGED');
      await t.as(simple).get('/documents').expect(401);
    });
  });

  describe('consent overview (read only)', () => {
    it('shows current consent per purpose with statistics, and the history of one customer', async () => {
      const tenant = await t.createTenant();
      const a = await t.addCustomer(tenant); // SERVICE_PROCESSING granted, MARKETING withdrawn (not opted in)
      const b = await createCustomer(t, tenant);
      await t.sys.customerConsent.createMany({
        data: [
          { tenantId: tenant.id, customerId: b.id, purpose: 'MARKETING', status: 'GRANTED', grantedAt: new Date() },
          { tenantId: tenant.id, customerId: b.id, purpose: 'AI_PROCESSING', status: 'WITHDRAWN', withdrawnAt: new Date() },
        ],
      });
      const res = await t.as(tenant.owner).get('/privacy/consents').expect(200);
      expect(res.body.meta.total).toBe(4);
      expect(res.body.statistics).toEqual([
        { purpose: 'AI_PROCESSING', granted: 0, withdrawn: 1 },
        { purpose: 'MARKETING', granted: 1, withdrawn: 1 },
        { purpose: 'SERVICE_PROCESSING', granted: 1, withdrawn: 0 },
      ]);
      expect(res.body.data[0].customer).toEqual(expect.objectContaining({ id: expect.any(String), fullName: expect.any(String) }));
      const filtered = await t.as(tenant.owner).get(`/privacy/consents?purpose=MARKETING&status=GRANTED`).expect(200);
      expect(filtered.body.data.map((c: any) => c.customerId)).toEqual([b.id]);
      const history = await t.as(tenant.owner).get(`/privacy/consents/customers/${a.customerId}/history`).expect(200);
      expect(history.body.map((h: any) => h.purpose).sort()).toEqual(['MARKETING', 'SERVICE_PROCESSING']);
      expect(history.body[0]).toMatchObject({ capturedVia: 'PORTAL' });
      // Another centre sees nothing of it, and staff without privacy.manage have no access.
      expect((await t.as(alpha.owner).get(`/privacy/consents?customerId=${b.id}`).expect(200)).body.data).toEqual([]);
      // The history of a customer of another centre, or of nobody, is "not found" - not an empty history.
      expect((await t.as(alpha.owner).get(`/privacy/consents/customers/${a.customerId}/history`).expect(404)).body.code).toBe('NOT_FOUND');
      await t.as(tenant.owner).get('/privacy/consents/customers/6f1c2f0e-3a55-4c56-9a39-0d1f0a5a7e11/history').expect(404);
      await t.as(tenant.owner).get('/privacy/consents/customers/not-a-uuid/history').expect(400);
      // A customer of this centre without any recorded decision: an empty history, with 200.
      const silent = await t.sys.customer.create({ data: { tenantId: tenant.id, customerNo: `CUS-S${Date.now()}`.slice(0, 20), fullName: 'No Decisions Yet' } });
      expect((await t.as(tenant.owner).get(`/privacy/consents/customers/${silent.id}/history`).expect(200)).body).toEqual([]);
      await t.as(manager).get('/privacy/consents').expect(403);
    });
  });

  describe('incident register', () => {
    it('follows OPEN -> INVESTIGATING -> CONTAINED -> RESOLVED and records the notification decisions', async () => {
      const created = await t
        .as(alpha.owner)
        .post('/privacy/incidents', { title: 'Passport copies emailed to the wrong address', description: 'A receptionist sent two scans to a mistyped email address.', severity: 'HIGH', personalDataInvolved: true, affectedData: 'Two passport copies' })
        .expect(201);
      const id = created.body.id;
      expect(created.body).toMatchObject({ status: 'OPEN', severity: 'HIGH', tenantId: alpha.id, reportedById: alpha.owner.userId, notificationRequired: null, resolvedAt: null });
      await t.as(alpha.owner).post('/privacy/incidents', { title: 'x', description: 'too short' }).expect(400);

      const move = (status: string, extra: Record<string, unknown> = {}) => t.as(alpha.owner).post(`/privacy/incidents/${id}/status`, { status, ...extra });
      // No skipping.
      for (const illegal of ['CONTAINED', 'RESOLVED']) {
        const res = await move(illegal);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('INVALID_TRANSITION');
        expect(res.body.details.allowed).toEqual(['INVESTIGATING']);
      }
      await move('INVESTIGATING').expect(200);
      expect((await move('RESOLVED')).status).toBe(409);
      expect((await move('OPEN')).status).toBe(409);
      await move('CONTAINED').expect(200);

      // Resolving needs: resolution notes, a notification decision (personal data), and the recorded notification.
      expect((await move('RESOLVED')).body.code).toBe('RESOLUTION_NOTES_REQUIRED');
      expect((await move('RESOLVED', { resolutionNotes: 'Recipient confirmed deletion.' })).body.code).toBe('NOTIFICATION_DECISION_REQUIRED');
      await t.as(alpha.owner).patch(`/privacy/incidents/${id}`, { notificationRequired: true }).expect(200);
      expect((await move('RESOLVED', { resolutionNotes: 'Recipient confirmed deletion.' })).body.code).toBe('NOTIFICATION_NOT_RECORDED');
      const future = await t.as(alpha.owner).patch(`/privacy/incidents/${id}`, { authorityNotifiedAt: new Date(Date.now() + DAY).toISOString() });
      expect(future.status).toBe(422);
      const notified = new Date(Date.now() - 3600_000).toISOString();
      const patched = await t.as(alpha.owner).patch(`/privacy/incidents/${id}`, { authorityNotifiedAt: notified, individualsNotifiedAt: notified }).expect(200);
      expect(patched.body).toMatchObject({ authorityNotifiedAt: notified, individualsNotifiedAt: notified, status: 'CONTAINED' });
      const resolved = await move('RESOLVED', { resolutionNotes: 'Recipient confirmed deletion. Staff retrained.' }).expect(200);
      expect(resolved.body).toMatchObject({ status: 'RESOLVED', resolutionNotes: 'Recipient confirmed deletion. Staff retrained.' });
      expect(resolved.body.resolvedAt).not.toBeNull();
      // Reopening clears the resolution time.
      const reopened = await move('INVESTIGATING').expect(200);
      expect(reopened.body).toMatchObject({ status: 'INVESTIGATING', resolvedAt: null });

      const audit = await t.sys.auditLog.findMany({ where: { tenantId: alpha.id, resourceType: 'SecurityIncident', resourceId: id }, orderBy: { createdAt: 'asc' } });
      expect(audit.map((a) => a.action)).toEqual([
        'privacy.incident_reported', 'privacy.incident_status_changed', 'privacy.incident_status_changed', 'privacy.incident_updated', 'privacy.incident_updated',
        'privacy.incident_status_changed', 'privacy.incident_status_changed',
      ]);
      const list = await t.as(alpha.owner).get('/privacy/incidents?status=INVESTIGATING&severity=HIGH').expect(200);
      expect(list.body.data.map((i: any) => i.id)).toEqual([id]);
    });

    it('keeps each centre’s register private and separates it from the platform register', async () => {
      const mine = (await t.as(alpha.owner).post('/privacy/incidents', { title: 'Lost USB stick', description: 'A USB stick with scans was left in a taxi.' }).expect(201)).body;
      const b = t.as(beta.owner);
      await b.get(`/privacy/incidents/${mine.id}`).expect(404);
      await b.patch(`/privacy/incidents/${mine.id}`, { title: 'Hijacked title' }).expect(404);
      await b.post(`/privacy/incidents/${mine.id}/status`, { status: 'INVESTIGATING' }).expect(404);
      expect((await b.get('/privacy/incidents').expect(200)).body.data).toEqual([]);
      expect((await t.sys.securityIncident.findUniqueOrThrow({ where: { id: mine.id } })).title).toBe('Lost USB stick');
      await t.as(manager).get('/privacy/incidents').expect(403);
      await t.as(manager).post('/privacy/incidents', { title: 'Something', description: 'Manager cannot file here.' }).expect(403);
      await t.as(await t.addCustomer(alpha)).get('/privacy/incidents').expect(403);

      // Platform register: rows without a tenant, kept by platform staff.
      const admin = await t.createPlatformAdmin();
      const agent = await t.createPlatformAdmin('SUPPORT_AGENT');
      const platformIncident = (await t.as(admin).post('/platform/privacy/incidents', { title: 'Queue worker outage', description: 'Background jobs were delayed for two hours.', severity: 'LOW' }).expect(201)).body;
      expect(platformIncident.tenantId).toBeNull();
      const seen = await t.as(admin).get('/platform/privacy/incidents?pageSize=100').expect(200);
      expect(seen.body.data.map((i: any) => i.id)).toContain(platformIncident.id);
      expect(seen.body.data.every((i: any) => i.tenantId === null)).toBe(true); // never a centre's rows
      await t.as(admin).get(`/platform/privacy/incidents/${mine.id}`).expect(404);
      await t.as(admin).patch(`/platform/privacy/incidents/${mine.id}`, { title: 'Platform edit' }).expect(404);
      await t.as(admin).post(`/platform/privacy/incidents/${platformIncident.id}/status`, { status: 'INVESTIGATING' }).expect(200);
      // Centres cannot see or change platform rows, and cannot use the platform routes at all.
      await t.as(alpha.owner).get(`/privacy/incidents/${platformIncident.id}`).expect(404);
      await t.as(alpha.owner).post(`/privacy/incidents/${platformIncident.id}/status`, { status: 'CONTAINED' }).expect(404);
      expect((await t.as(alpha.owner).get('/privacy/incidents?pageSize=100').expect(200)).body.data.every((i: any) => i.tenantId === alpha.id)).toBe(true);
      await t.as(alpha.owner).get('/platform/privacy/incidents').expect(403);
      await t.as(alpha.owner).post('/platform/privacy/incidents', { title: 'Nope', description: 'A tenant cannot write here.' }).expect(403);
      // A support agent has neither platform.audit.read nor the manage permissions.
      await t.as(agent).get('/platform/privacy/incidents').expect(403);
      await t.as(agent).post('/platform/privacy/incidents', { title: 'Nope', description: 'An agent cannot write here.' }).expect(403);
      expect(await t.sys.auditLog.count({ where: { tenantId: null, action: 'privacy.incident_reported', resourceId: platformIncident.id } })).toBe(1);

      // The registers are out of reach of the tenant-scoped database role altogether.
      await expect(t.inTenant(alpha.id, () => t.db.tx((tx) => tx.securityIncident.count()))).rejects.toThrow(/permission denied/i);
      await expect(t.inTenant(alpha.id, () => t.db.tx((tx) => tx.processorRecord.count()))).rejects.toThrow(/permission denied/i);
    });
  });

  describe('processor / vendor register with cross-border review', () => {
    it('requires safeguards before a cross-border vendor can be approved and re-opens the review after a material change', async () => {
      const created = await t.as(alpha.owner).post('/privacy/processors', { name: 'Sample SMS Gateway Inc.', purpose: 'Sends appointment reminders by SMS', dataCategories: ['phone number', 'name'], country: 'us' }).expect(201);
      const id = created.body.id;
      expect(created.body).toMatchObject({ tenantId: alpha.id, country: 'US', crossBorder: true, status: 'PENDING_REVIEW', safeguards: null, reviewedAt: null });
      const local = await t.as(alpha.owner).post('/privacy/processors', { name: 'Local Print Shop LLC', purpose: 'Prints completed documents', dataCategories: ['documents'], country: 'AE' }).expect(201);
      expect(local.body.crossBorder).toBe(false);
      await t.as(alpha.owner).post('/privacy/processors', { name: 'X', purpose: 'p', dataCategories: [], country: 'United States' }).expect(400);

      const noSafeguards = await t.as(alpha.owner).post(`/privacy/processors/${id}/review`, { decision: 'APPROVED' });
      expect(noSafeguards.status).toBe(422);
      expect(noSafeguards.body.code).toBe('SAFEGUARDS_REQUIRED');
      const approved = await t.as(alpha.owner).post(`/privacy/processors/${id}/review`, { decision: 'APPROVED', safeguards: 'Data processing agreement with standard contractual clauses, signed 2026-01-10.' }).expect(200);
      expect(approved.body).toMatchObject({ status: 'APPROVED', reviewedById: alpha.owner.userId });
      expect(approved.body.reviewedAt).not.toBeNull();
      // A local vendor needs no transfer safeguards.
      await t.as(alpha.owner).post(`/privacy/processors/${local.body.id}/review`, { decision: 'APPROVED' }).expect(200);

      // Renaming does not undo the review; changing what data goes where does.
      expect((await t.as(alpha.owner).patch(`/privacy/processors/${id}`, { name: 'Sample SMS Gateway Ltd.' }).expect(200)).body.status).toBe('APPROVED');
      const changed = await t.as(alpha.owner).patch(`/privacy/processors/${id}`, { dataCategories: ['phone number', 'name', 'passport number'] }).expect(200);
      expect(changed.body).toMatchObject({ status: 'PENDING_REVIEW', reviewedById: null, reviewedAt: null });
      // Moving a local vendor abroad makes it cross-border and re-opens its review.
      const moved = await t.as(alpha.owner).patch(`/privacy/processors/${local.body.id}`, { country: 'IN' }).expect(200);
      expect(moved.body).toMatchObject({ country: 'IN', crossBorder: true, status: 'PENDING_REVIEW' });
      expect((await t.as(alpha.owner).post(`/privacy/processors/${id}/review`, { decision: 'REJECTED' }).expect(200)).body.status).toBe('REJECTED');

      const list = await t.as(alpha.owner).get('/privacy/processors?crossBorder=true').expect(200);
      expect(list.body.data.map((p: any) => p.name)).toEqual(['Local Print Shop LLC', 'Sample SMS Gateway Ltd.']);
      expect((await t.as(alpha.owner).get('/privacy/processors?status=REJECTED').expect(200)).body.data.map((p: any) => p.id)).toEqual([id]);

      // Isolation and permissions.
      await t.as(beta.owner).patch(`/privacy/processors/${id}`, { name: 'Hijacked' }).expect(404);
      await t.as(beta.owner).post(`/privacy/processors/${id}/review`, { decision: 'APPROVED', safeguards: 'x' }).expect(404);
      await t.as(beta.owner).delete(`/privacy/processors/${id}`).expect(404);
      expect((await t.as(beta.owner).get('/privacy/processors').expect(200)).body.data).toEqual([]);
      await t.as(manager).get('/privacy/processors').expect(403);
      const admin = await t.createPlatformAdmin();
      const platformVendor = (await t.as(admin).post('/platform/privacy/processors', { name: 'Sample Cloud Hosting', purpose: 'Hosts the platform', dataCategories: ['all customer data'], country: 'AE' }).expect(201)).body;
      expect(platformVendor.tenantId).toBeNull();
      expect((await t.as(admin).get('/platform/privacy/processors?pageSize=100').expect(200)).body.data.every((p: any) => p.tenantId === null)).toBe(true);
      await t.as(admin).patch(`/platform/privacy/processors/${id}`, { name: 'Platform edit' }).expect(404);
      await t.as(alpha.owner).patch(`/privacy/processors/${platformVendor.id}`, { name: 'Tenant edit' }).expect(404);
      await t.as(alpha.owner).delete(`/privacy/processors/${platformVendor.id}`).expect(404);
      await t.as(admin).delete(`/platform/privacy/processors/${platformVendor.id}`).expect(200);

      await t.as(alpha.owner).delete(`/privacy/processors/${id}`).expect(200);
      await t.as(alpha.owner).delete(`/privacy/processors/${id}`).expect(404);
      expect(await t.sys.auditLog.count({ where: { tenantId: alpha.id, resourceType: 'ProcessorRecord', resourceId: id } })).toBe(6);
    });
  });

  describe('overview', () => {
    it('summarises open and overdue requests, incidents, consents, retention and vendors for one centre', async () => {
      const tenant = await t.createTenant();
      const c1 = await t.addCustomer(tenant);
      const c2 = await t.addCustomer(tenant);
      await t.as(c1).post('/privacy/my/requests', { type: 'EXPORT' }).expect(201);
      const overdue = (await t.as(c2).post('/privacy/my/requests', { type: 'DELETION' }).expect(201)).body;
      await t.sys.dataSubjectRequest.update({ where: { id: overdue.id }, data: { dueAt: new Date(Date.now() - DAY) } });
      const closed = (await t.as(c2).post('/privacy/my/requests', { type: 'ACCESS' }).expect(201)).body;
      await t.as(tenant.owner).post(`/privacy/requests/${closed.id}/decision`, { decision: 'REJECTED', decisionNote: 'Duplicate of an earlier request.' }).expect(200);
      const incident = (await t.as(tenant.owner).post('/privacy/incidents', { title: 'Printer left unattended', description: 'Printed documents were left on the public printer.' }).expect(201)).body;
      await t.as(tenant.owner).post('/privacy/incidents', { title: 'Second incident', description: 'Another event that is still open.' }).expect(201);
      await t.as(tenant.owner).post(`/privacy/incidents/${incident.id}/status`, { status: 'INVESTIGATING' }).expect(200);
      await t.as(tenant.owner).post('/privacy/processors', { name: 'Sample Vendor', purpose: 'Email delivery', dataCategories: ['email'], country: 'IE' }).expect(201);
      const doc = await uploadDocument(t, tenant.owner, { customerId: c1.customerId });
      await t.as(tenant.owner).put(`/documents/${doc.documentId}/legal-hold`, { legalHold: true, reason: 'Kept for a dispute' }).expect(200);

      const res = await t.as(tenant.owner).get('/privacy/overview').expect(200);
      expect(res.body.dataSubjectRequests).toEqual({ open: 2, overdue: 1, openByType: { EXPORT: 1, DELETION: 1 }, completedLast90Days: 0 });
      expect(res.body.incidents).toEqual({ byStatus: { OPEN: 1, INVESTIGATING: 1, CONTAINED: 0, RESOLVED: 0 } });
      expect(res.body.processors).toEqual({ total: 1, pendingReview: 1, crossBorder: 1, crossBorderUnapproved: 1 });
      expect(res.body.consents).toEqual([{ purpose: 'MARKETING', granted: 0, withdrawn: 2 }, { purpose: 'SERVICE_PROCESSING', granted: 2, withdrawn: 0 }]);
      expect(res.body.retention).toMatchObject({ policiesInForce: 2, policiesEnforcedAutomatically: 2, documentsOnLegalHold: 1, deletedDocumentsAwaitingPurge: 0 });
      expect(res.body.retention.policies).toHaveLength(5);
      expect(res.body.disclaimer).toMatch(/do not establish legal compliance/);
      // Counts never include another centre.
      expect((await t.as(beta.owner).get('/privacy/overview').expect(200)).body).toMatchObject({ dataSubjectRequests: { open: 0, overdue: 0 }, incidents: { byStatus: { OPEN: 0, INVESTIGATING: 0 } }, processors: { total: 0 } });
      await t.as(manager).get('/privacy/overview').expect(403);
    });
  });
});
