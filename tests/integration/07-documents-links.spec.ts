import { eicarTestContent } from '../../services/api/src/modules/documents/malware';
import { Actor, anonymous, api, Centre, downloadDocument, expectRefused, fetchLink, inviteStaff, pathOf, pdf, registerPortalCustomer, signUpCentre, sleep, TestApp, uniq, uploadDocument, Uploaded, withOperatorSetting } from '../support';

/**
 * Scenario 28: an expired document download URL is rejected - and the other
 * ways a link to an identity document must stop working.
 *
 * Files are never served by the JSON API; clients get short-lived signed URLs.
 * To see a real expiry without waiting two minutes, the operator setting for the
 * lifetime of links is lowered to a second or two for the duration of a test (the
 * same thing DOWNLOAD_URL_TTL_SECONDS=2 would do) and the test really waits.
 * Share links live for at least an hour, so there the stored expiry time is
 * moved into the past in the database - the one case of "time travel" in this
 * file.
 */
describe('Document links (scenario 28)', () => {
  let t: TestApp;
  let centre: Centre;
  let manager: Actor;
  let customer: Actor;
  let stranger: Actor;
  let passport: Uploaded;
  const id = uniq();

  /** Waits until a link's own expiry time has certainly passed (links are valid for whole seconds). */
  const waitPast = async (expiresAt: string) => sleep(Math.max(0, new Date(expiresAt).getTime() - Date.now()) + 1300);

  beforeAll(async () => {
    t = await TestApp.create();
    centre = await signUpCentre(t, { name: `Vault Centre ${id}` });
    manager = await inviteStaff(t, centre, 'manager');
    customer = await registerPortalCustomer(t, centre, { fullName: 'Document Owner', email: `owner-of-docs-${id}@example.test` });
    stranger = await registerPortalCustomer(t, centre, { fullName: 'Curious Stranger' });
    passport = await uploadDocument(t, customer, { documentTypeKey: 'passport', expiryDate: '2032-03-31' }, pdf('passport', 'passport.pdf', 2000));
  });
  afterAll(() => t.close());

  it('S28 expired document download URL is rejected', async () => {
    // Two seconds, not one: the link has to be fetched "in time" first, also on a busy machine.
    const restore = withOperatorSetting('DOWNLOAD_URL_TTL_SECONDS', 2);
    try {
      const link = await api(t, customer).post(`/documents/${passport.documentId}/download-link`, {});
      // The answer is honest about how long the link lives.
      const lifetime = new Date(link.expiresAt).getTime() - Date.now();
      expect(lifetime).toBeLessThanOrEqual(2000);
      expect(lifetime).toBeGreaterThan(0);

      // In time: the file.
      const inTime = await fetchLink(t, link.url);
      expect(inTime.status).toBe(200);
      expect((inTime.body as Buffer).equals(passport.content)).toBe(true);

      // Too late: refused, and not a single byte of the file is in the answer.
      await waitPast(link.expiresAt);
      const late = await fetchLink(t, link.url);
      expectRefused(late, 403);
      expect(JSON.parse((late.body as Buffer).toString('utf8')).code).toBe('LINK_EXPIRED');
      expect((late.body as Buffer).includes(passport.content.subarray(0, 64))).toBe(false);
      // Asking again and again does not help.
      expectRefused(await fetchLink(t, link.url), 403);

      // The same holds for an inline preview link ...
      const preview = await api(t, customer).post(`/documents/${passport.documentId}/preview-link`, {});
      expect(preview.disposition).toBe('inline');
      expect((await fetchLink(t, preview.url)).status).toBe(200);
      await waitPast(preview.expiresAt);
      expectRefused(await fetchLink(t, preview.url), 403);

      // ... while the document itself is fine: the owner simply asks for a new link.
      const fresh = await downloadDocument(t, customer, passport.documentId);
      expect(fresh.bytes.equals(passport.content)).toBe(true);
      expect(fresh.link.url).not.toBe(link.url);
    } finally {
      restore();
    }
    // With the normal setting a link lives minutes, not hours or days.
    const normal = await api(t, customer).post(`/documents/${passport.documentId}/download-link`, {});
    const minutes = (new Date(normal.expiresAt).getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(0.5);
    expect(minutes).toBeLessThanOrEqual(15);
  });

  it('S28 a link cannot be forged, extended or obtained by somebody else', async () => {
    const link = await api(t, customer).post(`/documents/${passport.documentId}/download-link`, {});
    const path = pathOf(link.url);
    const token = path.split('/').pop()!;
    const [body, signature] = token.split('.');
    expect(signature).toBeTruthy();

    // A changed signature, a changed payload (the classic: push the expiry a year ahead), and nonsense.
    const flipped = `${signature.slice(0, -2)}${signature.endsWith('AA') ? 'BB' : 'AA'}`;
    expectRefused(await fetchLink(t, path.replace(token, `${body}.${flipped}`)), 403);
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    expect(typeof payload.exp).toBe('number');
    const extended = Buffer.from(JSON.stringify({ ...payload, exp: payload.exp + 365 * 86_400 })).toString('base64url');
    expectRefused(await fetchLink(t, path.replace(token, `${extended}.${signature}`)), 403);
    expectRefused(await fetchLink(t, path.replace(token, 'not-a-token')), 403);
    expectRefused(await fetchLink(t, path.replace(token, `${body}.`)), 403);
    // The token says nothing readable about where the file lives.
    expect(JSON.stringify(payload)).not.toContain(passport.documentId);
    expect(JSON.stringify(payload)).not.toContain('passport.pdf');
    // A download ticket is not an upload ticket.
    expectRefused(await t.http.put(path.replace('/download/', '/upload/')).set('Content-Type', 'application/pdf').send(passport.content), 403);

    // Only somebody who may see the document can get a link at all.
    expectRefused(await anonymous(t).req('POST', `/documents/${passport.documentId}/download-link`, {}), 401);
    expectRefused(await api(t, stranger).req('POST', `/documents/${passport.documentId}/download-link`, {}), 404);
    expectRefused(await api(t, stranger).req('POST', `/documents/${passport.documentId}/preview-link`, {}), 404);
    // The untouched link still works (the attempts above did not burn it), and each link is on the access log.
    expect((await fetchLink(t, link.url)).status).toBe(200);
    const log = await api(t, centre.owner).get(`/documents/${passport.documentId}/access-logs?pageSize=100`);
    expect(log.data.filter((e: any) => /DOWNLOAD|PREVIEW/.test(e.action)).length).toBeGreaterThanOrEqual(2);
  });

  it('S28 an expired upload URL cannot be used', async () => {
    const restore = withOperatorSetting('UPLOAD_URL_TTL_SECONDS', 1);
    try {
      const file = pdf('late upload', 'late.pdf');
      const intent = await api(t, customer).post('/documents/upload-intents', { documentTypeKey: 'other', filename: file.filename, mime: file.mime, sizeBytes: file.content.length }, 201);
      await waitPast(intent.upload.expiresAt);
      let put = t.http.put(pathOf(intent.upload.url));
      for (const [k, v] of Object.entries(intent.upload.headers ?? {})) put = put.set(k, v as string);
      expectRefused(await put.send(file.content), 403, 'LINK_EXPIRED');
      // Nothing arrived, so nothing can be completed or downloaded.
      expectRefused(await api(t, customer).req('POST', `/documents/${intent.documentId}/versions/${intent.versionId}/complete`), 409);
      expectRefused(await api(t, customer).req('POST', `/documents/${intent.documentId}/download-link`, {}), 409, 'DOCUMENT_NOT_READY');
    } finally {
      restore();
    }
  });

  it('S28 a share link expires, runs out of downloads and can be revoked', async () => {
    const m = api(t, manager);
    const open = (token: string) => anonymous(t).req('GET', `/public/shared-documents/${token}`);
    // Customers cannot create share links; staff with the permission can.
    expectRefused(await api(t, customer).req('POST', `/documents/${passport.documentId}/shares`, {}), 403);

    // --- expiry
    const share = await m.post(`/documents/${passport.documentId}/shares`, { expiresInHours: 1, maxDownloads: 5, recipient: 'Sample recipient (fictional)' }, 201);
    expect(share.token).toBeTruthy();
    const redeemed = await open(share.token);
    expect(redeemed.status).toBe(200);
    expect(redeemed.body.remainingDownloads).toBe(4);
    const file = await fetchLink(t, redeemed.body.download.url);
    expect((file.body as Buffer).equals(passport.content)).toBe(true);
    // The token is shown once: the list of shares never contains it.
    const listed = await m.get(`/documents/${passport.documentId}/shares`);
    expect(JSON.stringify(listed)).not.toContain(share.token);
    // Time travel (database): the hour is over.
    await t.sys.documentShare.update({ where: { id: share.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expectRefused(await open(share.token), 403, 'LINK_EXPIRED');
    expectRefused(await open(share.token), 403, 'LINK_EXPIRED');

    // --- download limit
    const once = await m.post(`/documents/${passport.documentId}/shares`, { maxDownloads: 1 }, 201);
    expect((await open(once.token)).status).toBe(200);
    expectRefused(await open(once.token), 403, 'LINK_EXPIRED');

    // --- revocation
    const revocable = await m.post(`/documents/${passport.documentId}/shares`, {}, 201);
    await m.delete(`/documents/${passport.documentId}/shares/${revocable.id}`, [200, 204]);
    expectRefused(await open(revocable.token), 403, 'LINK_EXPIRED');
    // A guessed token gets the same answer as an expired one.
    expectRefused(await open('x'.repeat(43)), 404);
  });

  it('S28 a quarantined or deleted document gives no link, also to its owner', async () => {
    // A file that carries the EICAR anti-malware test string (harmless by design) is quarantined by the scan job.
    const infected = { content: Buffer.concat([Buffer.from('%PDF-1.4\n'), eicarTestContent(), Buffer.from('\n%%EOF\n')]), filename: 'scan.pdf', mime: 'application/pdf' };
    const bad = await uploadDocument(t, customer, { documentTypeKey: 'other' }, infected);
    const doc = await api(t, customer).get(`/documents/${bad.documentId}`);
    expect(doc).toMatchObject({ status: 'QUARANTINED', downloadable: false });
    expectRefused(await api(t, customer).req('POST', `/documents/${bad.documentId}/download-link`, {}), 409, 'DOCUMENT_QUARANTINED');
    expectRefused(await api(t, manager).req('POST', `/documents/${bad.documentId}/download-link`, {}), 409, 'DOCUMENT_QUARANTINED');
    expectRefused(await api(t, manager).req('POST', `/documents/${bad.documentId}/shares`, {}), 409, 'DOCUMENT_QUARANTINED');

    // A clean document that staff delete: links stop being issued; after a restore they are issued again.
    const clean = await uploadDocument(t, customer, { documentTypeKey: 'other' }, pdf('to be deleted', 'old-letter.pdf'));
    await downloadDocument(t, customer, clean.documentId);
    const share = await api(t, manager).post(`/documents/${clean.documentId}/shares`, {}, 201);
    await api(t, centre.owner).delete(`/documents/${clean.documentId}`, [200, 204]);
    expectRefused(await api(t, customer).req('POST', `/documents/${clean.documentId}/download-link`, {}), 404);
    expectRefused(await anonymous(t).req('GET', `/public/shared-documents/${share.token}`), 403, 'LINK_EXPIRED'); // share links die with the document
    await api(t, centre.owner).post(`/documents/${clean.documentId}/restore`, {}, [200, 201]);
    const back = await downloadDocument(t, customer, clean.documentId);
    expect(back.bytes.equals(clean.content)).toBe(true);
  });
});
