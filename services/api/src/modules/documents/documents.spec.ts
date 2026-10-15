import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Actor, TenantFixture, TestApp } from '../../../test/helpers';
import { sha256 } from '../../common/crypto';
import { StorageService } from '../storage/storage.service';
import {
  addChecklistItem, addEmployee, createBranch, createCorporateAdmin, createCustomer, createRequest, fetchBytes, jpegBytes, pdfBytes, pngBytes, putToUploadUrl,
  supportSession, uploadDocument, windowsExeBytes,
} from './fixtures';

describe('Documents: upload, access rules and tenant isolation', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let receptionist: Actor;
  let reviewer: Actor;
  let accountant: Actor;
  let customerId: string;

  const usageBytes = async (tenantId: string) => Number((await t.sys.usageRecord.findFirst({ where: { tenantId, metric: 'storageBytes', periodKey: 'total' } }))?.quantity ?? 0);
  const version = (id: string) => t.sys.documentVersion.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    t = await TestApp.create();
    alpha = await t.createTenant({ name: 'Alpha Typing' });
    beta = await t.createTenant({ name: 'Beta Typing' });
    receptionist = await t.addStaff(alpha, 'receptionist');
    reviewer = await t.addStaff(alpha, 'reviewer');
    accountant = await t.addStaff(alpha, 'accountant');
    customerId = (await createCustomer(t, alpha)).id;
  });
  afterAll(() => t.close());

  describe('three-step upload', () => {
    it('creates an intent, accepts the bytes, verifies them and makes the document available after the scan', async () => {
      const request = await createRequest(t, alpha, customerId);
      const item = await addChecklistItem(t, alpha, request.id, 'passport');
      const content = pdfBytes();
      const before = await usageBytes(alpha.id);

      const intent = await t
        .as(receptionist)
        .post('/documents/upload-intents', { checklistItemId: item.id, documentTypeKey: 'passport', filename: '../../Passport Ahmed.pdf', mime: 'application/pdf', sizeBytes: content.length, expiryDate: '2031-05-01' })
        .expect(201);
      expect(Object.keys(intent.body).sort()).toEqual(['documentId', 'upload', 'versionId']);
      expect(intent.body.upload.method).toBe('PUT');
      expect(intent.body.upload.headers['Content-Type']).toBe('application/pdf');
      expect(new Date(intent.body.upload.expiresAt).getTime()).toBeGreaterThan(Date.now());
      const stored = await version(intent.body.versionId);
      // The key is random, prefixed with the tenant id, and never part of an API response.
      expect(stored.storageKey).toMatch(new RegExp(`^${alpha.id}/[A-Za-z0-9_-]{32}$`));
      expect(stored.storageKey).not.toContain('Passport');
      expect(JSON.stringify(intent.body)).not.toContain(stored.storageKey.split('/')[1]);
      expect(stored.originalFilename).toBe('Passport Ahmed.pdf');

      // Not uploaded yet.
      const early = await t.as(receptionist).post(`/documents/${intent.body.documentId}/versions/${intent.body.versionId}/complete`);
      expect(early.status).toBe(409);
      expect(early.body.code).toBe('UPLOAD_NOT_FOUND');

      expect((await putToUploadUrl(t, intent.body.upload, content)).status).toBe(200);
      const done = await t.as(receptionist).post(`/documents/${intent.body.documentId}/versions/${intent.body.versionId}/complete`).expect(200);
      expect(done.body).toMatchObject({ documentId: intent.body.documentId, status: 'PENDING_SCAN', scanStatus: 'PENDING', mime: 'application/pdf', sizeBytes: content.length, isCurrentVersion: true });
      expect((await version(intent.body.versionId)).sha256).toBe(sha256(content));
      expect(await usageBytes(alpha.id)).toBe(before + content.length);

      // Not downloadable before the scan has run.
      const tooEarly = await t.as(receptionist).post(`/documents/${intent.body.documentId}/download-link`);
      expect(tooEarly.status).toBe(409);
      expect(tooEarly.body.code).toBe('DOCUMENT_NOT_READY');

      // Completing again changes nothing (usage is not counted twice).
      await t.as(receptionist).post(`/documents/${intent.body.documentId}/versions/${intent.body.versionId}/complete`).expect(200);
      expect(await usageBytes(alpha.id)).toBe(before + content.length);

      await t.settle();
      const detail = await t.as(receptionist).get(`/documents/${intent.body.documentId}`).expect(200);
      expect(detail.body).toMatchObject({
        status: 'AVAILABLE', verificationStatus: 'UNVERIFIED', documentTypeKey: 'passport', title: 'Copy of passport', customerId, requestId: request.id,
        expiryDate: '2031-05-01', expiryVerified: false, downloadable: true, uploadedByType: 'STAFF',
      });
      expect(detail.body.currentVersion).toMatchObject({ versionNo: 1, filename: 'Passport Ahmed.pdf', mime: 'application/pdf', scanStatus: 'SKIPPED', sizeBytes: content.length });
      expect(detail.body.versions).toHaveLength(1);
      // The checklist is linked by the requests module (reacting to document.uploaded), never by this module:
      // empty when the documents module runs alone, linked and UPLOADED when the whole application is loaded.
      for (const line of detail.body.checklist) expect(line).toMatchObject({ documentTypeKey: 'passport', status: 'UPLOADED' });
      expect(JSON.stringify(detail.body)).not.toMatch(/storageKey|encryptionMeta/);

      // The event carries the request and checklist line through to the requests module.
      const events = await t.sys.outboxEvent.findMany({ where: { tenantId: alpha.id, type: 'document.uploaded' } });
      const event = events.find((e) => (e.payload as any).documentId === intent.body.documentId)!;
      expect(event.payload).toMatchObject({ versionId: intent.body.versionId, customerId, requestId: request.id, checklistItemId: item.id, documentTypeKey: 'passport', uploadedByType: 'STAFF' });

      const logs = await t.sys.documentAccessLog.findMany({ where: { documentId: intent.body.documentId }, orderBy: { createdAt: 'asc' } });
      expect(logs.map((l) => l.action)).toEqual(['UPLOAD_INTENT', 'UPLOAD', 'VIEW']);
      expect(logs.every((l) => l.actorId === receptionist.userId && l.actorType === 'STAFF' && !!l.ip)).toBe(true);
      const audit = await t.sys.auditLog.findFirst({ where: { tenantId: alpha.id, action: 'document.uploaded', resourceId: intent.body.documentId } });
      expect(audit?.actorUserId).toBe(receptionist.userId);
    });

    it('flags a file the centre uploads against a COMPLETION checklist line as the completed document', async () => {
      const request = await createRequest(t, alpha, customerId);
      const input = await addChecklistItem(t, alpha, request.id, 'passport');
      const output = await addChecklistItem(t, alpha, request.id, 'passport', { kind: 'COMPLETION', label: 'Typed application' });

      const supporting = await uploadDocument(t, receptionist, { checklistItemId: input.id });
      const completed = await uploadDocument(t, receptionist, { checklistItemId: output.id });
      expect((await t.as(receptionist).get(`/documents/${supporting.documentId}`).expect(200)).body.isCompletionDocument).toBe(false);
      expect((await t.as(receptionist).get(`/documents/${completed.documentId}`).expect(200)).body).toMatchObject({ isCompletionDocument: true, title: 'Typed application', requestId: request.id });
    });

    it('customers and corporate users cannot upload against a COMPLETION checklist line; staff still can', async () => {
      const portal = await t.addCustomer(alpha);
      const own = await createRequest(t, alpha, portal.customerId!, { status: 'AWAITING_CUSTOMER' });
      const ownInput = await addChecklistItem(t, alpha, own.id, 'passport');
      const ownOutput = await addChecklistItem(t, alpha, own.id, 'residence_visa', { kind: 'COMPLETION', label: 'Stamped residence visa' });
      const before = { documents: await t.sys.document.count({ where: { tenantId: alpha.id } }), versions: await t.sys.documentVersion.count({ where: { tenantId: alpha.id } }), bytes: await usageBytes(alpha.id) };
      const intentBody = { documentTypeKey: 'residence_visa', filename: 'visa.pdf', mime: 'application/pdf', sizeBytes: pdfBytes().length, checklistItemId: ownOutput.id };

      // Every way in: the upload intent, the single-request upload, a "new version" of an own document, with or without the request id.
      const refused = await t.as(portal).post('/documents/upload-intents', intentBody).expect(403);
      expect(refused.body).toMatchObject({ code: 'COMPLETION_DOCUMENT_STAFF_ONLY' });
      expect(refused.body.message).toMatch(/"Stamped residence visa" is a completed document that the centre adds/);
      expect((await t.as(portal).post('/documents/upload-intents', { ...intentBody, requestId: own.id }).expect(403)).body.code).toBe('COMPLETION_DOCUMENT_STAFF_ONLY');
      expect((await t.as(portal).upload('/documents/upload', 'file', pdfBytes(), 'visa.pdf', { documentTypeKey: 'residence_visa', checklistItemId: ownOutput.id }).expect(403)).body.code).toBe('COMPLETION_DOCUMENT_STAFF_ONLY');
      const ownDoc = await uploadDocument(t, portal, { checklistItemId: ownInput.id });
      expect((await t.as(portal).post('/documents/upload-intents', { ...intentBody, replacesDocumentId: ownDoc.documentId }).expect(403)).body.code).toBe('COMPLETION_DOCUMENT_STAFF_ONLY');
      // Linking an existing document to the line is refused by the requests module too.
      await t.as(portal).put(`/requests/${own.id}/checklist/${ownOutput.id}/document`, { documentId: ownDoc.documentId }).expect(403);
      // Nothing was created, stored or charged for the refused attempts, and the line is untouched.
      expect(await t.sys.document.count({ where: { tenantId: alpha.id } })).toBe(before.documents + 1);
      expect(await t.sys.documentVersion.count({ where: { tenantId: alpha.id } })).toBe(before.versions + 1);
      expect(await usageBytes(alpha.id)).toBe(before.bytes + ownDoc.content.length);
      expect(await t.sys.requestDocument.findUniqueOrThrow({ where: { id: ownOutput.id } })).toMatchObject({ documentId: null, status: 'MISSING' });
      // The customer's ordinary uploads are not affected.
      expect(await t.sys.requestDocument.findUniqueOrThrow({ where: { id: ownInput.id } })).toMatchObject({ documentId: ownDoc.documentId, status: 'UPLOADED' });

      // A COMPLETION line of somebody else's request stays "not found": the rule does not reveal that it exists.
      const others = await createRequest(t, alpha, customerId, { status: 'AWAITING_CUSTOMER' });
      const othersOutput = await addChecklistItem(t, alpha, others.id, 'residence_visa', { kind: 'COMPLETION' });
      await t.as(portal).post('/documents/upload-intents', { ...intentBody, checklistItemId: othersOutput.id }).expect(404);

      // A corporate administrator is an outsider as well.
      const { accountId, admin } = await createCorporateAdmin(t, alpha);
      const employee = await addEmployee(t, alpha, accountId);
      const corporateRequest = await createRequest(t, alpha, employee.id, { corporateAccountId: accountId, status: 'AWAITING_CUSTOMER' });
      const corporateOutput = await addChecklistItem(t, alpha, corporateRequest.id, 'residence_visa', { kind: 'COMPLETION', label: 'Labour card' });
      expect((await t.as(admin).post('/documents/upload-intents', { ...intentBody, checklistItemId: corporateOutput.id }).expect(403)).body.code).toBe('COMPLETION_DOCUMENT_STAFF_ONLY');
      expect((await t.sys.requestDocument.findUniqueOrThrow({ where: { id: corporateOutput.id } })).documentId).toBeNull();

      // Staff provide the completed document, which the customer can then download.
      const completed = await uploadDocument(t, receptionist, { checklistItemId: ownOutput.id, documentTypeKey: 'residence_visa' });
      expect(await t.sys.document.findUniqueOrThrow({ where: { id: completed.documentId } })).toMatchObject({ isCompletionDocument: true, requestId: own.id, customerId: portal.customerId, uploadedByType: 'STAFF' });
      expect(await t.sys.requestDocument.findUniqueOrThrow({ where: { id: ownOutput.id } })).toMatchObject({ documentId: completed.documentId, status: 'UPLOADED' });
      await t.as(portal).get(`/documents/${completed.documentId}`).expect(200);
      // The customer cannot replace the centre's file with a version of their own against that line either.
      expect((await t.as(portal).post('/documents/upload-intents', { ...intentBody, replacesDocumentId: completed.documentId }).expect(403)).body.code).toBe('COMPLETION_DOCUMENT_STAFF_ONLY');
    });

    it('serves the bytes only through a short-lived link and logs every link', async () => {
      const doc = await uploadDocument(t, receptionist, { customerId });
      const link = await t.as(receptionist).post(`/documents/${doc.documentId}/download-link`).expect(200);
      expect(link.body).toMatchObject({ filename: 'scan.pdf', mime: 'application/pdf', disposition: 'attachment', sizeBytes: doc.content.length });
      expect(new Date(link.body.expiresAt).getTime()).toBeLessThanOrEqual(Date.now() + 120_000);
      const key = (await version(doc.versionId)).storageKey;
      expect(link.body.url).not.toContain(key.split('/')[1]);
      const file = await fetchBytes(t, link.body.url);
      expect(file.status).toBe(200);
      expect(file.headers['content-disposition']).toMatch(/^attachment; filename="scan.pdf"/);
      expect(sha256(file.body)).toBe(sha256(doc.content));

      const preview = await t.as(receptionist).post(`/documents/${doc.documentId}/preview-link`).expect(200);
      expect(preview.body.disposition).toBe('inline');
      expect((await fetchBytes(t, preview.body.url)).headers['content-disposition']).toMatch(/^inline;/);

      const actions = (await t.sys.documentAccessLog.findMany({ where: { documentId: doc.documentId }, orderBy: { createdAt: 'asc' } })).map((l) => l.action);
      expect(actions).toEqual(['UPLOAD_INTENT', 'UPLOAD', 'DOWNLOAD_LINK', 'PREVIEW_LINK']);
      // The file on disk is encrypted.
      const local = t.get(StorageService).local!;
      const raw = readFileSync(join(local.root, `${key}.obj`));
      expect(raw.includes(doc.content.subarray(0, 40))).toBe(false);
    });

    it('accepts images and several files for the same request (multi-file upload = several intents)', async () => {
      const request = await createRequest(t, alpha, customerId);
      const [a, b, c] = await Promise.all([
        uploadDocument(t, receptionist, { requestId: request.id, documentTypeKey: 'photo' }, { content: jpegBytes(), mime: 'image/jpg', filename: 'photo.jpg', settle: false }),
        uploadDocument(t, receptionist, { requestId: request.id, documentTypeKey: 'emirates_id' }, { content: pngBytes(), mime: 'image/png', filename: 'eid-front.png', settle: false }),
        uploadDocument(t, receptionist, { requestId: request.id, documentTypeKey: 'emirates_id', title: 'Emirates ID (back)' }, { content: pngBytes(), mime: 'image/png', filename: 'eid-back.png', settle: false }),
      ]);
      await t.settle();
      const list = await t.as(receptionist).get(`/documents?requestId=${request.id}&sort=createdAt:asc`).expect(200);
      expect(list.body.meta.total).toBe(3);
      expect(list.body.data.map((d: any) => d.id).sort()).toEqual([a.documentId, b.documentId, c.documentId].sort());
      expect(list.body.data.every((d: any) => d.status === 'AVAILABLE' && d.customerId === customerId)).toBe(true);
      expect(list.body.data.find((d: any) => d.id === a.documentId).currentVersion.mime).toBe('image/jpeg');
      expect(JSON.stringify(list.body)).not.toMatch(/storageKey/);
    });

    it('offers a single-request multipart upload on top of the same checks', async () => {
      const content = jpegBytes();
      const res = await t.as(receptionist).upload('/documents/upload', 'file', content, 'camera.jpg', { customerId, documentTypeKey: 'photo', title: 'Camera capture' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ status: 'PENDING_SCAN', mime: 'image/jpeg', sizeBytes: content.length, filename: 'camera.jpg' });
      await t.settle();
      const link = await t.as(receptionist).post(`/documents/${res.body.documentId}/download-link`).expect(200);
      expect(sha256((await fetchBytes(t, link.body.url)).body)).toBe(sha256(content));

      // Same content rules: an executable renamed to .pdf is refused and nothing is kept.
      const bad = await t.as(receptionist).upload('/documents/upload', 'file', windowsExeBytes(), 'invoice.pdf', { customerId, documentTypeKey: 'other' });
      expect(bad.status).toBe(422);
      expect(bad.body.code).toBe('FILE_TYPE_NOT_ALLOWED');
      const missing = await t.as(receptionist).post('/documents/upload', { customerId, documentTypeKey: 'photo' });
      expect(missing.status).toBe(400);
      // Larger than UPLOAD_MAX_BYTES: refused while the request is being read.
      const huge = await t.as(receptionist).upload('/documents/upload', 'file', Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(15 * 1024 * 1024)]), 'huge.pdf', { customerId, documentTypeKey: 'other' });
      expect(huge.status).toBe(413);
    });
  });

  describe('validation of what is uploaded', () => {
    const intentBody = (over: Record<string, unknown> = {}) => ({ customerId, documentTypeKey: 'passport', filename: 'a.pdf', mime: 'application/pdf', sizeBytes: 1000, ...over });

    it('rejects types that are not allowed, oversized files, unknown document types and ownerless documents', async () => {
      const html = await t.as(receptionist).post('/documents/upload-intents', intentBody({ mime: 'text/html', filename: 'x.html' }));
      expect(html.status).toBe(422);
      expect(html.body.code).toBe('FILE_TYPE_NOT_ALLOWED');
      const zip = await t.as(receptionist).post('/documents/upload-intents', intentBody({ mime: 'application/zip' }));
      expect(zip.body.code).toBe('FILE_TYPE_NOT_ALLOWED');
      const big = await t.as(receptionist).post('/documents/upload-intents', intentBody({ sizeBytes: 15 * 1024 * 1024 + 1 }));
      expect(big.status).toBe(413);
      expect(big.body.code).toBe('FILE_TOO_LARGE');
      const type = await t.as(receptionist).post('/documents/upload-intents', intentBody({ documentTypeKey: 'no_such_type' }));
      expect(type.status).toBe(422);
      expect(type.body.code).toBe('UNKNOWN_DOCUMENT_TYPE');
      const ownerless = await t.as(receptionist).post('/documents/upload-intents', intentBody({ customerId: undefined }));
      expect(ownerless.status).toBe(422);
      expect(ownerless.body.code).toBe('DOCUMENT_OWNER_REQUIRED');
      await t.as(receptionist).post('/documents/upload-intents', intentBody({ sizeBytes: 0 })).expect(400);
      await t.as(receptionist).post('/documents/upload-intents', intentBody({ sizeBytes: -5 })).expect(400);
      await t.as(receptionist).post('/documents/upload-intents', { documentTypeKey: 'passport' }).expect(400);
    });

    it('sniffs the real type: a file that contradicts its declared type is deleted and refused', async () => {
      const before = await usageBytes(alpha.id);
      const png = pngBytes();
      const intent = (await t.as(receptionist).post('/documents/upload-intents', intentBody({ sizeBytes: png.length })).expect(201)).body;
      expect((await putToUploadUrl(t, intent.upload, png)).status).toBe(200);
      const done = await t.as(receptionist).post(`/documents/${intent.documentId}/versions/${intent.versionId}/complete`);
      expect(done.status).toBe(422);
      expect(done.body.code).toBe('FILE_TYPE_MISMATCH');
      const v = await version(intent.versionId);
      expect(v.uploadStatus).toBe('FAILED');
      expect(await t.get(StorageService).head(v.storageKey)).toBeNull();
      expect(await t.get(StorageService).promote(v.storageKey)).toBeNull();
      expect((await t.sys.document.findUniqueOrThrow({ where: { id: intent.documentId } })).status).toBe('DELETED');
      expect(await usageBytes(alpha.id)).toBe(before);
      const event = await t.sys.securityEvent.findFirst({ where: { tenantId: alpha.id, type: 'UPLOAD_CONTENT_MISMATCH' }, orderBy: { createdAt: 'desc' } });
      expect((event?.details as any).detected).toBe('image/png');
      // The rejected upload cannot be completed again and never shows up as a document.
      const again = await t.as(receptionist).post(`/documents/${intent.documentId}/versions/${intent.versionId}/complete`);
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('UPLOAD_REJECTED');
      await t.as(receptionist).post(`/documents/${intent.documentId}/download-link`).expect(404);
    });

    it('refuses content that is not an allowed type even when the declaration is allowed', async () => {
      const exe = windowsExeBytes();
      const intent = (await t.as(receptionist).post('/documents/upload-intents', intentBody({ sizeBytes: exe.length, filename: 'passport.pdf' })).expect(201)).body;
      await putToUploadUrl(t, intent.upload, exe);
      const done = await t.as(receptionist).post(`/documents/${intent.documentId}/versions/${intent.versionId}/complete`);
      expect(done.status).toBe(422);
      expect(done.body.code).toBe('FILE_TYPE_NOT_ALLOWED');
      const list = await t.as(receptionist).get(`/documents?customerId=${customerId}&q=passport.pdf`).expect(200);
      expect(list.body.data.find((d: any) => d.id === intent.documentId)).toBeUndefined();
    });

    it('enforces the plan storage limit before issuing an upload URL', async () => {
      const small = await t.createTenant({ plan: 'starter' }); // 2048 MB
      const c = await createCustomer(t, small);
      await t.sys.usageRecord.create({ data: { tenantId: small.id, metric: 'storageBytes', periodKey: 'total', quantity: 2048 * 1024 * 1024 - 500 } });
      const res = await t.as(small.owner).post('/documents/upload-intents', { customerId: c.id, documentTypeKey: 'passport', filename: 'a.pdf', mime: 'application/pdf', sizeBytes: 2 * 1024 * 1024 });
      expect(res.status).toBe(402);
      expect(res.body.code).toBe('PLAN_LIMIT_REACHED');
      expect(await t.sys.document.count({ where: { tenantId: small.id } })).toBe(0);
    });
  });

  describe('tenant isolation', () => {
    let doc: { documentId: string; versionId: string };
    beforeAll(async () => {
      doc = await uploadDocument(t, receptionist, { customerId });
    });

    it('another centre cannot see, download, change, share or delete the document', async () => {
      const b = t.as(beta.owner);
      await b.get(`/documents/${doc.documentId}`).expect(404);
      await b.post(`/documents/${doc.documentId}/download-link`).expect(404);
      await b.post(`/documents/${doc.documentId}/preview-link`).expect(404);
      await b.patch(`/documents/${doc.documentId}`, { title: 'Hijacked' }).expect(404);
      await b.post(`/documents/${doc.documentId}/verify`, { decision: 'APPROVED' }).expect(404);
      await b.post(`/documents/${doc.documentId}/shares`, {}).expect(404);
      await b.get(`/documents/${doc.documentId}/shares`).expect(404);
      await b.delete(`/documents/${doc.documentId}`).expect(404);
      await b.get(`/documents/${doc.documentId}/access-logs`).expect(404);
      await b.put(`/documents/${doc.documentId}/legal-hold`, { legalHold: true, reason: 'not mine' }).expect(404);
      await b.post(`/documents/${doc.documentId}/versions/${doc.versionId}/complete`).expect(404);
      const list = await b.get('/documents').expect(200);
      expect(list.body.data).toEqual([]);
      const filtered = await b.get(`/documents?customerId=${customerId}`).expect(200);
      expect(filtered.body.meta.total).toBe(0);
      const still = await t.sys.document.findUniqueOrThrow({ where: { id: doc.documentId } });
      expect(still).toMatchObject({ title: 'Passport', status: 'AVAILABLE', legalHold: false });
      expect(await t.sys.documentAccessLog.count({ where: { documentId: doc.documentId, tenantId: beta.id } })).toBe(0);
    });

    it('cannot reference rows of another centre when uploading', async () => {
      const request = await createRequest(t, alpha, customerId);
      const item = await addChecklistItem(t, alpha, request.id, 'passport');
      const body = { documentTypeKey: 'passport', filename: 'a.pdf', mime: 'application/pdf', sizeBytes: 100 };
      await t.as(beta.owner).post('/documents/upload-intents', { ...body, customerId }).expect(404);
      await t.as(beta.owner).post('/documents/upload-intents', { ...body, requestId: request.id }).expect(404);
      await t.as(beta.owner).post('/documents/upload-intents', { ...body, checklistItemId: item.id }).expect(404);
      const betaCustomer = await createCustomer(t, beta);
      await t.as(beta.owner).post('/documents/upload-intents', { ...body, customerId: betaCustomer.id, replacesDocumentId: doc.documentId }).expect(404);
      expect(await t.sys.document.count({ where: { tenantId: beta.id } })).toBe(0);
    });

    it('row-level security hides documents, versions and access logs even from unfiltered queries', async () => {
      const seen = await t.inTenant(beta.id, () => t.db.tx(async (tx) => ({ docs: await tx.document.count(), versions: await tx.documentVersion.count(), logs: await tx.documentAccessLog.count(), shares: await tx.documentShare.count() })));
      expect(seen).toEqual({ docs: 0, versions: 0, logs: 0, shares: 0 });
      await expect(
        t.inTenant(beta.id, () => t.db.tx((tx) => tx.documentShare.create({ data: { tenantId: beta.id, documentId: doc.documentId, tokenHash: 'x'.repeat(64), expiresAt: new Date(Date.now() + 1000) } }))),
      ).rejects.toThrow(/cross-tenant|violates|security/i);
    });

    it('the access trail is append-only', async () => {
      const log = await t.sys.documentAccessLog.findFirstOrThrow({ where: { documentId: doc.documentId } });
      await expect(t.sys.documentAccessLog.update({ where: { id: log.id }, data: { action: 'NOTHING' } })).rejects.toThrow(/append-only/i);
      await expect(t.sys.documentAccessLog.delete({ where: { id: log.id } })).rejects.toThrow(/append-only/i);
      await expect(t.inTenant(alpha.id, () => t.db.tx((tx) => tx.documentAccessLog.deleteMany({ where: { documentId: doc.documentId } })))).rejects.toThrow(/permission denied|append-only/i);
    });
  });

  describe('roles', () => {
    let doc: { documentId: string; versionId: string };
    beforeAll(async () => {
      doc = await uploadDocument(t, receptionist, { customerId });
    });

    it('requires the matching permission for every action', async () => {
      // Accountant: no document permissions at all.
      await t.as(accountant).get('/documents').expect(403);
      await t.as(accountant).get(`/documents/${doc.documentId}`).expect(403);
      await t.as(accountant).post(`/documents/${doc.documentId}/download-link`).expect(403);
      await t.as(accountant).post('/documents/upload-intents', { customerId, documentTypeKey: 'passport', filename: 'a.pdf', mime: 'application/pdf', sizeBytes: 10 }).expect(403);
      // Receptionist: read + upload only.
      await t.as(receptionist).post(`/documents/${doc.documentId}/verify`, { decision: 'APPROVED' }).expect(403);
      await t.as(receptionist).delete(`/documents/${doc.documentId}`).expect(403);
      await t.as(receptionist).post(`/documents/${doc.documentId}/shares`, {}).expect(403);
      await t.as(receptionist).put(`/documents/${doc.documentId}/legal-hold`, { legalHold: true, reason: 'because' }).expect(403);
      await t.as(receptionist).get(`/documents/${doc.documentId}/access-logs`).expect(403);
      await t.as(receptionist).post(`/documents/${doc.documentId}/restore`).expect(403);
      // Reviewer: read + verify, but no upload and no delete.
      await t.as(reviewer).get(`/documents/${doc.documentId}`).expect(200);
      await t.as(reviewer).post('/documents/upload-intents', { customerId, documentTypeKey: 'passport', filename: 'a.pdf', mime: 'application/pdf', sizeBytes: 10 }).expect(403);
      await t.as(reviewer).delete(`/documents/${doc.documentId}`).expect(403);
      // Nobody without a session.
      await t.as(null).get('/documents').expect(401);
      await t.as(null).post(`/documents/${doc.documentId}/download-link`).expect(401);
      const denied = await t.sys.securityEvent.count({ where: { tenantId: alpha.id, type: 'PERMISSION_DENIED' } });
      expect(denied).toBeGreaterThan(5);
    });

    it('owners can read the access trail', async () => {
      const logs = await t.as(alpha.owner).get(`/documents/${doc.documentId}/access-logs?pageSize=50`).expect(200);
      expect(logs.body.meta.total).toBeGreaterThanOrEqual(3);
      expect(logs.body.data[0]).toEqual(expect.objectContaining({ documentId: doc.documentId, action: expect.any(String), actorType: 'STAFF' }));
    });

    it('limits branch staff and assigned-only operators to the requests they can work on', async () => {
      const second = await createBranch(t, alpha);
      const branchClerk = await t.addStaff(alpha, 'receptionist', { branchIds: [second.id] });
      const operator = await t.addStaff(alpha, 'operator');
      const stranger = await t.addStaff(alpha, 'operator');
      const mainRequest = await createRequest(t, alpha, customerId, { assignedToId: operator.membershipId });
      const otherRequest = await createRequest(t, alpha, customerId, { branchId: second.id });
      const onMain = await uploadDocument(t, alpha.owner, { requestId: mainRequest.id });
      const onSecond = await uploadDocument(t, alpha.owner, { requestId: otherRequest.id });

      // A clerk of the second branch: customer-level documents and documents of second-branch requests only.
      await t.as(branchClerk).get(`/documents/${doc.documentId}`).expect(200);
      await t.as(branchClerk).get(`/documents/${onSecond.documentId}`).expect(200);
      await t.as(branchClerk).get(`/documents/${onMain.documentId}`).expect(404);
      await t.as(branchClerk).post(`/documents/${onMain.documentId}/download-link`).expect(404);
      const clerkList = await t.as(branchClerk).get(`/documents?customerId=${customerId}&pageSize=100`).expect(200);
      const clerkIds = clerkList.body.data.map((d: any) => d.id);
      expect(clerkIds).toContain(onSecond.documentId);
      expect(clerkIds).not.toContain(onMain.documentId);
      const refused = await t.as(branchClerk).post('/documents/upload-intents', { requestId: mainRequest.id, documentTypeKey: 'passport', filename: 'a.pdf', mime: 'application/pdf', sizeBytes: 10 });
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe('BRANCH_FORBIDDEN');

      // Operators only see documents of requests assigned to them (plus customer-level documents).
      await t.as(operator).get(`/documents/${onMain.documentId}`).expect(200);
      await t.as(operator).get(`/documents/${doc.documentId}`).expect(200);
      await t.as(stranger).get(`/documents/${onMain.documentId}`).expect(404);
      await t.as(stranger).post(`/documents/${onMain.documentId}/verify`, { decision: 'APPROVED' }).expect(404);
      await t.as(stranger).post('/documents/upload-intents', { requestId: mainRequest.id, documentTypeKey: 'passport', filename: 'a.pdf', mime: 'application/pdf', sizeBytes: 10 }).expect(404);
    });
  });

  describe('customers and corporate users', () => {
    let ahmed: Actor;
    let sara: Actor;
    beforeAll(async () => {
      ahmed = await t.addCustomer(alpha, { fullName: 'Ahmed Example' });
      sara = await t.addCustomer(alpha, { fullName: 'Sara Example' });
    });

    it('customers upload to and read only their own record', async () => {
      const mine = await uploadDocument(t, ahmed, {}, { content: pngBytes(), mime: 'image/png', filename: 'my-id.png' });
      const stored = await t.sys.document.findUniqueOrThrow({ where: { id: mine.documentId } });
      expect(stored).toMatchObject({ customerId: ahmed.customerId, uploadedByType: 'CUSTOMER', customerVisible: true });

      const detail = await t.as(ahmed).get(`/documents/${mine.documentId}`).expect(200);
      // Staff-only fields are not sent to customers.
      for (const hidden of ['legalHold', 'uploadedById', 'verifiedById', 'customerVisible', 'purgeAfter', 'verifications']) expect(detail.body).not.toHaveProperty(hidden);
      expect(detail.body.currentVersion).not.toHaveProperty('sha256');
      const link = await t.as(ahmed).post(`/documents/${mine.documentId}/download-link`).expect(200);
      expect(sha256((await fetchBytes(t, link.body.url)).body)).toBe(sha256(mine.content));

      // Another customer of the same centre gets nothing.
      await t.as(sara).get(`/documents/${mine.documentId}`).expect(404);
      await t.as(sara).post(`/documents/${mine.documentId}/download-link`).expect(404);
      await t.as(sara).post(`/documents/${mine.documentId}/preview-link`).expect(404);
      expect((await t.as(sara).get('/documents').expect(200)).body.data).toEqual([]);
      expect((await t.as(sara).get(`/documents?customerId=${ahmed.customerId}`).expect(200)).body.meta.total).toBe(0);
      const own = await t.as(ahmed).get('/documents').expect(200);
      expect(own.body.data.map((d: any) => d.id)).toEqual([mine.documentId]);

      // Customers cannot act for someone else, whatever ids they send.
      const body = { documentTypeKey: 'passport', filename: 'a.pdf', mime: 'application/pdf', sizeBytes: 10 };
      await t.as(sara).post('/documents/upload-intents', { ...body, customerId: ahmed.customerId }).expect(404);
      await t.as(sara).post('/documents/upload-intents', { ...body, replacesDocumentId: mine.documentId }).expect(404);
      const ahmedsRequest = await createRequest(t, alpha, ahmed.customerId!);
      await t.as(sara).post('/documents/upload-intents', { ...body, requestId: ahmedsRequest.id }).expect(404);
      await t.as(sara).post(`/documents/${mine.documentId}/versions/${mine.versionId}/complete`).expect(404);
      // ... and have no staff actions.
      await t.as(ahmed).post(`/documents/${mine.documentId}/verify`, { decision: 'APPROVED' }).expect(403);
      await t.as(ahmed).delete(`/documents/${mine.documentId}`).expect(403);
      await t.as(ahmed).post(`/documents/${mine.documentId}/shares`, {}).expect(403);
      await t.as(ahmed).patch(`/documents/${mine.documentId}`, { title: 'x' }).expect(403);
      await t.as(ahmed).get(`/documents/${mine.documentId}/access-logs`).expect(403);
    });

    it('customers upload to their own open requests only, and never see hidden documents', async () => {
      const open = await createRequest(t, alpha, ahmed.customerId!, { status: 'AWAITING_CUSTOMER' });
      const closed = await createRequest(t, alpha, ahmed.customerId!, { status: 'COMPLETED', completedAt: new Date() });
      const item = await addChecklistItem(t, alpha, open.id, 'passport');
      const up = await uploadDocument(t, ahmed, { checklistItemId: item.id });
      expect((await t.sys.document.findUniqueOrThrow({ where: { id: up.documentId } })).requestId).toBe(open.id);
      // Answering a checklist line with a new version of a document that is already in the vault:
      // the owner stays as it is, the event names the request and line that were answered.
      const vault = await uploadDocument(t, ahmed, {});
      const second = await addChecklistItem(t, alpha, open.id, 'passport');
      const v2 = await uploadDocument(t, ahmed, { replacesDocumentId: vault.documentId, checklistItemId: second.id });
      expect(v2.documentId).toBe(vault.documentId);
      expect(await t.sys.document.findUniqueOrThrow({ where: { id: vault.documentId } })).toMatchObject({ customerId: ahmed.customerId, requestId: null, currentVersionId: v2.versionId });
      const uploaded = (await t.sys.outboxEvent.findMany({ where: { tenantId: alpha.id, type: 'document.uploaded' } })).map((e) => e.payload as any).filter((p) => p.versionId === v2.versionId);
      expect(uploaded).toEqual([expect.objectContaining({ documentId: vault.documentId, requestId: open.id, checklistItemId: second.id, uploadedByType: 'CUSTOMER' })]);
      // ... but not with a line of somebody else's request.
      const sarasRequest = await createRequest(t, alpha, sara.customerId!);
      const sarasItem = await addChecklistItem(t, alpha, sarasRequest.id, 'passport');
      await t.as(ahmed).post('/documents/upload-intents', { replacesDocumentId: vault.documentId, checklistItemId: sarasItem.id, documentTypeKey: 'passport', filename: 'a.pdf', mime: 'application/pdf', sizeBytes: 10 }).expect(404);

      const late = await t.as(ahmed).post('/documents/upload-intents', { requestId: closed.id, documentTypeKey: 'passport', filename: 'a.pdf', mime: 'application/pdf', sizeBytes: 10 });
      expect(late.status).toBe(409);
      expect(late.body.code).toBe('REQUEST_CLOSED');

      // An internal working copy that staff marked as not visible to the customer.
      const internal = await uploadDocument(t, receptionist, { customerId: ahmed.customerId, customerVisible: false, title: 'Internal note scan' });
      await t.as(ahmed).get(`/documents/${internal.documentId}`).expect(404);
      await t.as(ahmed).post(`/documents/${internal.documentId}/download-link`).expect(404);
      const list = await t.as(ahmed).get('/documents?pageSize=100').expect(200);
      expect(list.body.data.map((d: any) => d.id)).not.toContain(internal.documentId);
      // A customer cannot switch visibility on through the upload intent either.
      const sneaky = await uploadDocument(t, ahmed, { customerVisible: false });
      expect((await t.sys.document.findUniqueOrThrow({ where: { id: sneaky.documentId } })).customerVisible).toBe(true);
      // Staff can reveal it later.
      await t.as(receptionist).patch(`/documents/${internal.documentId}`, { customerVisible: true }).expect(200);
      await t.as(ahmed).get(`/documents/${internal.documentId}`).expect(200);
    });

    it('corporate administrators reach their company and its employees, nothing else', async () => {
      const acme = await createCorporateAdmin(t, alpha);
      const other = await createCorporateAdmin(t, alpha);
      const employee = await addEmployee(t, alpha, acme.accountId);
      const companyDoc = await uploadDocument(t, receptionist, { corporateAccountId: acme.accountId, documentTypeKey: 'trade_licence' });
      const employeeDoc = await uploadDocument(t, receptionist, { customerId: employee.id });
      const privateDoc = await uploadDocument(t, receptionist, { customerId });
      const hiddenDoc = await uploadDocument(t, receptionist, { customerId: employee.id, customerVisible: false });

      const list = await t.as(acme.admin).get('/documents?pageSize=100').expect(200);
      expect(list.body.data.map((d: any) => d.id).sort()).toEqual([companyDoc.documentId, employeeDoc.documentId].sort());
      await t.as(acme.admin).post(`/documents/${employeeDoc.documentId}/download-link`).expect(200);
      await t.as(acme.admin).get(`/documents/${privateDoc.documentId}`).expect(404);
      await t.as(acme.admin).get(`/documents/${hiddenDoc.documentId}`).expect(404);
      await t.as(other.admin).get(`/documents/${companyDoc.documentId}`).expect(404);
      await t.as(other.admin).post(`/documents/${employeeDoc.documentId}/download-link`).expect(404);
      expect((await t.as(other.admin).get('/documents').expect(200)).body.data).toEqual([]);

      // Uploads are pinned to the administrator's own company.
      const up = await uploadDocument(t, acme.admin, { customerId: employee.id, documentTypeKey: 'emirates_id' }, { content: pngBytes(), mime: 'image/png', filename: 'eid.png' });
      expect(await t.sys.document.findUniqueOrThrow({ where: { id: up.documentId } })).toMatchObject({ customerId: employee.id, corporateAccountId: acme.accountId, uploadedByType: 'CORPORATE' });
      const body = { documentTypeKey: 'passport', filename: 'a.pdf', mime: 'application/pdf', sizeBytes: 10 };
      await t.as(acme.admin).post('/documents/upload-intents', { ...body, customerId }).expect(404);
      await t.as(acme.admin).post('/documents/upload-intents', { ...body, corporateAccountId: other.accountId }).expect(404);
      await t.as(other.admin).post('/documents/upload-intents', { ...body, customerId: employee.id }).expect(404);
      await t.as(acme.admin).post(`/documents/${companyDoc.documentId}/verify`, { decision: 'APPROVED' }).expect(403);

      // A former employee's documents are no longer visible to the company.
      await t.sys.corporateEmployee.updateMany({ where: { customerId: employee.id }, data: { status: 'INACTIVE' } });
      await t.as(acme.admin).get(`/documents/${employeeDoc.documentId}`).expect(404);
    });
  });

  describe('platform support access', () => {
    it('reaches documents only under a grant that includes document.read, and every access is attributed to the grant', async () => {
      const doc = await uploadDocument(t, receptionist, { customerId });
      const without = await supportSession(t, alpha, ['customer.read', 'request.read.all']);
      await t.as(without.actor).get(`/documents/${doc.documentId}`).expect(403);
      await t.as(without.actor).post(`/documents/${doc.documentId}/download-link`).expect(403);
      await t.as(without.actor).get('/documents').expect(403);

      const withScope = await supportSession(t, alpha, ['document.read']);
      await t.as(withScope.actor).get(`/documents/${doc.documentId}`).expect(200);
      const link = await t.as(withScope.actor).post(`/documents/${doc.documentId}/download-link`).expect(200);
      expect((await fetchBytes(t, link.body.url)).status).toBe(200);
      const logs = await t.sys.documentAccessLog.findMany({ where: { documentId: doc.documentId, supportGrantId: withScope.grantId } });
      expect(logs.map((l) => l.action).sort()).toEqual(['DOWNLOAD_LINK', 'VIEW']);
      expect(logs.every((l) => l.actorType === 'PLATFORM' && l.actorId === withScope.actor.userId)).toBe(true);
      const audit = await t.sys.auditLog.findMany({ where: { tenantId: alpha.id, action: 'document.accessed_by_support', resourceId: doc.documentId } });
      expect(audit).toHaveLength(2);
      expect(audit[0].supportGrantId).toBe(withScope.grantId);
      // Read access never includes changes.
      await t.as(withScope.actor).post(`/documents/${doc.documentId}/verify`, { decision: 'APPROVED' }).expect(403);
      await t.as(withScope.actor).delete(`/documents/${doc.documentId}`).expect(403);
      await t.as(withScope.actor).post('/documents/upload-intents', { customerId, documentTypeKey: 'passport', filename: 'a.pdf', mime: 'application/pdf', sizeBytes: 10 }).expect(403);
      // Platform staff without a grant have no tenant at all.
      const admin = await t.createPlatformAdmin();
      await t.as(admin).get(`/documents/${doc.documentId}`).expect(403);
    });
  });

  describe('list filters', () => {
    it('filters by type, verification status, expiry and text', async () => {
      const c = await createCustomer(t, alpha);
      const passport = await uploadDocument(t, receptionist, { customerId: c.id, documentTypeKey: 'passport', title: 'Passport of Mr Test', expiryDate: '2027-01-10' });
      const licence = await uploadDocument(t, receptionist, { customerId: c.id, documentTypeKey: 'trade_licence', expiryDate: '2030-06-30', category: 'company' }, { filename: 'licence-dubai.pdf' });
      const base = `/documents?customerId=${c.id}`;
      const ids = async (qs: string) => (await t.as(receptionist).get(`${base}${qs}`).expect(200)).body.data.map((d: any) => d.id);
      expect((await ids('')).sort()).toEqual([passport.documentId, licence.documentId].sort());
      expect(await ids('&type=passport')).toEqual([passport.documentId]);
      expect(await ids('&expiringBefore=2028-01-01')).toEqual([passport.documentId]);
      expect(await ids('&q=mr%20test')).toEqual([passport.documentId]);
      expect(await ids('&q=licence-dubai')).toEqual([licence.documentId]);
      expect(await ids('&category=company')).toEqual([licence.documentId]);
      expect(await ids('&verificationStatus=VERIFIED')).toEqual([]);
      expect(await ids('&sort=expiryDate:desc')).toEqual([licence.documentId, passport.documentId]);
      await t.as(receptionist).get(`${base}&sort=storageKey:asc`).expect(200); // unknown sort fields fall back to the default
      await t.as(receptionist).get(`${base}&expiringBefore=tomorrow`).expect(400);
    });
  });
});
