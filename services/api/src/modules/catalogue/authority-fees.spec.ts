import { Actor, TenantFixture, TestApp } from '../../../test/helpers';

describe('Authority fee catalogue (maintained by TypEase)', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let admin: Actor;
  let support: Actor;
  let feeId: string;
  let categoryId: string;

  beforeAll(async () => {
    t = await TestApp.create();
    alpha = await t.createTenant({ name: 'Alpha Typing' });
    beta = await t.createTenant({ name: 'Beta Typing' });
    admin = await t.createPlatformAdmin();
    support = await t.createPlatformAdmin('SUPPORT_AGENT');
    categoryId = (await t.sys.serviceCategory.findFirstOrThrow({ where: { tenantId: alpha.id } })).id;
  });
  afterAll(() => t.close());

  it('starts with sample entries, clearly marked as samples', async () => {
    const list = (await t.as(alpha.owner).get('/authority-fees').expect(200)).body;
    expect(list.length).toBeGreaterThan(10);
    expect(list.every((f: { isSample: boolean; verifiedAt: string | null }) => f.isSample && f.verifiedAt === null)).toBe(true);
    expect((await t.as(alpha.owner).get('/authority-fees').query({ authority: 'ICP' }).expect(200)).body.map((f: { authority: string }) => f.authority)).toEqual(expect.arrayContaining(['ICP']));
  });

  it('only TypEase staff with the right permission maintain it; centres can only read', async () => {
    await t.as(support).get('/platform/authority-fees').expect(403);
    await t.as(alpha.owner).post('/platform/authority-fees', {}).expect(403);
    const created = await t.as(admin).post('/platform/authority-fees', { authority: 'AMER', code: 'test-golden', name: 'Golden visa - typing', governmentFee: '1000.00', thirdPartyFee: '100.00', isSample: false, verifiedAt: '2026-10-01', sourceUrl: 'https://example.test/fees' }).expect(201);
    expect(created.body).toMatchObject({ code: 'TEST-GOLDEN', version: 1, isSample: false, verifiedAt: '2026-10-01' });
    feeId = created.body.id;
    await t.as(admin).post('/platform/authority-fees', { authority: 'AMER', code: 'TEST-GOLDEN', name: 'Again', governmentFee: '1' }).expect(409);
    await t.as(admin).post('/platform/authority-fees', { authority: 'NOWHERE', code: 'X1', name: 'Bad', governmentFee: '1' }).expect(400);
  });

  let serviceId: string;
  it('a centre imports an entry as its own service with its own service fee', async () => {
    const imported = await t.as(alpha.owner).post(`/authority-fees/${feeId}/import`, { categoryId, code: 'GOLD-TYPING', serviceFee: '250.00' }).expect(201);
    serviceId = imported.body.id;
    expect(imported.body).toMatchObject({ name: 'Golden visa - typing', authorityFeeId: feeId, authorityFeeVersion: 1, price: { serviceFee: '250', governmentFeeEstimate: '1000', thirdPartyFeeEstimate: '100' } });
    const entry = (await t.as(alpha.owner).get('/authority-fees').query({ q: 'golden' }).expect(200)).body[0];
    expect(entry.services).toEqual([expect.objectContaining({ id: serviceId, upToDate: true })]);
    // Another centre sees the entry, not alpha's service.
    expect((await t.as(beta.owner).get('/authority-fees').query({ q: 'golden' }).expect(200)).body[0].services).toEqual([]);
    expect((await t.as(alpha.owner).get('/authority-fees/updates').expect(200)).body).toEqual([]);
  });

  it('a change of the amounts is a new version; centres apply it when they choose', async () => {
    await t.as(admin).patch(`/platform/authority-fees/${feeId}`, { version: 1, notes: 'Wording only' }).expect(200).expect((r) => expect(r.body.version).toBe(1));
    await t.as(admin).patch(`/platform/authority-fees/${feeId}`, { version: 5, governmentFee: '1100.00' }).expect(409);
    const changed = await t.as(admin).patch(`/platform/authority-fees/${feeId}`, { version: 1, governmentFee: '1100.00', changeNote: 'New fee from 1 November' }).expect(200);
    expect(changed.body.version).toBe(2);
    expect((await t.as(admin).get(`/platform/authority-fees/${feeId}/history`).expect(200)).body).toEqual([expect.objectContaining({ version: 2, governmentFeeBefore: '1000.00', governmentFeeAfter: '1100.00', note: 'New fee from 1 November' })]);
    expect((await t.as(admin).get('/platform/authority-fees').query({ q: 'golden' }).expect(200)).body[0].linkedServices).toBe(1);

    const updates = (await t.as(alpha.owner).get('/authority-fees/updates').expect(200)).body;
    expect(updates).toEqual([expect.objectContaining({ serviceId, current: { serviceFee: '250.00', governmentFee: '1000.00', thirdPartyFee: '100.00' }, proposed: { governmentFee: '1100.00', thirdPartyFee: '100.00' } })]);
    // Nothing changes on its own.
    expect((await t.sys.servicePrice.findFirstOrThrow({ where: { serviceId, isActive: true } })).governmentFeeEstimate.toFixed(2)).toBe('1000.00');

    const operator = await t.addStaff(alpha, 'operator');
    await t.as(operator).post('/authority-fees/updates/apply', { serviceIds: [serviceId] }).expect(403);
    await t.as(beta.owner).post('/authority-fees/updates/apply', { serviceIds: [serviceId] }).expect(404);
    expect((await t.as(alpha.owner).post('/authority-fees/updates/apply', { serviceIds: [serviceId] }).expect(201)).body).toEqual({ services: 1, prices: 1 });
    const prices = await t.sys.servicePrice.findMany({ where: { serviceId }, orderBy: { createdAt: 'asc' } });
    expect(prices.map((p) => [p.isActive, p.serviceFee.toFixed(2), p.governmentFeeEstimate.toFixed(2)])).toEqual([
      [false, '250.00', '1000.00'],
      [true, '250.00', '1100.00'],
    ]);
    expect((await t.as(alpha.owner).get('/authority-fees/updates').expect(200)).body).toEqual([]);
  });

  it('an existing service can follow an entry, and stop following', async () => {
    const own = await t.sys.service.create({ data: { tenantId: alpha.id, categoryId, code: 'EID-OWN', name: 'Emirates ID typing' } });
    await t.sys.servicePrice.create({ data: { tenantId: alpha.id, serviceId: own.id, serviceFee: '60.00', governmentFeeEstimate: '250.00', validFrom: new Date(Date.now() - 1000) } });
    const eid = (await t.as(alpha.owner).get('/authority-fees').query({ q: 'ICP-EID-RENEW-2Y' }).expect(200)).body[0];
    await t.as(alpha.owner).put(`/services/${own.id}/authority-fee`, { authorityFeeId: eid.id }).expect(200);
    expect((await t.as(alpha.owner).get('/authority-fees/updates').expect(200)).body.map((u: { serviceId: string }) => u.serviceId)).toEqual([own.id]);
    await t.as(beta.owner).put(`/services/${own.id}/authority-fee`, { authorityFeeId: null }).expect(404);
    await t.as(alpha.owner).put(`/services/${own.id}/authority-fee`, { authorityFeeId: null }).expect(200);
    expect((await t.as(alpha.owner).get('/authority-fees/updates').expect(200)).body).toEqual([]);
  });

  it('centres cannot change the catalogue even directly in the database', async () => {
    await expect(t.inTenant(alpha.id, () => t.db.tx((tx) => tx.authorityFee.update({ where: { id: feeId }, data: { governmentFee: 1 } })))).rejects.toThrow();
  });
});
