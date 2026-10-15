import { Actor, TenantFixture, TestApp } from '../../../test/helpers';
import { env } from '../../config/env';
import { sha256 } from '../../common/crypto';
import { DocumentStorePort } from '../../common/ports';
import { StorageService } from '../storage/storage.service';
import { addChecklistItem, createCustomer, createRequest, fetchBytes, infectedPdfBytes, pdfBytes, pngBytes, putToUploadUrl, startFakeClamd, uploadDocument } from './fixtures';
import { ClamAvScanner, MalwareScanService, NoneScanner } from './malware';
import { DocumentRetentionService } from './retention.service';
import { tenantOfShareToken } from './shares.service';

const DAY = 86400_000;

describe('Documents: scanning, versions, verification, sharing and retention', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let receptionist: Actor;
  let reviewer: Actor;
  let customer: Actor;
  let customerId: string;
  let storage: StorageService;

  const usageBytes = async (tenantId = alpha.id) => Number((await t.sys.usageRecord.findFirst({ where: { tenantId, metric: 'storageBytes', periodKey: 'total' } }))?.quantity ?? 0);
  const docRow = (id: string) => t.sys.document.findUniqueOrThrow({ where: { id } });
  const versionRow = (id: string) => t.sys.documentVersion.findUniqueOrThrow({ where: { id } });
  const eventsFor = async (type: string, documentId: string) =>
    (await t.sys.outboxEvent.findMany({ where: { tenantId: alpha.id, type } })).map((e) => e.payload as any).filter((p) => p.documentId === documentId);
  const purge = () => t.jobs.runScheduled('documents.purge');

  beforeAll(async () => {
    t = await TestApp.create();
    alpha = await t.createTenant({ name: 'Alpha Typing' });
    beta = await t.createTenant({ name: 'Beta Typing' });
    receptionist = await t.addStaff(alpha, 'receptionist');
    reviewer = await t.addStaff(alpha, 'reviewer');
    customer = await t.addCustomer(alpha);
    customerId = customer.customerId!;
    storage = t.get(StorageService);
  });
  afterAll(() => t.close());

  describe('malware scanning', () => {
    it('quarantines an infected upload: file deleted, never downloadable, security event raised', async () => {
      const before = await usageBytes();
      const doc = await uploadDocument(t, receptionist, { customerId }, { content: infectedPdfBytes(), settle: false });
      expect((await docRow(doc.documentId)).status).toBe('PENDING_SCAN');
      const key = (await versionRow(doc.versionId)).storageKey;
      expect(await storage.head(key)).not.toBeNull();
      await t.settle();

      expect((await docRow(doc.documentId)).status).toBe('QUARANTINED');
      expect(await versionRow(doc.versionId)).toMatchObject({ scanStatus: 'INFECTED', scanEngine: 'builtin-eicar', scanDetail: 'Eicar-Test-Signature', uploadStatus: 'PURGED' });
      expect(await storage.head(key)).toBeNull();
      expect(await usageBytes()).toBe(before);

      for (const actor of [receptionist, alpha.owner, customer]) {
        const link = await t.as(actor).post(`/documents/${doc.documentId}/download-link`);
        expect(link.status).toBe(409);
        expect(link.body.code).toBe('DOCUMENT_QUARANTINED');
      }
      await t.as(alpha.owner).post(`/documents/${doc.documentId}/preview-link`).expect(409);
      await t.as(alpha.owner).post(`/documents/${doc.documentId}/shares`, {}).expect(409);
      await t.as(reviewer).post(`/documents/${doc.documentId}/verify`, { decision: 'APPROVED' }).expect(409);
      await t.as(alpha.owner).post(`/documents/${doc.documentId}/download-link`, { versionId: doc.versionId }).expect(409);

      const event = await t.sys.securityEvent.findFirst({ where: { tenantId: alpha.id, type: 'MALWARE_DETECTED' }, orderBy: { createdAt: 'desc' } });
      expect(event).toMatchObject({ severity: 'HIGH' });
      expect((event!.details as any).documentId).toBe(doc.documentId);
      expect(await t.sys.auditLog.count({ where: { tenantId: alpha.id, action: 'document.quarantined', resourceId: doc.documentId } })).toBe(1);
      // The customer sees that the file was blocked, so they can upload a clean copy as a new version.
      const seen = await t.as(customer).get(`/documents/${doc.documentId}`).expect(200);
      expect(seen.body).toMatchObject({ status: 'QUARANTINED', downloadable: false });
      const clean = await uploadDocument(t, customer, { replacesDocumentId: doc.documentId });
      expect(await docRow(doc.documentId)).toMatchObject({ status: 'AVAILABLE', currentVersionId: clean.versionId });
      // Running the scan job again for the infected version changes nothing.
      await t.jobs.execute('documents.scan', { tenantId: alpha.id, versionId: doc.versionId }, { attempt: 1, maxAttempts: 1 });
      expect((await docRow(doc.documentId)).status).toBe('AVAILABLE');
      expect(await usageBytes()).toBe(before + clean.content.length);
    });

    it('REQUIRE_CLEAN_SCAN: a file that was not scanned cannot be downloaded', async () => {
      const doc = await uploadDocument(t, receptionist, { customerId });
      expect((await versionRow(doc.versionId)).scanStatus).toBe('SKIPPED');
      await t.as(receptionist).post(`/documents/${doc.documentId}/download-link`).expect(200);
      const config = env() as any;
      config.REQUIRE_CLEAN_SCAN = true;
      try {
        const refused = await t.as(receptionist).post(`/documents/${doc.documentId}/download-link`);
        expect(refused.status).toBe(409);
        expect(refused.body.code).toBe('DOCUMENT_NOT_AVAILABLE');
        expect((await t.as(receptionist).get(`/documents/${doc.documentId}`).expect(200)).body.downloadable).toBe(false);
        await t.as(alpha.owner).post(`/documents/${doc.documentId}/shares`, {}).expect(409);
      } finally {
        config.REQUIRE_CLEAN_SCAN = false;
      }
    });

    it('uses ClamAV when configured: CLEAN files become downloadable, detections are quarantined, outages are retried', async () => {
      const scans = t.get(MalwareScanService) as any;
      const clamd = await startFakeClamd((body) => (body.includes(Buffer.from('MARKER-BAD')) ? 'stream: Test.Signature-9 FOUND' : 'stream: OK'));
      const config = env() as any;
      scans.scanner = new ClamAvScanner('127.0.0.1', clamd.port, 3000);
      config.REQUIRE_CLEAN_SCAN = true;
      try {
        const good = await uploadDocument(t, receptionist, { customerId });
        expect(await versionRow(good.versionId)).toMatchObject({ scanStatus: 'CLEAN', scanEngine: 'clamav' });
        expect(clamd.received.some((b) => b.equals(good.content))).toBe(true);
        const link = await t.as(receptionist).post(`/documents/${good.documentId}/download-link`).expect(200);
        expect(sha256((await fetchBytes(t, link.body.url)).body)).toBe(sha256(good.content));

        const bad = await uploadDocument(t, receptionist, { customerId }, { content: pdfBytes('MARKER-BAD') });
        expect((await docRow(bad.documentId)).status).toBe('QUARANTINED');
        expect(await versionRow(bad.versionId)).toMatchObject({ scanStatus: 'INFECTED', scanDetail: 'Test.Signature-9' });

        // Scanner down: the job is retried, then the version is marked ERROR and stays unavailable.
        await clamd.close();
        const pending = await uploadDocument(t, receptionist, { customerId });
        expect(await versionRow(pending.versionId)).toMatchObject({ scanStatus: 'ERROR', scanEngine: 'clamav' });
        expect((await docRow(pending.documentId)).status).toBe('PENDING_SCAN');
        const refused = await t.as(receptionist).post(`/documents/${pending.documentId}/download-link`);
        expect(refused.status).toBe(409);
        expect(await t.sys.securityEvent.count({ where: { tenantId: alpha.id, type: 'MALWARE_SCAN_FAILED' } })).toBe(1);

        // Scanner back: a reviewer asks for a rescan.
        const back = await startFakeClamd(() => 'stream: OK');
        scans.scanner = new ClamAvScanner('127.0.0.1', back.port, 3000);
        try {
          await t.as(receptionist).post(`/documents/${pending.documentId}/rescan`).expect(403);
          expect((await t.as(reviewer).post(`/documents/${pending.documentId}/rescan`).expect(200)).body.queued).toBe(1);
          await t.settle();
          expect((await docRow(pending.documentId)).status).toBe('AVAILABLE');
          await t.as(receptionist).post(`/documents/${pending.documentId}/download-link`).expect(200);
          await t.as(reviewer).post(`/documents/${pending.documentId}/rescan`).expect(409);
        } finally {
          await back.close();
        }
      } finally {
        scans.scanner = new NoneScanner();
        config.REQUIRE_CLEAN_SCAN = false;
        await clamd.close().catch(() => undefined);
      }
    });
  });

  describe('versions', () => {
    it('keeps old versions; the new one becomes current after its scan and verification starts again', async () => {
      const v1 = await uploadDocument(t, receptionist, { customerId, expiryDate: '2030-01-01' });
      await t.as(reviewer).post(`/documents/${v1.documentId}/verify`, { decision: 'APPROVED', expiryDate: '2030-01-01' }).expect(200);
      expect(await docRow(v1.documentId)).toMatchObject({ verificationStatus: 'VERIFIED', expiryVerified: true });

      const v2 = await uploadDocument(t, receptionist, { replacesDocumentId: v1.documentId }, { content: pngBytes(), mime: 'image/png', filename: 'passport-new.png', settle: false });
      expect(v2.documentId).toBe(v1.documentId);
      // Until the new file is scanned the verified version stays in place and downloadable.
      expect(await docRow(v1.documentId)).toMatchObject({ currentVersionId: v1.versionId, status: 'AVAILABLE', verificationStatus: 'VERIFIED' });
      const during = await t.as(receptionist).post(`/documents/${v1.documentId}/download-link`).expect(200);
      expect(sha256((await fetchBytes(t, during.body.url)).body)).toBe(sha256(v1.content));

      await t.settle();
      expect(await docRow(v1.documentId)).toMatchObject({ currentVersionId: v2.versionId, status: 'AVAILABLE', verificationStatus: 'UNVERIFIED', expiryVerified: false, verifiedById: null });
      const detail = await t.as(receptionist).get(`/documents/${v1.documentId}`).expect(200);
      expect(detail.body.versions.map((v: any) => [v.versionNo, v.isCurrent, v.mime])).toEqual([[2, true, 'image/png'], [1, false, 'application/pdf']]);
      const now = await t.as(receptionist).post(`/documents/${v1.documentId}/download-link`).expect(200);
      expect(now.body.filename).toBe('passport-new.png');
      expect(sha256((await fetchBytes(t, now.body.url)).body)).toBe(sha256(v2.content));
      // Staff can still open the earlier version; customers only get the current one.
      const old = await t.as(receptionist).post(`/documents/${v1.documentId}/download-link`, { versionId: v1.versionId }).expect(200);
      expect(sha256((await fetchBytes(t, old.body.url)).body)).toBe(sha256(v1.content));
      await t.as(customer).post(`/documents/${v1.documentId}/download-link`, { versionId: v1.versionId }).expect(404);
      await t.as(customer).post(`/documents/${v1.documentId}/download-link`, { versionId: v2.versionId }).expect(200);
      const other = await uploadDocument(t, receptionist, { customerId });
      await t.as(receptionist).post(`/documents/${v1.documentId}/download-link`, { versionId: other.versionId }).expect(404);
      expect((await eventsFor('document.uploaded', v1.documentId)).map((p) => p.versionId)).toEqual([v1.versionId, v2.versionId]);
    });

    it('an infected replacement never displaces the good version', async () => {
      const good = await uploadDocument(t, receptionist, { customerId });
      const bad = await uploadDocument(t, receptionist, { replacesDocumentId: good.documentId }, { content: infectedPdfBytes() });
      expect(await docRow(good.documentId)).toMatchObject({ status: 'AVAILABLE', currentVersionId: good.versionId });
      expect(await versionRow(bad.versionId)).toMatchObject({ scanStatus: 'INFECTED', uploadStatus: 'PURGED' });
      const link = await t.as(receptionist).post(`/documents/${good.documentId}/download-link`).expect(200);
      expect(sha256((await fetchBytes(t, link.body.url)).body)).toBe(sha256(good.content));
      await t.as(receptionist).post(`/documents/${good.documentId}/download-link`, { versionId: bad.versionId }).expect(409);
      expect(await t.sys.auditLog.count({ where: { action: 'document.quarantined', resourceId: good.documentId } })).toBe(1);
    });
  });

  describe('verification', () => {
    it('approves with a confirmed expiry date and emits document.verified', async () => {
      const request = await createRequest(t, alpha, customerId);
      const doc = await uploadDocument(t, receptionist, { requestId: request.id, expiryDate: '2029-03-03' });
      const res = await t.as(reviewer).post(`/documents/${doc.documentId}/verify`, { decision: 'APPROVED', expiryDate: '2029-03-04', issuedDate: '2019-03-05' }).expect(200);
      expect(res.body).toMatchObject({ verificationStatus: 'VERIFIED', expiryDate: '2029-03-04', issuedDate: '2019-03-05', expiryVerified: true, verifiedById: reviewer.userId });
      expect(res.body.verification).toMatchObject({ decision: 'APPROVED', reviewerId: reviewer.userId, versionId: doc.versionId });
      expect(await eventsFor('document.verified', doc.documentId)).toEqual([expect.objectContaining({ customerId, requestId: request.id, documentTypeKey: 'passport', expiryDate: '2029-03-04' })]);
      expect(await t.sys.documentVerificationResult.count({ where: { documentId: doc.documentId } })).toBe(1);
      expect(await t.sys.auditLog.count({ where: { action: 'document.verified', resourceId: doc.documentId, actorUserId: reviewer.userId } })).toBe(1);
      expect(await t.sys.documentAccessLog.count({ where: { documentId: doc.documentId, action: 'VERIFY' } })).toBe(1);

      // Approving without sending a date does not pretend the date was checked.
      const other = await uploadDocument(t, receptionist, { customerId, expiryDate: '2029-03-03' });
      const plain = await t.as(reviewer).post(`/documents/${other.documentId}/verify`, { decision: 'APPROVED' }).expect(200);
      expect(plain.body).toMatchObject({ verificationStatus: 'VERIFIED', expiryDate: '2029-03-03', expiryVerified: false });
      // Typing a different date afterwards clears the "confirmed" flag.
      const edited = await t.as(reviewer).patch(`/documents/${doc.documentId}`, { expiryDate: '2031-01-01' }).expect(200);
      expect(edited.body).toMatchObject({ expiryDate: '2031-01-01', expiryVerified: false });
    });

    it('rejects or asks for a correction with a reason and emits document.rejected', async () => {
      const doc = await uploadDocument(t, receptionist, { customerId });
      await t.as(reviewer).post(`/documents/${doc.documentId}/verify`, { decision: 'REJECTED' }).expect(400);
      await t.as(reviewer).post(`/documents/${doc.documentId}/verify`, { decision: 'CORRECTION_REQUESTED', reason: ' ' }).expect(400);
      await t.as(reviewer).post(`/documents/${doc.documentId}/verify`, { decision: 'MAYBE' }).expect(400);
      const res = await t.as(reviewer).post(`/documents/${doc.documentId}/verify`, { decision: 'CORRECTION_REQUESTED', reason: 'Photo page is cut off', expiryDate: '2040-01-01' }).expect(200);
      expect(res.body).toMatchObject({ verificationStatus: 'REJECTED', expiryDate: null, expiryVerified: false });
      expect(await eventsFor('document.rejected', doc.documentId)).toEqual([expect.objectContaining({ reason: 'Photo page is cut off', decision: 'CORRECTION_REQUESTED', customerId })]);
      const detail = await t.as(reviewer).get(`/documents/${doc.documentId}`).expect(200);
      expect(detail.body.verifications[0]).toMatchObject({ decision: 'CORRECTION_REQUESTED', reason: 'Photo page is cut off' });
    });
  });

  describe('secure sharing', () => {
    it('issues capped, expiring links that return a fresh short-lived download URL', async () => {
      const doc = await uploadDocument(t, receptionist, { customerId });
      await t.as(alpha.owner).post(`/documents/${doc.documentId}/shares`, { expiresInHours: 169 }).expect(400); // max 7 days
      await t.as(alpha.owner).post(`/documents/${doc.documentId}/shares`, { maxDownloads: 0 }).expect(400);
      const share = (await t.as(alpha.owner).post(`/documents/${doc.documentId}/shares`, { expiresInHours: 168, maxDownloads: 2, recipient: 'PRO at Example LLC' }).expect(201)).body;
      expect(share).toMatchObject({ maxDownloads: 2, downloadCount: 0, active: true, recipient: 'PRO at Example LLC' });
      expect(new Date(share.expiresAt).getTime()).toBeLessThanOrEqual(Date.now() + 7 * DAY);
      expect(share.url.endsWith(`/api/v1/public/shared-documents/${share.token}`)).toBe(true);
      expect(tenantOfShareToken(share.token)).toBe(alpha.id);
      // Only the hash of the token is stored.
      const row = await t.sys.documentShare.findUniqueOrThrow({ where: { id: share.id } });
      expect(row.tokenHash).toBe(sha256(share.token));
      expect(JSON.stringify(row)).not.toContain(share.token.split('.')[1]);
      const listed = await t.as(alpha.owner).get(`/documents/${doc.documentId}/shares`).expect(200);
      expect(listed.body).toHaveLength(1);
      expect(JSON.stringify(listed.body)).not.toMatch(/token/i);

      // No session needed: the token is the capability.
      const first = await t.as(null).get(`/public/shared-documents/${share.token}`).expect(200);
      expect(first.body).toMatchObject({ filename: 'scan.pdf', mime: 'application/pdf', remainingDownloads: 1 });
      expect(new Date(first.body.download.expiresAt).getTime()).toBeLessThanOrEqual(Date.now() + 120_000);
      expect(sha256((await fetchBytes(t, first.body.download.url)).body)).toBe(sha256(doc.content));
      const second = await t.as(null).get(`/public/shared-documents/${share.token}`).expect(200);
      expect(second.body.remainingDownloads).toBe(0);
      expect(second.body.download.url).not.toBe(first.body.download.url);
      const third = await t.as(null).get(`/public/shared-documents/${share.token}`);
      expect(third.status).toBe(403);
      expect(third.body.code).toBe('LINK_EXPIRED');
      expect((await t.sys.documentShare.findUniqueOrThrow({ where: { id: share.id } })).downloadCount).toBe(2);

      const logs = await t.sys.documentAccessLog.findMany({ where: { documentId: doc.documentId, action: { startsWith: 'SHARE' } }, orderBy: { createdAt: 'asc' } });
      expect(logs.map((l) => [l.action, l.actorType])).toEqual([['SHARE_CREATED', 'STAFF'], ['SHARE_DOWNLOAD', 'SYSTEM'], ['SHARE_DOWNLOAD', 'SYSTEM']]);
      expect(await t.sys.auditLog.count({ where: { tenantId: alpha.id, action: 'document.share_downloaded', resourceId: share.id } })).toBe(2);
    });

    it('refuses unknown, tampered, expired and revoked tokens', async () => {
      const doc = await uploadDocument(t, receptionist, { customerId });
      const share = (await t.as(alpha.owner).post(`/documents/${doc.documentId}/shares`, {}).expect(201)).body;
      expect(share).toMatchObject({ maxDownloads: 3 });
      expect(new Date(share.expiresAt).getTime()).toBeLessThanOrEqual(Date.now() + DAY);
      const [tenantPart, secret] = share.token.split('.');
      await t.as(null).get('/public/shared-documents/nonsense').expect(404);
      await t.as(null).get(`/public/shared-documents/${tenantPart}.${'A'.repeat(43)}`).expect(404);
      // The same secret presented for another tenant finds nothing.
      const betaPart = Buffer.from(beta.id.replace(/-/g, ''), 'hex').toString('base64url');
      await t.as(null).get(`/public/shared-documents/${betaPart}.${secret}`).expect(404);

      await t.sys.documentShare.update({ where: { id: share.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      const expired = await t.as(null).get(`/public/shared-documents/${share.token}`);
      expect(expired.status).toBe(403);
      expect(expired.body.code).toBe('LINK_EXPIRED');

      const live = (await t.as(alpha.owner).post(`/documents/${doc.documentId}/shares`, {}).expect(201)).body;
      await t.as(null).get(`/public/shared-documents/${live.token}`).expect(200);
      await t.as(beta.owner).delete(`/documents/${doc.documentId}/shares/${live.id}`).expect(404);
      const revoked = await t.as(alpha.owner).delete(`/documents/${doc.documentId}/shares/${live.id}`).expect(200);
      expect(revoked.body.active).toBe(false);
      expect((await t.as(null).get(`/public/shared-documents/${live.token}`)).body.code).toBe('LINK_EXPIRED');
      expect((await t.sys.documentShare.findUniqueOrThrow({ where: { id: live.id } })).downloadCount).toBe(1);

      // Deleting the document revokes whatever is still open.
      const last = (await t.as(alpha.owner).post(`/documents/${doc.documentId}/shares`, {}).expect(201)).body;
      await t.as(alpha.owner).delete(`/documents/${doc.documentId}`).expect(200);
      expect((await t.as(null).get(`/public/shared-documents/${last.token}`)).status).toBe(403);
      expect((await t.sys.documentShare.findUniqueOrThrow({ where: { id: last.id } })).revokedAt).not.toBeNull();
    });
  });

  describe('deletion, legal hold and retention', () => {
    it('soft-deletes with a purge date, can restore, and blocks deletion under legal hold or while a request is open', async () => {
      const open = await createRequest(t, alpha, customerId);
      const inUse = await uploadDocument(t, receptionist, { requestId: open.id });
      const blocked = await t.as(alpha.owner).delete(`/documents/${inUse.documentId}`);
      expect(blocked.status).toBe(409);
      expect(blocked.body.code).toBe('DOCUMENT_IN_USE');
      // Also when the document is only linked through another request's checklist.
      const vaultDoc = await uploadDocument(t, receptionist, { customerId });
      const item = await addChecklistItem(t, alpha, open.id, 'passport', { documentId: vaultDoc.documentId, status: 'UPLOADED' });
      expect((await t.as(alpha.owner).delete(`/documents/${vaultDoc.documentId}`)).body.code).toBe('DOCUMENT_IN_USE');
      await t.sys.requestDocument.delete({ where: { id: item.id } });

      await t.as(alpha.owner).put(`/documents/${vaultDoc.documentId}/legal-hold`, { legalHold: true }).expect(400); // reason required
      await t.as(alpha.owner).put(`/documents/${vaultDoc.documentId}/legal-hold`, { legalHold: true, reason: 'Dispute with customer, ref 2231' }).expect(200);
      const held = await t.as(alpha.owner).delete(`/documents/${vaultDoc.documentId}`);
      expect(held.status).toBe(409);
      expect(held.body.code).toBe('LEGAL_HOLD');
      await t.as(alpha.owner).put(`/documents/${vaultDoc.documentId}/legal-hold`, { legalHold: false, reason: 'Dispute closed' }).expect(200);
      expect(await t.sys.auditLog.count({ where: { resourceId: vaultDoc.documentId, action: { in: ['document.legal_hold_set', 'document.legal_hold_released'] } } })).toBe(2);

      const del = await t.as(alpha.owner).delete(`/documents/${vaultDoc.documentId}`).expect(200);
      expect(del.body.status).toBe('DELETED');
      const purgeAt = new Date(del.body.purgeAfter).getTime();
      expect(purgeAt).toBeGreaterThan(Date.now() + 29 * DAY);
      expect(purgeAt).toBeLessThan(Date.now() + 31 * DAY);
      // Gone for normal use, but the file still exists until the purge date.
      await t.as(receptionist).post(`/documents/${vaultDoc.documentId}/download-link`).expect(404);
      await t.as(customer).get(`/documents/${vaultDoc.documentId}`).expect(404);
      expect((await t.as(receptionist).get(`/documents?customerId=${customerId}&pageSize=100`)).body.data.map((d: any) => d.id)).not.toContain(vaultDoc.documentId);
      expect((await t.as(receptionist).get(`/documents?customerId=${customerId}&includeDeleted=true&pageSize=100`)).body.data.map((d: any) => d.id)).toContain(vaultDoc.documentId);
      expect(await storage.head((await versionRow(vaultDoc.versionId)).storageKey)).not.toBeNull();
      await purge();
      expect(await storage.head((await versionRow(vaultDoc.versionId)).storageKey)).not.toBeNull();
      await t.as(alpha.owner).delete(`/documents/${vaultDoc.documentId}`).expect(200); // repeating is harmless

      const restored = await t.as(alpha.owner).post(`/documents/${vaultDoc.documentId}/restore`).expect(200);
      expect(restored.body).toMatchObject({ status: 'AVAILABLE', deletedAt: null, purgeAfter: null });
      await t.as(receptionist).post(`/documents/${vaultDoc.documentId}/download-link`).expect(200);
      await t.as(alpha.owner).post(`/documents/${vaultDoc.documentId}/restore`).expect(409);
    });

    it('the purge job removes files past purgeAfter exactly once and gives the storage back', async () => {
      const doc = await uploadDocument(t, receptionist, { customerId });
      const v2 = await uploadDocument(t, receptionist, { replacesDocumentId: doc.documentId });
      const keys = [(await versionRow(doc.versionId)).storageKey, (await versionRow(v2.versionId)).storageKey];
      const onHold = await uploadDocument(t, receptionist, { customerId });
      const before = await usageBytes();
      await t.as(alpha.owner).delete(`/documents/${doc.documentId}`).expect(200);
      await t.as(alpha.owner).delete(`/documents/${onHold.documentId}`).expect(200);
      const past = new Date(Date.now() - 1000);
      await t.sys.document.updateMany({ where: { id: { in: [doc.documentId, onHold.documentId] } }, data: { purgeAfter: past } });
      // A legal hold placed after deletion still protects the files.
      await t.as(alpha.owner).put(`/documents/${onHold.documentId}/legal-hold`, { legalHold: true, reason: 'Regulator enquiry' }).expect(200);

      await purge();
      for (const key of keys) expect(await storage.head(key)).toBeNull();
      expect(await versionRow(doc.versionId)).toMatchObject({ uploadStatus: 'PURGED', originalFilename: 'purged', sha256: null });
      expect((await versionRow(v2.versionId)).uploadStatus).toBe('PURGED');
      expect(await usageBytes()).toBe(before - doc.content.length - v2.content.length);
      expect(await storage.head((await versionRow(onHold.versionId)).storageKey)).not.toBeNull();
      expect((await versionRow(onHold.versionId)).uploadStatus).toBe('COMPLETED');
      expect(await t.sys.auditLog.count({ where: { action: 'document.purged', resourceId: doc.documentId, actorType: 'SYSTEM' } })).toBe(1);
      expect(await t.sys.documentAccessLog.count({ where: { documentId: doc.documentId, action: 'PURGED' } })).toBe(1);

      // Idempotent: a second run finds nothing to do and does not touch the usage counter again.
      await purge();
      expect(await usageBytes()).toBe(before - doc.content.length - v2.content.length);
      expect(await t.sys.auditLog.count({ where: { action: 'document.purged', resourceId: doc.documentId } })).toBe(1);
      const gone = await t.as(alpha.owner).post(`/documents/${doc.documentId}/restore`);
      expect(gone.status).toBe(409);
      expect(gone.body.code).toBe('DOCUMENT_PURGED');
    });

    it('applies DOCUMENT retention policies, counted from request completion or upload date', async () => {
      const tenant = await t.createTenant();
      const staff = tenant.owner;
      const c = await createCustomer(t, tenant);
      await t.sys.dataRetentionPolicy.deleteMany({ where: { tenantId: tenant.id } });
      await t.sys.dataRetentionPolicy.createMany({
        data: [
          { tenantId: tenant.id, entity: 'DOCUMENT', documentTypeKey: null, retainDays: 100, action: 'DELETE' },
          { tenantId: tenant.id, entity: 'DOCUMENT', documentTypeKey: 'photo', retainDays: 10, action: 'DELETE' },
          { tenantId: tenant.id, entity: 'DOCUMENT', documentTypeKey: 'certificate', retainDays: 1, action: 'DELETE', isActive: false },
          { tenantId: tenant.id, entity: 'CUSTOMER', documentTypeKey: null, retainDays: 1, action: 'ANONYMISE' },
        ],
      });
      const ago = (days: number) => new Date(Date.now() - days * DAY);
      const closedLongAgo = await createRequest(t, tenant, c.id, { status: 'COMPLETED', completedAt: ago(150) });
      const closedRecently = await createRequest(t, tenant, c.id, { status: 'COMPLETED', completedAt: ago(20) });
      const cancelledLongAgo = await createRequest(t, tenant, c.id, { status: 'CANCELLED', cancelledAt: ago(101) });
      const stillOpen = await createRequest(t, tenant, c.id, { status: 'IN_PREPARATION' });
      const up = async (fields: Record<string, unknown>, createdDaysAgo?: number) => {
        const d = await uploadDocument(t, staff, { customerId: c.id, ...fields });
        if (createdDaysAgo) await t.sys.document.update({ where: { id: d.documentId }, data: { createdAt: ago(createdDaysAgo) } });
        return d;
      };
      const expired = {
        oldVaultDoc: await up({}, 120),
        oldRequestDoc: await up({ requestId: closedLongAgo.id }, 200),
        cancelledRequestDoc: await up({ requestId: cancelledLongAgo.id }, 200),
        oldPhoto: await up({ documentTypeKey: 'photo' }, 11),
      };
      const kept = {
        youngVaultDoc: await up({}, 99),
        recentRequestDoc: await up({ requestId: closedRecently.id }, 500),
        openRequestDoc: await up({ requestId: stillOpen.id }, 500),
        youngPhoto: await up({ documentTypeKey: 'photo' }, 9),
        // An old photo is governed by its own 10-day policy, an old certificate by the general one
        // (its specific policy is switched off but still claims the type).
        inactivePolicyType: await up({ documentTypeKey: 'certificate' }, 50),
        legalHold: await up({}, 400),
        retentionUntil: await up({}, 400),
        linkedToOpenChecklist: await up({}, 400),
      };
      await t.sys.document.update({ where: { id: kept.legalHold.documentId }, data: { legalHold: true } });
      await t.sys.document.update({ where: { id: kept.retentionUntil.documentId }, data: { retentionUntil: new Date(Date.now() + 5 * DAY) } });
      await addChecklistItem(t, tenant, stillOpen.id, 'passport', { documentId: kept.linkedToOpenChecklist.documentId });
      const before = await usageBytes(tenant.id);

      const report = await t.inTenant(tenant.id, () => t.get(DocumentRetentionService).purgeTenant());
      expect(report).toMatchObject({ retentionDeleted: 4, purgedDocuments: 4, purgedFiles: 4 });
      for (const [name, d] of Object.entries(expired)) {
        expect([name, (await docRow(d.documentId)).status, (await versionRow(d.versionId)).uploadStatus]).toEqual([name, 'DELETED', 'PURGED']);
        expect(await storage.head((await versionRow(d.versionId)).storageKey)).toBeNull();
      }
      for (const [name, d] of Object.entries(kept)) {
        expect([name, (await docRow(d.documentId)).status, (await versionRow(d.versionId)).uploadStatus]).toEqual([name, 'AVAILABLE', 'COMPLETED']);
      }
      expect(await usageBytes(tenant.id)).toBe(before - report.bytesFreed);
      expect(report.bytesFreed).toBe(Object.values(expired).reduce((n, d) => n + d.content.length, 0));
      const audit = await t.sys.auditLog.findFirstOrThrow({ where: { tenantId: tenant.id, action: 'document.retention_expired', resourceId: expired.oldPhoto.documentId } });
      expect(audit).toMatchObject({ actorType: 'SYSTEM', summary: 'Retention policy: keep 10 days (photo).' });
      // Nothing more to do on the next run; the customer record is untouched (CUSTOMER policies are not applied by this job).
      expect(await t.inTenant(tenant.id, () => t.get(DocumentRetentionService).purgeTenant())).toMatchObject({ retentionDeleted: 0, purgedDocuments: 0, purgedFiles: 0, bytesFreed: 0 });
      expect((await t.sys.customer.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('ACTIVE');
    });

    it('cleans up upload intents that were never completed', async () => {
      const content = pdfBytes();
      const body = { customerId, documentTypeKey: 'passport', filename: 'never.pdf', mime: 'application/pdf', sizeBytes: content.length };
      const abandoned = (await t.as(receptionist).post('/documents/upload-intents', body).expect(201)).body;
      const uploadedOnly = (await t.as(receptionist).post('/documents/upload-intents', body).expect(201)).body;
      await putToUploadUrl(t, uploadedOnly.upload, content);
      const fresh = (await t.as(receptionist).post('/documents/upload-intents', body).expect(201)).body;
      // Pending intents are not documents yet.
      const list = await t.as(receptionist).get(`/documents?customerId=${customerId}&q=never.pdf`).expect(200);
      expect(list.body.data).toEqual([]);
      await t.sys.documentVersion.updateMany({ where: { id: { in: [abandoned.versionId, uploadedOnly.versionId] } }, data: { uploadExpiresAt: new Date(Date.now() - 2 * 3600_000) } });
      const before = await usageBytes();
      await purge();
      for (const intent of [abandoned, uploadedOnly]) {
        expect((await versionRow(intent.versionId)).uploadStatus).toBe('FAILED');
        expect((await docRow(intent.documentId)).status).toBe('DELETED');
        expect(await storage.promote((await versionRow(intent.versionId)).storageKey)).toBeNull();
        expect((await t.as(receptionist).post(`/documents/${intent.documentId}/versions/${intent.versionId}/complete`)).body.code).toBe('UPLOAD_REJECTED');
      }
      expect((await versionRow(fresh.versionId)).uploadStatus).toBe('PENDING');
      expect(await usageBytes()).toBe(before);
    });

    it('registers the daily purge schedule', () => {
      expect(t.jobs.schedules().find((s) => s.name === 'documents.purge')).toMatchObject({ cron: '30 22 * * *' });
      expect(t.jobs.names()).toEqual(expect.arrayContaining(['documents.purge', 'documents.scan']));
    });
  });

  describe('DocumentStorePort (generated files from other modules)', () => {
    it('stores a generated file in the vault, available at once and visible to the customer', async () => {
      const port = t.get(DocumentStorePort as any) as DocumentStorePort;
      const request = await createRequest(t, alpha, customerId);
      const content = Buffer.from('%PDF-1.4\n% generated receipt\n%%EOF\n');
      const before = await usageBytes();
      const out = await t.inTenant(alpha.id, () =>
        t.db.tx(() => port.storeGenerated({ customerId, requestId: request.id, documentTypeKey: 'completed_document', title: 'Typed application', filename: 'application.pdf', mime: 'application/pdf', content, isCompletionDocument: true })),
      );
      expect(await docRow(out.documentId)).toMatchObject({ status: 'AVAILABLE', isCompletionDocument: true, customerVisible: true, uploadedByType: 'SYSTEM', currentVersionId: out.versionId });
      expect(await versionRow(out.versionId)).toMatchObject({ scanStatus: 'SKIPPED', scanEngine: 'system-generated', uploadStatus: 'COMPLETED', sha256: sha256(content) });
      expect(await usageBytes()).toBe(before + content.length);
      expect(await eventsFor('document.uploaded', out.documentId)).toEqual([expect.objectContaining({ requestId: request.id, generated: true, isCompletionDocument: true, uploadedByType: 'SYSTEM' })]);

      // Trusted platform output stays downloadable even when uploads require a clean scan.
      const config = env() as any;
      config.REQUIRE_CLEAN_SCAN = true;
      try {
        const link = await t.as(customer).post(`/documents/${out.documentId}/download-link`).expect(200);
        expect(sha256((await fetchBytes(t, link.body.url)).body)).toBe(sha256(content));
      } finally {
        config.REQUIRE_CLEAN_SCAN = false;
      }
      // A rolled-back caller transaction leaves no document behind.
      await expect(
        t.inTenant(alpha.id, () =>
          t.db.tx(async () => {
            await port.storeGenerated({ customerId, documentTypeKey: 'other', title: 'Rolled back', filename: 'x.pdf', mime: 'application/pdf', content });
            throw new Error('caller failed');
          }),
        ),
      ).rejects.toThrow('caller failed');
      expect(await t.sys.document.count({ where: { tenantId: alpha.id, title: 'Rolled back' } })).toBe(0);
      expect(await usageBytes()).toBe(before + content.length);
      // References are validated inside the tenant.
      const foreign = await createCustomer(t, beta);
      await expect(t.inTenant(alpha.id, () => port.storeGenerated({ customerId: foreign.id, documentTypeKey: 'other', title: 'x', filename: 'x.pdf', mime: 'application/pdf', content }))).rejects.toThrow(/not found/i);
    });
  });

  describe('checklist assistance', () => {
    it('reports each checklist line as missing, present, expiring, expired, unverified or rejected without changing anything', async () => {
      const c = await t.addCustomer(alpha);
      const request = await createRequest(t, alpha, c.customerId!, { status: 'AWAITING_CUSTOMER' });
      const day = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);
      const mk = async (type: string, expiry: string | null, verify: 'APPROVED' | 'REJECTED' | null, fields: Record<string, unknown> = {}) => {
        const d = await uploadDocument(t, receptionist, { customerId: c.customerId, documentTypeKey: type, ...(expiry ? { expiryDate: expiry } : {}), ...fields });
        if (verify) await t.as(reviewer).post(`/documents/${d.documentId}/verify`, { decision: verify, reason: 'Blurry scan' }).expect(200);
        return d.documentId;
      };
      const verified = await mk('passport', day(800), 'APPROVED');
      const expiring = await mk('emirates_id', day(60), 'APPROVED');
      const expiredDoc = await mk('residence_visa', day(-3), 'APPROVED');
      const unverified = await mk('photo', null, null);
      const rejected = await mk('certificate', null, 'REJECTED');
      const spareLicence = await mk('trade_licence', day(400), 'APPROVED');
      const hidden = await mk('labour_card', null, 'APPROVED', { customerVisible: false });
      const line = (type: string, documentId: string | null, extra: Record<string, unknown> = {}) => addChecklistItem(t, alpha, request.id, type, { documentId, sortOrder: order++, ...extra });
      let order = 0;
      await line('passport', verified, { status: 'VERIFIED' });
      await line('emirates_id', expiring, { status: 'VERIFIED' });
      await line('residence_visa', expiredDoc, { status: 'VERIFIED' });
      await line('photo', unverified, { status: 'UPLOADED' });
      await line('certificate', rejected, { status: 'REJECTED' });
      const missing = await line('trade_licence', null);
      await line('tenancy_contract', null, { status: 'WAIVED' });
      await line('labour_card', hidden, { status: 'VERIFIED', isMandatory: false });
      await line('completed_document', null, { kind: 'COMPLETION' });
      const snapshot = JSON.stringify(await t.sys.requestDocument.findMany({ where: { requestId: request.id }, orderBy: { sortOrder: 'asc' } }));

      const res = await t.as(receptionist).get(`/documents/checklist-assist?requestId=${request.id}`).expect(200);
      expect(res.body.items.map((i: any) => [i.documentTypeKey, i.state])).toEqual([
        ['passport', 'PRESENT'], ['emirates_id', 'EXPIRING'], ['residence_visa', 'EXPIRED'], ['photo', 'UNVERIFIED'], ['certificate', 'REJECTED'],
        ['trade_licence', 'MISSING'], ['tenancy_contract', 'WAIVED'], ['labour_card', 'PRESENT'], ['completed_document', 'MISSING'],
      ]);
      expect(res.body.items[1]).toMatchObject({ daysToExpiry: 60, expiryDate: day(60), documentId: expiring });
      expect(res.body.items[2].daysToExpiry).toBe(-3);
      // A document already in the customer's vault is suggested for the missing line, never attached.
      expect(res.body.items[5].candidates).toEqual([expect.objectContaining({ documentId: spareLicence, verificationStatus: 'VERIFIED' })]);
      expect(res.body.summary).toMatchObject({ total: 9, missing: 2, expired: 1, expiring: 1, unverified: 1, rejected: 1, present: 2, waived: 1, mandatoryInputsProvided: false });
      expect(res.body.summary.missingMandatory).toHaveLength(3); // expired visa, rejected certificate, missing licence
      expect(res.body.summary.missingMandatory).toContain(missing.id);
      expect(JSON.stringify(await t.sys.requestDocument.findMany({ where: { requestId: request.id }, orderBy: { sortOrder: 'asc' } }))).toBe(snapshot);

      // The customer gets the same view of their own request, minus documents hidden from them.
      const own = await t.as(c).get(`/documents/checklist-assist?requestId=${request.id}`).expect(200);
      expect(own.body.items.find((i: any) => i.documentTypeKey === 'labour_card')).toMatchObject({ state: 'MISSING', documentId: null });
      expect(own.body.items.find((i: any) => i.documentTypeKey === 'passport').state).toBe('PRESENT');
      // Not for other customers, other tenants or roles without document access.
      await t.as(customer).get(`/documents/checklist-assist?requestId=${request.id}`).expect(404);
      await t.as(beta.owner).get(`/documents/checklist-assist?requestId=${request.id}`).expect(404);
      await t.as(await t.addStaff(alpha, 'accountant')).get(`/documents/checklist-assist?requestId=${request.id}`).expect(403);
      await t.as(receptionist).get('/documents/checklist-assist').expect(400);
    });
  });
});
