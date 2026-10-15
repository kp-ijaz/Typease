import { Actor, PASSWORD, TenantFixture, TestApp, uniq } from '../../../test/helpers';
import { DomainEvents } from '../../common/events.service';
import { blindIndex, decryptText } from '../../common/crypto';
import { createCustomer, customerBody, seedEverything, seedInvoice, seedRequest, uniqueEmiratesId, uniquePassport, uniquePhone } from './fixtures';

describe('Customers', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let receptionist: Actor;
  let manager: Actor;
  let operator: Actor;
  let portalCustomer: Actor;

  beforeAll(async () => {
    t = await TestApp.create();
    alpha = await t.createTenant({ name: 'Alpha Typing' });
    beta = await t.createTenant({ name: 'Beta Typing' });
    receptionist = await t.addStaff(alpha, 'receptionist');
    manager = await t.addStaff(alpha, 'manager');
    operator = await t.addStaff(alpha, 'operator');
    portalCustomer = await t.addCustomer(alpha, { fullName: 'Portal Person' });
  });
  afterAll(() => t.close());

  const audit = (tenantId: string, action: string, resourceId?: string) => t.sys.auditLog.findMany({ where: { tenantId, action, ...(resourceId ? { resourceId } : {}) }, orderBy: { createdAt: 'asc' } });
  const row = (id: string) => t.sys.customer.findUniqueOrThrow({ where: { id } });
  /** No response may ever carry the stored identity columns or a full identity number. */
  const expectNoSecrets = (body: unknown, ...plain: string[]) => {
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/emiratesIdEnc|emiratesIdHash|emiratesIdLast4|passportNoEnc|passportNoHash|passportNoLast4/);
    for (const value of plain) expect(text).not.toContain(value);
  };

  // ------------------------------------------------------------------ create
  describe('registering customers', () => {
    it('creates a customer with a per-centre number, masked identity numbers, consents, an audit entry and an event', async () => {
      const emiratesId = uniqueEmiratesId();
      const passportNo = uniquePassport();
      const res = await t.as(receptionist).post('/customers', customerBody({
        fullName: '  Fatima   Al Mansoori ', fullNameAr: 'فاطمة المنصوري', preferredLanguage: 'ar', nationality: 'ae', dateOfBirth: '1988-07-15',
        address: { line1: 'Villa 12', city: 'Dubai', emirate: 'Dubai', country: 'AE' },
        emiratesId: `${emiratesId.slice(0, 3)}-${emiratesId.slice(3, 7)}-${emiratesId.slice(7, 14)}-${emiratesId.slice(14)}`, emiratesIdExpiry: '2028-03-31',
        passportNo: passportNo.toLowerCase(), passportCountry: 'AE', passportExpiry: '2030-01-01', marketingOptIn: true,
      })).expect(201);
      const c = res.body;
      expect(c).toMatchObject({
        tenantId: alpha.id, type: 'INDIVIDUAL', status: 'ACTIVE', fullName: 'Fatima Al Mansoori', fullNameAr: 'فاطمة المنصوري', preferredLanguage: 'ar', nationality: 'AE',
        dateOfBirth: '1988-07-15', address: { line1: 'Villa 12', city: 'Dubai' }, emiratesIdMasked: `•••• ${emiratesId.slice(-4)}`, hasEmiratesId: true, emiratesIdExpiry: '2028-03-31',
        passportNoMasked: `•••• ${passportNo.slice(-4)}`, hasPassport: true, passportCountry: 'AE', passportExpiry: '2030-01-01',
        communicationPrefs: { email: true, sms: true, whatsapp: false, push: true }, marketingOptIn: true, version: 1, createdById: receptionist.userId,
      });
      expect(c.customerNo).toMatch(/^CUS-\d{6}$/);
      expectNoSecrets(c, emiratesId, passportNo);

      // Stored encrypted + blind index + last four; the plain number is nowhere in the row.
      const stored = await row(c.id);
      expect(JSON.stringify(stored)).not.toContain(emiratesId);
      expect(JSON.stringify(stored)).not.toContain(passportNo);
      expect(decryptText(stored.emiratesIdEnc!)).toBe(emiratesId);
      expect(decryptText(stored.passportNoEnc!)).toBe(passportNo);
      expect(stored.emiratesIdHash).toBe(blindIndex(alpha.id, 'emiratesId', emiratesId));
      expect(stored.passportNoHash).toBe(blindIndex(alpha.id, 'passport', passportNo));
      expect(stored.emiratesIdLast4).toBe(emiratesId.slice(-4));

      const logs = await audit(alpha.id, 'customer.created', c.id);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({ actorUserId: receptionist.userId, resourceType: 'Customer' });
      expect(logs[0].after).toMatchObject({ fullName: 'Fatima Al Mansoori', emiratesId: `ends in ${emiratesId.slice(-4)}`, source: 'STAFF' });
      expect(JSON.stringify(logs[0])).not.toContain(emiratesId);

      const events = await t.sys.outboxEvent.findMany({ where: { tenantId: alpha.id, type: 'customer.created' } });
      expect(events.map((e) => (e.payload as any).customerId)).toContain(c.id);
      expect((events.find((e) => (e.payload as any).customerId === c.id)!.payload as any).source).toBe('STAFF');

      const consents = await t.sys.customerConsent.findMany({ where: { customerId: c.id }, orderBy: { purpose: 'asc' } });
      expect(consents.map((x) => [x.purpose, x.status, x.lawfulBasis])).toEqual([['MARKETING', 'GRANTED', 'CONSENT'], ['SERVICE_PROCESSING', 'GRANTED', 'CONTRACT']]);
      expect(await t.sys.consentRecord.count({ where: { customerId: c.id, capturedVia: 'STAFF_RECORDED', capturedById: receptionist.userId } })).toBe(2);
    });

    it('numbers customers gap-free and independently per centre', async () => {
      const gamma = await t.createTenant();
      const delta = await t.createTenant();
      const numbers = [];
      for (const tenant of [gamma, delta, gamma, delta, gamma]) numbers.push((await createCustomer(t, tenant)).customerNo);
      expect(numbers).toEqual(['CUS-000001', 'CUS-000001', 'CUS-000002', 'CUS-000002', 'CUS-000003']);
      // A rejected registration does not burn a number.
      await t.as(gamma.owner).post('/customers', { fullName: 'X' }).expect(400);
      expect((await createCustomer(t, gamma)).customerNo).toBe('CUS-000004');
    });

    it('validates input', async () => {
      const post = (over: Record<string, unknown>) => t.as(receptionist).post('/customers', customerBody(over));
      await post({ fullName: 'A' }).expect(400);
      await post({ email: 'not-an-email' }).expect(400);
      await post({ phone: '0501234567' }).expect(400);
      await post({ emiratesId: '123-4567-8901234-5' }).expect(400);
      await post({ passportNo: 'AB 12' }).expect(400);
      await post({ dateOfBirth: '15/07/1988' }).expect(400);
      await post({ type: 'ROBOT' }).expect(400);
      await post({ preferredLanguage: 'fr' }).expect(400);
      const res = await post({ nationality: 'United Arab Emirates' }).expect(400);
      expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED', details: [{ path: 'nationality' }] });
    });

    it('needs only a name; contact and identity details are optional', async () => {
      const res = await t.as(receptionist).post('/customers', { fullName: `Walk In ${uniq()}` }).expect(201);
      expect(res.body).toMatchObject({ email: null, phone: null, emiratesIdMasked: null, hasEmiratesId: false, passportNoMasked: null, hasPassport: false, dateOfBirth: null });
      const stored = await row(res.body.id);
      expect(stored).toMatchObject({ emiratesIdEnc: null, emiratesIdHash: null, passportNoEnc: null, passportNoHash: null });
    });
  });

  // ------------------------------------------------------------------ masking + sensitive read
  describe('identity numbers', () => {
    let customer: any;
    const emiratesId = uniqueEmiratesId();
    const passportNo = uniquePassport();
    beforeAll(async () => {
      customer = await createCustomer(t, alpha, { emiratesId, passportNo, passportCountry: 'IN', emiratesIdExpiry: '2027-05-05' });
    });

    it('are masked in the list, the detail, updates and duplicate candidates', async () => {
      const list = await t.as(receptionist).get(`/customers?q=${customer.customerNo}`).expect(200);
      expect(list.body.data[0]).toMatchObject({ id: customer.id, emiratesIdMasked: `•••• ${emiratesId.slice(-4)}`, passportNoMasked: `•••• ${passportNo.slice(-4)}` });
      expectNoSecrets(list.body, emiratesId, passportNo);
      const detail = await t.as(receptionist).get(`/customers/${customer.id}`).expect(200);
      expect(detail.body).toMatchObject({ emiratesIdMasked: `•••• ${emiratesId.slice(-4)}`, hasPassport: true });
      expectNoSecrets(detail.body, emiratesId, passportNo);
      const updated = await t.as(receptionist).patch(`/customers/${customer.id}`, { nationality: 'IN' }).expect(200);
      expectNoSecrets(updated.body, emiratesId, passportNo);
      const dup = await t.as(receptionist).post('/customers/duplicates/check', { emiratesId }).expect(200);
      expect(dup.body.candidates).toHaveLength(1);
      expectNoSecrets(dup.body, emiratesId, passportNo);
      const activity = await t.as(alpha.owner).get(`/customers/${customer.id}/activity`).expect(200);
      expectNoSecrets(activity.body, emiratesId, passportNo);
    });

    it('GET /customers/:id/identity returns the full numbers to authorised staff and audits every call', async () => {
      const before = (await audit(alpha.id, 'customer.identity_revealed', customer.id)).length;
      const res = await t.as(manager).get(`/customers/${customer.id}/identity`).expect(200);
      expect(res.body).toEqual({ customerId: customer.id, customerNo: customer.customerNo, emiratesId, emiratesIdExpiry: '2027-05-05', passportNo, passportCountry: 'IN', passportExpiry: null });
      await t.as(manager).get(`/customers/${customer.id}/identity`).expect(200);
      await t.as(alpha.owner).get(`/customers/${customer.id}/identity`).expect(200);
      const logs = await audit(alpha.id, 'customer.identity_revealed', customer.id);
      expect(logs).toHaveLength(before + 3);
      expect(logs.slice(-3).map((l) => l.actorUserId)).toEqual([manager.userId, manager.userId, alpha.owner.userId]);
      expect(logs[0].after).toEqual({ fields: ['emiratesId', 'passportNo'] });
      // The audit entry says that it happened, never what the numbers are.
      expect(JSON.stringify(logs)).not.toContain(emiratesId);
      expect(JSON.stringify(logs)).not.toContain(passportNo);
    });

    it('is refused without the sensitive-read permission, and nothing is logged as revealed', async () => {
      const before = (await audit(alpha.id, 'customer.identity_revealed', customer.id)).length;
      await t.as(receptionist).get(`/customers/${customer.id}/identity`).expect(403);
      await t.as(operator).get(`/customers/${customer.id}/identity`).expect(403);
      await t.as(portalCustomer).get(`/customers/${customer.id}/identity`).expect(403);
      await t.as(null).get(`/customers/${customer.id}/identity`).expect(401);
      expect((await audit(alpha.id, 'customer.identity_revealed', customer.id)).length).toBe(before);
    });

    it('can be replaced and cleared; the blind index follows', async () => {
      const next = uniqueEmiratesId();
      const replaced = await t.as(receptionist).patch(`/customers/${customer.id}`, { emiratesId: next }).expect(200);
      expect(replaced.body.emiratesIdMasked).toBe(`•••• ${next.slice(-4)}`);
      expect((await row(customer.id)).emiratesIdHash).toBe(blindIndex(alpha.id, 'emiratesId', next));
      expect((await t.as(manager).get(`/customers/${customer.id}/identity`)).body.emiratesId).toBe(next);
      const log = (await audit(alpha.id, 'customer.updated', customer.id)).pop()!;
      expect(log.before).toEqual({ emiratesId: `ends in ${emiratesId.slice(-4)}` });
      expect(log.after).toEqual({ emiratesId: `ends in ${next.slice(-4)}` });

      const cleared = await t.as(receptionist).patch(`/customers/${customer.id}`, { passportNo: null }).expect(200);
      expect(cleared.body).toMatchObject({ passportNoMasked: null, hasPassport: false });
      expect(await row(customer.id)).toMatchObject({ passportNoEnc: null, passportNoHash: null, passportNoLast4: null });
      await t.as(receptionist).patch(`/customers/${customer.id}`, { emiratesId, passportNo }).expect(200);
    });
  });

  // ------------------------------------------------------------------ search
  describe('search and filters', () => {
    let gamma: TenantFixture;
    let aisha: any, omar: any, company: any;
    const eid = uniqueEmiratesId();
    const passport = uniquePassport();
    let tag: any, corp: any, request: any;
    const ids = (res: any) => res.body.data.map((c: any) => c.id);
    const find = async (query: string) => ids(await t.as(gamma.owner).get(`/customers?${query}`).expect(200));

    beforeAll(async () => {
      gamma = await t.createTenant({ name: 'Gamma Typing' });
      corp = await t.sys.corporateAccount.create({ data: { tenantId: gamma.id, accountNo: 'CORP-000001', companyName: 'Falcon Trading LLC', status: 'ACTIVE' } });
      tag = (await t.as(gamma.owner).post('/customer-tags', { name: 'VIP', color: '#0B7AD1' }).expect(201)).body;
      aisha = await createCustomer(t, gamma, { fullName: 'Aisha Khan', fullNameAr: 'عائشة خان', email: 'aisha.khan@example.test', phone: '+971501234567', emiratesId: eid, passportNo: passport, tagIds: [tag.id] });
      omar = await createCustomer(t, gamma, { fullName: 'Omar Haddad', email: 'omar@example.test', phone: '+971551112222', corporateAccountId: corp.id });
      company = await createCustomer(t, gamma, { fullName: 'Khan Brothers Trading', type: 'BUSINESS', email: 'info@khanbrothers.example.test', phone: '+97142223333' });
      request = await seedRequest(t, gamma, omar.id, { requestNo: 'TE-000777' });
    });

    it('by customer number (exact, or just the digits)', async () => {
      expect(await find(`q=${aisha.customerNo}`)).toEqual([aisha.id]);
      expect(await find(`q=${aisha.customerNo.toLowerCase()}`)).toEqual([aisha.id]);
      expect(await find('q=2')).toEqual([omar.id]);
      expect(await find('q=CUS-0000')).toEqual([]);
    });
    it('by name: case-insensitive, partial, English or Arabic', async () => {
      expect((await find('q=khan&sort=fullName:asc'))).toEqual([aisha.id, company.id]);
      expect(await find('q=AISHA')).toEqual([aisha.id]);
      expect(await find(`q=${encodeURIComponent('عائشة')}`)).toEqual([aisha.id]);
      expect(await find('q=nobody')).toEqual([]);
    });
    it('by phone: exact after normalisation, never partial', async () => {
      expect(await find(`phone=${encodeURIComponent('+971501234567')}`)).toEqual([aisha.id]);
      expect(await find(`phone=${encodeURIComponent('050 123 4567')}`)).toEqual([aisha.id]);
      expect(await find('phone=00971501234567')).toEqual([aisha.id]);
      expect(await find(`q=${encodeURIComponent('050 123 4567')}`)).toEqual([aisha.id]);
      expect(await find('phone=0501234')).toEqual([]);
      expect(await find('phone=1234567')).toEqual([]);
      expect(await find('q=501234567')).toEqual([]);
    });
    it('by email', async () => {
      expect(await find('email=AISHA.KHAN@example.test')).toEqual([aisha.id]);
      expect(await find('q=omar@example.test')).toEqual([omar.id]);
      expect(await find('email=aisha')).toEqual([]);
    });
    it('by Emirates ID and passport: exact match through the blind index only', async () => {
      expect(await find(`emiratesId=${eid}`)).toEqual([aisha.id]);
      expect(await find(`emiratesId=${eid.slice(0, 3)}-${eid.slice(3, 7)}-${eid.slice(7, 14)}-${eid.slice(14)}`)).toEqual([aisha.id]);
      expect(await find(`q=${eid}`)).toEqual([aisha.id]);
      expect(await find(`passportNo=${passport.toLowerCase()}`)).toEqual([aisha.id]);
      expect(await find(`q=${passport}`)).toEqual([aisha.id]);
      // No partial matching, not even on the last four digits that are stored for display.
      expect(await find(`emiratesId=${eid.slice(0, 10)}`)).toEqual([]);
      expect(await find(`emiratesId=${eid.slice(-4)}`)).toEqual([]);
      expect(await find(`q=${eid.slice(-4)}`)).toEqual([]);
      expect(await find(`passportNo=${passport.slice(0, 5)}`)).toEqual([]);
      expect(await find(`q=${passport.slice(-4)}`)).toEqual([]);
    });
    it('by request reference', async () => {
      expect(await find('requestNo=te-000777')).toEqual([omar.id]);
      expect(await find('q=TE-000777')).toEqual([omar.id]);
      expect(await find('requestNo=TE-000778')).toEqual([]);
      expect(request.customerId).toBe(omar.id);
    });
    it('filters by type, tag, corporate account, portal account and status; pages and sorts', async () => {
      expect(await find('type=BUSINESS')).toEqual([company.id]);
      expect(await find(`tagId=${tag.id}`)).toEqual([aisha.id]);
      expect(await find(`corporateAccountId=${corp.id}`)).toEqual([omar.id]);
      expect(await find('hasAccount=true')).toEqual([]);
      expect((await find('hasAccount=false')).length).toBe(3);
      expect(await find('sort=customerNo:asc')).toEqual([aisha.id, omar.id, company.id]);
      expect(await find('sort=fullName:desc')).toEqual([omar.id, company.id, aisha.id]);
      const page = await t.as(gamma.owner).get('/customers?sort=customerNo:asc&pageSize=2&page=2').expect(200);
      expect(ids(page)).toEqual([company.id]);
      expect(page.body.meta).toEqual({ page: 2, pageSize: 2, total: 3, totalPages: 2 });
      expect(page.body.data[0]).toMatchObject({ tags: [], portalAccess: 'NONE' });
      expect((await t.as(gamma.owner).get(`/customers?tagId=${tag.id}`)).body.data[0].tags).toEqual([{ id: tag.id, name: 'VIP', color: '#0B7AD1' }]);

      await t.as(gamma.owner).post(`/customers/${company.id}/archive`, {}).expect(200);
      expect(await find('sort=customerNo:asc')).toEqual([aisha.id, omar.id]);
      expect(await find('status=ARCHIVED')).toEqual([company.id]);
      expect(await find('status=ALL&sort=customerNo:asc')).toEqual([aisha.id, omar.id, company.id]);
      await t.as(gamma.owner).post(`/customers/${company.id}/restore`).expect(200);
      await t.as(gamma.owner).get('/customers?status=DELETED').expect(400);
      await t.as(gamma.owner).get('/customers?tagId=nope').expect(400);
    });
  });

  // ------------------------------------------------------------------ duplicates
  describe('duplicate detection', () => {
    let gamma: TenantFixture;
    let existing: any;
    const eid = uniqueEmiratesId();
    const passport = uniquePassport();
    const phone = uniquePhone();
    const email = `dup-${uniq()}@example.test`;

    beforeAll(async () => {
      gamma = await t.createTenant();
      existing = await createCustomer(t, gamma, { fullName: 'Mohammed Ali', emiratesId: eid, passportNo: passport, phone, email });
    });
    const check = async (body: Record<string, unknown>) => (await t.as(gamma.owner).post('/customers/duplicates/check', body).expect(200)).body;

    it('reports each signal: Emirates ID, passport, phone and email are strong, the name alone is weak', async () => {
      expect((await check({ emiratesId: eid })).candidates).toEqual([expect.objectContaining({ signals: ['EMIRATES_ID'], strength: 'STRONG', customer: expect.objectContaining({ id: existing.id, customerNo: existing.customerNo }) })]);
      expect((await check({ passportNo: passport.toLowerCase() })).candidates[0]).toMatchObject({ signals: ['PASSPORT'], strength: 'STRONG' });
      expect((await check({ phone })).candidates[0]).toMatchObject({ signals: ['PHONE'], strength: 'STRONG' });
      expect((await check({ email: email.toUpperCase() })).candidates[0]).toMatchObject({ signals: ['EMAIL'], strength: 'STRONG' });
      const byName = await check({ fullName: '  mohammed   ALI ' });
      expect(byName).toMatchObject({ strongCount: 0, weakCount: 1 });
      expect(byName.candidates[0]).toMatchObject({ signals: ['NAME'], strength: 'WEAK' });
      const all = await check({ fullName: 'Mohammed Ali', emiratesId: eid, phone, email, passportNo: passport });
      expect(all.candidates[0].signals.sort()).toEqual(['EMAIL', 'EMIRATES_ID', 'NAME', 'PASSPORT', 'PHONE']);
      expect(await check({ fullName: 'Somebody Else', phone: uniquePhone() })).toEqual({ candidates: [], strongCount: 0, weakCount: 0 });
      expect((await check({ emiratesId: eid, excludeId: existing.id })).candidates).toEqual([]);
      await t.as(gamma.owner).post('/customers/duplicates/check', {}).expect(400);
    });

    it.each([
      ['Emirates ID', { emiratesId: eid }, 'EMIRATES_ID'],
      ['passport', { passportNo: passport }, 'PASSPORT'],
      ['phone', { phone }, 'PHONE'],
      ['email', { email }, 'EMAIL'],
    ])('blocks a new record with the same %s until staff confirm it is a different person', async (_label, clash, signal) => {
      const body = { fullName: `Different Person ${uniq()}`, ...clash };
      const before = await t.sys.customer.count({ where: { tenantId: gamma.id } });
      const res = await t.as(gamma.owner).post('/customers', body).expect(409);
      expect(res.body.code).toBe('POSSIBLE_DUPLICATE');
      expect(res.body.message).toMatch(/confirm that this is a different person/);
      expect(res.body.details.candidates).toEqual([expect.objectContaining({ strength: 'STRONG', signals: [signal], customer: expect.objectContaining({ id: existing.id, emiratesIdMasked: `•••• ${eid.slice(-4)}` }) })]);
      expectNoSecrets(res.body, eid, passport);
      expect(await t.sys.customer.count({ where: { tenantId: gamma.id } })).toBe(before);
      await t.as(gamma.owner).post('/customers', { ...body, confirmNotDuplicate: false }).expect(409);
    });

    it('creates the record when staff confirm, and records what they confirmed', async () => {
      const created = (await t.as(gamma.owner).post('/customers', { fullName: 'Mohammed Ali Junior', phone, confirmNotDuplicate: true }).expect(201)).body;
      const log = (await audit(gamma.id, 'customer.created', created.id))[0];
      expect((log.after as any).confirmedNotDuplicateOf).toEqual([existing.customerNo]);
      // Nothing was merged or changed on the existing record.
      expect(await row(existing.id)).toMatchObject({ status: 'ACTIVE', mergedIntoId: null, phone });
      expect(await row(created.id)).toMatchObject({ status: 'ACTIVE', mergedIntoId: null });
    });

    it('a matching name alone never blocks and never merges', async () => {
      const twin = (await t.as(gamma.owner).post('/customers', { fullName: 'mohammed ali' }).expect(201)).body;
      expect(twin.id).not.toBe(existing.id);
      expect(twin.customerNo).not.toBe(existing.customerNo);
      expect(await t.sys.customer.count({ where: { tenantId: gamma.id, status: 'MERGED' } })).toBe(0);
      expect((await row(existing.id)).mergedIntoId).toBeNull();
      expect((await check({ fullName: 'Mohammed Ali' })).weakCount).toBeGreaterThanOrEqual(2);
    });

    it('also guards edits that would turn a record into a duplicate', async () => {
      const other = await createCustomer(t, gamma);
      const res = await t.as(gamma.owner).patch(`/customers/${other.id}`, { emiratesId: eid }).expect(409);
      expect(res.body.code).toBe('POSSIBLE_DUPLICATE');
      expect((await row(other.id)).emiratesIdHash).toBeNull();
      await t.as(gamma.owner).patch(`/customers/${other.id}`, { emiratesId: eid, confirmNotDuplicate: true }).expect(200);
      // Re-saving a record's own values is not a duplicate of itself.
      await t.as(gamma.owner).patch(`/customers/${existing.id}`, { passportNo: passport, phone, email }).expect(200);
    });

    it('two simultaneous registrations of the same person cannot both pass the check', async () => {
      const sameId = uniqueEmiratesId();
      const results = await Promise.all([1, 2, 3].map((i) => t.as(gamma.owner).post('/customers', { fullName: `Racer ${i}`, emiratesId: sameId })));
      expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
      expect(await t.sys.customer.count({ where: { tenantId: gamma.id, emiratesIdHash: blindIndex(gamma.id, 'emiratesId', sameId) } })).toBe(1);
    });

    it('is scoped to the centre: the same person at another centre is not a duplicate', async () => {
      await t.as(beta.owner).post('/customers', { fullName: 'Mohammed Ali', emiratesId: eid, phone, email, passportNo: passport }).expect(201);
      const res = await t.as(beta.owner).post('/customers/duplicates/check', { emiratesId: eid, phone }).expect(200);
      expect(res.body.candidates.every((c: any) => c.customer.id !== existing.id)).toBe(true);
    });
  });

  // ------------------------------------------------------------------ update
  describe('updating', () => {
    it('applies changes, bumps the version and audits before / after', async () => {
      const c = await createCustomer(t, alpha, { fullName: 'Layla Hassan' });
      const res = await t.as(receptionist).patch(`/customers/${c.id}`, { fullName: 'Layla Hassan Ali', nationality: 'EG', address: { city: 'Sharjah' }, dateOfBirth: '1995-01-20', version: 1 }).expect(200);
      expect(res.body).toMatchObject({ fullName: 'Layla Hassan Ali', nationality: 'EG', address: { city: 'Sharjah' }, dateOfBirth: '1995-01-20', version: 2 });
      const log = (await audit(alpha.id, 'customer.updated', c.id))[0];
      expect(log.before).toMatchObject({ fullName: 'Layla Hassan', nationality: null, dateOfBirth: null });
      expect(log.after).toMatchObject({ fullName: 'Layla Hassan Ali', nationality: 'EG', dateOfBirth: '1995-01-20' });
      expect((await t.as(receptionist).patch(`/customers/${c.id}`, { address: null, dateOfBirth: null }).expect(200)).body).toMatchObject({ address: null, dateOfBirth: null, version: 3 });
    });

    it('rejects a stale version', async () => {
      const c = await createCustomer(t, alpha);
      await t.as(receptionist).patch(`/customers/${c.id}`, { nationality: 'AE', version: 1 }).expect(200);
      const stale = await t.as(manager).patch(`/customers/${c.id}`, { nationality: 'SA', version: 1 }).expect(409);
      expect(stale.body.code).toBe('VERSION_CONFLICT');
      expect((await row(c.id)).nationality).toBe('AE');
    });

    it('status, customer number and merge links cannot be set through an update', async () => {
      const c = await createCustomer(t, alpha);
      const other = await createCustomer(t, alpha);
      await t.as(alpha.owner).patch(`/customers/${c.id}`, { status: 'MERGED', mergedIntoId: other.id, customerNo: 'CUS-999999', tenantId: beta.id, createdById: null } as any).expect(200);
      expect(await row(c.id)).toMatchObject({ status: 'ACTIVE', mergedIntoId: null, customerNo: c.customerNo, tenantId: alpha.id });
    });

    it('marketing and WhatsApp opt-ins changed on the profile are recorded as consent decisions', async () => {
      const c = await createCustomer(t, alpha);
      await t.as(receptionist).patch(`/customers/${c.id}`, { marketingOptIn: true, communicationPrefs: { whatsapp: true, sms: false } }).expect(200);
      const state = (await t.as(receptionist).get(`/customers/${c.id}/consents`).expect(200)).body;
      const byPurpose = Object.fromEntries(state.consents.map((x: any) => [x.purpose, x.status]));
      expect(byPurpose).toMatchObject({ MARKETING: 'GRANTED', WHATSAPP: 'GRANTED', SERVICE_PROCESSING: 'GRANTED', REMINDERS: 'NOT_SET' });
      expect((await row(c.id)).communicationPrefs).toEqual({ email: true, sms: false, whatsapp: true, push: true });
      await t.as(receptionist).patch(`/customers/${c.id}`, { marketingOptIn: false }).expect(200);
      expect((await t.sys.consentRecord.findMany({ where: { customerId: c.id, purpose: 'MARKETING' }, orderBy: { createdAt: 'asc' } })).map((r) => r.status)).toEqual(['GRANTED', 'WITHDRAWN']);
    });
  });

  // ------------------------------------------------------------------ archive / restore
  describe('archive and restore', () => {
    it('archives a customer without open requests, hides them from the default list and blocks edits', async () => {
      const c = await createCustomer(t, alpha);
      const request = await seedRequest(t, alpha, c.id);
      const blocked = await t.as(manager).post(`/customers/${c.id}/archive`, { reason: 'Left the country' }).expect(409);
      expect(blocked.body).toMatchObject({ code: 'CUSTOMER_HAS_OPEN_REQUESTS' });
      expect(blocked.body.message).toMatch(/1 open request/);
      await t.sys.serviceRequest.update({ where: { id: request.id }, data: { status: 'COMPLETED' } });

      const archived = (await t.as(manager).post(`/customers/${c.id}/archive`, { reason: 'Left the country' }).expect(200)).body;
      expect(archived).toMatchObject({ status: 'ARCHIVED', version: 2 });
      expect((await t.as(manager).get(`/customers?q=${c.customerNo}`)).body.data).toEqual([]);
      expect((await t.as(manager).get(`/customers?q=${c.customerNo}&status=ARCHIVED`)).body.data).toHaveLength(1);
      expect((await t.as(manager).get(`/customers/${c.id}`).expect(200)).body.status).toBe('ARCHIVED');
      expect((await t.as(manager).patch(`/customers/${c.id}`, { nationality: 'AE' }).expect(409)).body.code).toBe('CUSTOMER_ARCHIVED');
      expect((await t.as(manager).post(`/customers/${c.id}/notes`, { body: 'Late note' }).expect(409)).body.code).toBe('CUSTOMER_ARCHIVED');
      expect((await t.as(manager).post(`/customers/${c.id}/archive`, {}).expect(409)).body.code).toBe('ALREADY_ARCHIVED');
      expect((await audit(alpha.id, 'customer.archived', c.id))[0].after).toEqual({ status: 'ARCHIVED', reason: 'Left the country' });

      const restored = (await t.as(manager).post(`/customers/${c.id}/restore`).expect(200)).body;
      expect(restored).toMatchObject({ status: 'ACTIVE', version: 3 });
      expect((await t.as(manager).post(`/customers/${c.id}/restore`).expect(409)).body.code).toBe('NOT_ARCHIVED');
      await t.as(manager).patch(`/customers/${c.id}`, { nationality: 'AE' }).expect(200);
      expect((await audit(alpha.id, 'customer.restored', c.id)).length).toBe(1);
    });

    it('needs the archive permission', async () => {
      const c = await createCustomer(t, alpha);
      await t.as(receptionist).post(`/customers/${c.id}/archive`, {}).expect(403);
      await t.as(receptionist).post(`/customers/${c.id}/restore`).expect(403);
      expect((await row(c.id)).status).toBe('ACTIVE');
    });
  });

  // ------------------------------------------------------------------ merge
  describe('merging', () => {
    const mergeBody = (source: any, target: any, over: Record<string, unknown> = {}) => ({ sourceId: source.id, targetId: target.id, confirmSourceCustomerNo: source.customerNo, reason: 'Same person registered twice', ...over });

    it('moves everything to the kept record in one transaction, fills empty fields, retires the source and audits the merge', async () => {
      const gamma = await t.createTenant();
      const eid = uniqueEmiratesId();
      const corp = await t.sys.corporateAccount.create({ data: { tenantId: gamma.id, accountNo: `CORP-${uniq()}`, companyName: 'Falcon Trading LLC', status: 'ACTIVE' } });
      const tagA = (await t.as(gamma.owner).post('/customer-tags', { name: 'Shared' }).expect(201)).body;
      const tagB = (await t.as(gamma.owner).post('/customer-tags', { name: 'Only source' }).expect(201)).body;
      const target = await createCustomer(t, gamma, { fullName: 'Sara Ahmed', email: 'sara@example.test', phone: '+971500000001', tagIds: [tagA.id] });
      const source = await createCustomer(t, gamma, {
        fullName: 'Sara Ahmad', fullNameAr: 'سارة أحمد', email: 'sara.old@example.test', phone: '+971500000002', nationality: 'JO', dateOfBirth: '1991-04-04',
        address: { city: 'Ajman' }, emiratesId: eid, emiratesIdExpiry: '2029-09-09', corporateAccountId: corp.id, tagIds: [tagA.id, tagB.id], marketingOptIn: true,
      });
      const seeded = await seedEverything(t, gamma, source.id);
      const targetRequest = await seedRequest(t, gamma, target.id);
      const employee = await t.sys.corporateEmployee.create({ data: { tenantId: gamma.id, corporateAccountId: corp.id, customerId: source.id, employeeNo: 'E-1' } });
      await t.as(gamma.owner).post(`/customers/${source.id}/notes`, { body: 'Prefers morning calls', isPinned: true }).expect(201);
      await t.as(gamma.owner).post(`/customers/${source.id}/contacts`, { type: 'WHATSAPP', value: '+971500000003' }).expect(201);
      await t.as(gamma.owner).post(`/customers/${target.id}/contacts`, { type: 'EMAIL', value: 'sara.work@example.test' }).expect(201);
      await t.as(gamma.owner).post(`/customers/${source.id}/contacts`, { type: 'EMAIL', value: 'sara.work@example.test' }).expect(201);
      await t.as(gamma.owner).put(`/customers/${source.id}/consents`, { purpose: 'REMINDERS', granted: true }).expect(200);

      const res = await t.as(gamma.owner).post('/customers/merge', mergeBody(source, target)).expect(200);
      expect(res.body.source).toEqual({ id: source.id, customerNo: source.customerNo, status: 'MERGED', mergedIntoId: target.id });
      expect(res.body.moved).toMatchObject({
        serviceRequests: 1, documents: 1, quotations: 1, invoices: 1, payments: 1, appointments: 1, queueTokens: 1, reminderSchedules: 1, supportTickets: 1,
        customerFeedback: 1, dataSubjectRequests: 1, tasks: 1, notifications: 1, notes: 1, tagAssignments: 1, corporateEmployees: 1, memberships: 0,
      });
      // Issued invoices and completed payments are immutable and stay on the retired record.
      expect(res.body.retainedOnSource).toEqual({ invoices: 1, payments: 1 });
      expect(res.body.filledFields.sort()).toEqual(['address', 'corporateAccountId', 'dateOfBirth', 'emiratesId', 'fullNameAr', 'nationality']);
      expect(res.body.target).toMatchObject({
        id: target.id, status: 'ACTIVE', fullName: 'Sara Ahmed', email: 'sara@example.test', phone: '+971500000001', fullNameAr: 'سارة أحمد', nationality: 'JO',
        dateOfBirth: '1991-04-04', address: { city: 'Ajman' }, emiratesIdMasked: `•••• ${eid.slice(-4)}`, emiratesIdExpiry: '2029-09-09', corporateAccountId: corp.id, marketingOptIn: true,
      });
      expectNoSecrets(res.body, eid);

      // Every table now points at the kept record.
      const at = async (model: string, id: string) => ((await (t.sys as any)[model].findUniqueOrThrow({ where: { id } })) as any).customerId;
      for (const [model, rowId] of [
        ['serviceRequest', seeded.request.id], ['document', seeded.document.id], ['quotation', seeded.quotation.id], ['invoice', seeded.draftInvoice.id], ['payment', seeded.pendingPayment.id],
        ['appointment', seeded.appointment.id], ['queueToken', seeded.queueToken.id], ['reminderSchedule', seeded.reminder.id], ['supportTicket', seeded.ticket.id],
        ['customerFeedback', seeded.feedback.id], ['dataSubjectRequest', seeded.dataRequest.id], ['task', seeded.task.id], ['corporateEmployee', employee.id],
      ] as const) {
        expect([model, await at(model, rowId)]).toEqual([model, target.id]);
      }
      expect((await t.sys.notification.findUniqueOrThrow({ where: { id: seeded.notification.id } })).recipientCustomerId).toBe(target.id);
      expect(await at('invoice', seeded.issuedInvoice.id)).toBe(source.id);
      expect(await at('payment', seeded.completedPayment.id)).toBe(source.id);
      expect(await at('serviceRequest', targetRequest.id)).toBe(target.id);

      // Notes, tags, contacts and consents followed; duplicates were not doubled.
      expect((await t.sys.customerNote.findMany({ where: { customerId: target.id } })).map((n) => n.body)).toEqual(['Prefers morning calls']);
      expect((await t.sys.customerTagAssignment.findMany({ where: { customerId: target.id } })).map((a) => a.tagId).sort()).toEqual([tagA.id, tagB.id].sort());
      const contacts = await t.sys.customerContact.findMany({ where: { customerId: target.id }, orderBy: { value: 'asc' } });
      expect(contacts.map((c) => [c.type, c.value, c.isPrimary])).toEqual([
        ['PHONE', '+971500000002', false],
        ['WHATSAPP', '+971500000003', true],
        ['EMAIL', 'sara.old@example.test', false],
        ['EMAIL', 'sara.work@example.test', true],
      ]);
      expect(contacts.find((c) => c.value === 'sara.old@example.test')!.label).toBe(`From ${source.customerNo}`);
      const consents = Object.fromEntries((await t.sys.customerConsent.findMany({ where: { customerId: target.id } })).map((c) => [c.purpose, c.status]));
      expect(consents).toMatchObject({ SERVICE_PROCESSING: 'GRANTED', REMINDERS: 'GRANTED', MARKETING: 'GRANTED' });
      for (const model of ['customerNote', 'customerContact', 'customerTagAssignment', 'customerConsent', 'corporateEmployee'] as const) {
        expect([model, await (t.sys as any)[model].count({ where: { customerId: source.id } })]).toEqual([model, 0]);
      }

      // The source is retired, not deleted, and points at the kept record.
      expect(await row(source.id)).toMatchObject({ status: 'MERGED', mergedIntoId: target.id, customerNo: source.customerNo });
      const overview = (await t.as(gamma.owner).get(`/customers/${target.id}`).expect(200)).body;
      expect(overview.mergedFrom).toEqual([{ id: source.id, customerNo: source.customerNo, fullName: 'Sara Ahmad', erased: false }]);
      // The unpaid balance still counts the invoice that had to stay on the retired record.
      expect(overview.counters).toMatchObject({ openRequests: 2, totalRequests: 2, documents: 1, unpaidInvoices: 1, unpaidInvoicesBalance: '300.00', upcomingAppointments: 1, openTickets: 1 });
      expect((await t.as(gamma.owner).get(`/customers/${source.id}`).expect(200)).body).toMatchObject({ status: 'MERGED', mergedInto: { id: target.id, customerNo: target.customerNo } });

      // Audit: a detailed entry on the kept record, a pointer on the retired one, and the domain event.
      const log = (await audit(gamma.id, 'customer.merged', target.id))[0];
      expect(log).toMatchObject({ actorUserId: gamma.owner.userId, summary: `${source.customerNo} merged into ${target.customerNo}: Same person registered twice` });
      expect(log.after).toMatchObject({ sourceId: source.id, sourceCustomerNo: source.customerNo, targetCustomerNo: target.customerNo, reason: 'Same person registered twice', moved: { serviceRequests: 1 }, retainedOnSource: { invoices: 1, payments: 1 } });
      expect((await audit(gamma.id, 'customer.merged_into', source.id))[0].after).toMatchObject({ status: 'MERGED', mergedIntoId: target.id });
      const event = await t.sys.outboxEvent.findFirstOrThrow({ where: { tenantId: gamma.id, type: 'customer.merged' } });
      expect(event.payload).toMatchObject({ sourceId: source.id, targetId: target.id, sourceCustomerNo: source.customerNo, targetCustomerNo: target.customerNo });
      // The activity of the kept record includes what happened to the retired one.
      const activity = (await t.as(gamma.owner).get(`/customers/${target.id}/activity?pageSize=100`).expect(200)).body;
      expect(activity.data.map((a: any) => a.action)).toEqual(expect.arrayContaining(['customer.merged', 'customer.merged_into', 'customer.created']));

      // The retired record is read-only and can never take part in a merge again.
      expect((await t.as(gamma.owner).patch(`/customers/${source.id}`, { nationality: 'AE' }).expect(409)).body.code).toBe('CUSTOMER_MERGED');
      expect((await t.as(gamma.owner).post(`/customers/${source.id}/restore`).expect(409)).body.code).toBe('NOT_ARCHIVED');
      const third = await createCustomer(t, gamma);
      expect((await t.as(gamma.owner).post('/customers/merge', mergeBody(source, third)).expect(409)).body.code).toBe('ALREADY_MERGED');
      expect((await t.as(gamma.owner).post('/customers/merge', mergeBody(third, source)).expect(409)).body.code).toBe('ALREADY_MERGED');
      // A merged record no longer counts as a duplicate candidate, and is not in the default list.
      expect((await t.as(gamma.owner).post('/customers/duplicates/check', { emiratesId: eid })).body.candidates.map((c: any) => c.customer.id)).toEqual([target.id]);
      expect((await t.as(gamma.owner).get('/customers?q=Sara')).body.data.map((c: any) => c.id)).toEqual([target.id]);
      expect((await t.as(gamma.owner).get('/customers?q=Sara&status=MERGED')).body.data.map((c: any) => c.id)).toEqual([source.id]);
    });

    it('never overwrites details of the kept record', async () => {
      const a = await createCustomer(t, alpha, { fullName: 'Keep Me', nationality: 'AE', emiratesId: uniqueEmiratesId(), dateOfBirth: '1980-01-01' });
      const b = await createCustomer(t, alpha, { fullName: 'Retire Me', nationality: 'IN', emiratesId: uniqueEmiratesId(), dateOfBirth: '1999-09-09', passportNo: uniquePassport(), passportCountry: 'IN' });
      const keptHash = (await row(a.id)).emiratesIdHash;
      const res = await t.as(manager).post('/customers/merge', mergeBody(b, a)).expect(200);
      expect(res.body.filledFields).toEqual(['passportNo']);
      expect(res.body.target).toMatchObject({ fullName: 'Keep Me', nationality: 'AE', dateOfBirth: '1980-01-01', email: a.email, phone: a.phone, hasPassport: true, passportCountry: 'IN' });
      expect((await row(a.id)).emiratesIdHash).toBe(keptHash);
    });

    it('requires the typed customer number of the source and a reason', async () => {
      const a = await createCustomer(t, alpha);
      const b = await createCustomer(t, alpha);
      const wrong = await t.as(manager).post('/customers/merge', mergeBody(b, a, { confirmSourceCustomerNo: a.customerNo })).expect(422);
      expect(wrong.body.code).toBe('MERGE_CONFIRMATION_MISMATCH');
      await t.as(manager).post('/customers/merge', mergeBody(b, a, { confirmSourceCustomerNo: 'CUS-000000' })).expect(422);
      await t.as(manager).post('/customers/merge', mergeBody(b, a, { confirmSourceCustomerNo: undefined })).expect(400);
      await t.as(manager).post('/customers/merge', mergeBody(b, a, { reason: 'dup' })).expect(400);
      await t.as(manager).post('/customers/merge', mergeBody(b, a, { reason: undefined })).expect(400);
      expect(await row(b.id)).toMatchObject({ status: 'ACTIVE', mergedIntoId: null });
      expect((await audit(alpha.id, 'customer.merged', a.id)).length).toBe(0);
      // Case and surrounding spaces in the typed number do not matter.
      await t.as(manager).post('/customers/merge', mergeBody(b, a, { confirmSourceCustomerNo: ` ${b.customerNo.toLowerCase()} ` })).expect(200);
    });

    it('refuses to merge a record into itself', async () => {
      const a = await createCustomer(t, alpha);
      const res = await t.as(manager).post('/customers/merge', mergeBody(a, a)).expect(422);
      expect(res.body.code).toBe('MERGE_SAME_RECORD');
      expect((await row(a.id)).status).toBe('ACTIVE');
    });

    it('refuses when both records are linked to different portal logins', async () => {
      const one = await t.addCustomer(alpha, { fullName: 'Login One' });
      const two = await t.addCustomer(alpha, { fullName: 'Login Two' });
      const a = await row(one.customerId!);
      const b = await row(two.customerId!);
      const res = await t.as(manager).post('/customers/merge', mergeBody(b, a)).expect(409);
      expect(res.body.code).toBe('MERGE_BOTH_HAVE_LOGINS');
      expect((await row(b.id)).status).toBe('ACTIVE');
      // Both people still reach their own record.
      expect((await t.as(one).get('/me/customer').expect(200)).body.id).toBe(a.id);
      expect((await t.as(two).get('/me/customer').expect(200)).body.id).toBe(b.id);
    });

    it('moves the portal login when only the retired record had one', async () => {
      const login = await t.addCustomer(alpha, { fullName: 'Online Self' });
      const online = await row(login.customerId!);
      const walkIn = await createCustomer(t, alpha, { fullName: 'Online Self', email: null, phone: uniquePhone() });
      await seedRequest(t, alpha, walkIn.id);
      const res = await t.as(manager).post('/customers/merge', mergeBody(online, walkIn)).expect(200);
      expect(res.body.moved.memberships).toBe(1);
      expect(res.body.filledFields).toContain('email');
      // The same session now resolves to the kept record, with the walk-in history.
      const me = (await t.as(login).get('/me/customer').expect(200)).body;
      expect(me).toMatchObject({ id: walkIn.id, customerNo: walkIn.customerNo });
      expect((await t.as(manager).get(`/customers/${walkIn.id}`)).body.portalAccess).toMatchObject({ status: 'ACTIVE', email: login.email });
    });

    it('is all-or-nothing: a failure in the middle leaves both records untouched', async () => {
      const a = await createCustomer(t, alpha);
      const b = await createCustomer(t, alpha);
      const request = await seedRequest(t, alpha, b.id);
      const note = (await t.as(manager).post(`/customers/${b.id}/notes`, { body: 'Stays here' }).expect(201)).body;
      const events = t.get(DomainEvents);
      const boom = jest.spyOn(events, 'emit').mockRejectedValueOnce(new Error('outbox unavailable'));
      await t.as(manager).post('/customers/merge', mergeBody(b, a)).expect(500);
      boom.mockRestore();
      expect(await row(b.id)).toMatchObject({ status: 'ACTIVE', mergedIntoId: null, version: 1 });
      expect((await t.sys.serviceRequest.findUniqueOrThrow({ where: { id: request.id } })).customerId).toBe(b.id);
      expect((await t.sys.customerNote.findUniqueOrThrow({ where: { id: note.id } })).customerId).toBe(b.id);
      expect((await audit(alpha.id, 'customer.merged', a.id)).length).toBe(0);
    });

    it('chains: records merged into the source earlier follow it to the new kept record', async () => {
      const a = await createCustomer(t, alpha);
      const b = await createCustomer(t, alpha);
      const c = await createCustomer(t, alpha);
      await seedInvoice(t, alpha, a.id, 'ISSUED', '40.00');
      await t.as(manager).post('/customers/merge', mergeBody(a, b)).expect(200);
      await t.as(manager).post('/customers/merge', mergeBody(b, c)).expect(200);
      expect((await row(a.id)).mergedIntoId).toBe(c.id);
      expect((await row(b.id)).mergedIntoId).toBe(c.id);
      const overview = (await t.as(manager).get(`/customers/${c.id}`).expect(200)).body;
      expect(overview.mergedFrom.map((m: any) => m.id).sort()).toEqual([a.id, b.id].sort());
      expect(overview.counters).toMatchObject({ unpaidInvoices: 1, unpaidInvoicesBalance: '40.00' });
    });

    it('an archived source can be merged; an archived target must be restored first', async () => {
      const a = await createCustomer(t, alpha);
      const b = await createCustomer(t, alpha);
      await t.as(manager).post(`/customers/${a.id}/archive`, {}).expect(200);
      expect((await t.as(manager).post('/customers/merge', mergeBody(b, a)).expect(409)).body.code).toBe('CUSTOMER_ARCHIVED');
      await t.as(manager).post('/customers/merge', mergeBody(a, b)).expect(200);
      expect((await row(a.id)).status).toBe('MERGED');
    });

    it('needs the merge permission and never crosses centres', async () => {
      const a = await createCustomer(t, alpha);
      const b = await createCustomer(t, alpha);
      const foreign = await createCustomer(t, beta);
      await t.as(receptionist).post('/customers/merge', mergeBody(b, a)).expect(403);
      await t.as(operator).post('/customers/merge', mergeBody(b, a)).expect(403);
      await t.as(portalCustomer).post('/customers/merge', mergeBody(b, a)).expect(403);
      await t.as(manager).post('/customers/merge', mergeBody(foreign, a)).expect(404);
      await t.as(manager).post('/customers/merge', mergeBody(a, foreign)).expect(404);
      await t.as(beta.owner).post('/customers/merge', mergeBody(b, a)).expect(404);
      expect(await row(foreign.id)).toMatchObject({ status: 'ACTIVE', mergedIntoId: null, tenantId: beta.id });
      expect(await row(a.id)).toMatchObject({ status: 'ACTIVE', mergedIntoId: null });
      expect(await row(b.id)).toMatchObject({ status: 'ACTIVE', mergedIntoId: null });
    });
  });

  // ------------------------------------------------------------------ notes
  describe('notes (internal)', () => {
    it('adds, lists pinned first, edits and deletes with authorship rules', async () => {
      const c = await createCustomer(t, alpha);
      const first = (await t.as(receptionist).post(`/customers/${c.id}/notes`, { body: 'Called twice, no answer' }).expect(201)).body;
      const pinned = (await t.as(manager).post(`/customers/${c.id}/notes`, { body: 'Always ask for the sponsor letter', isPinned: true }).expect(201)).body;
      const third = (await t.as(receptionist).post(`/customers/${c.id}/notes`, { body: 'Paid deposit in cash' }).expect(201)).body;
      expect(first).toMatchObject({ customerId: c.id, authorId: receptionist.userId, isPinned: false });

      const list = (await t.as(operator).get(`/customers/${c.id}/notes`).expect(200)).body;
      expect(list.data.map((n: any) => n.id)).toEqual([pinned.id, third.id, first.id]);
      expect(list.data[0]).toMatchObject({ authorName: expect.stringContaining('manager'), isPinned: true });
      expect(list.meta.total).toBe(3);
      expect((await t.as(operator).get(`/customers/${c.id}/notes?q=deposit`)).body.data.map((n: any) => n.id)).toEqual([third.id]);
      expect((await t.as(receptionist).get(`/customers/${c.id}`)).body.pinnedNotes.map((n: any) => n.id)).toEqual([pinned.id]);

      // Anyone who may edit customers can pin; only the author changes the text.
      expect((await t.as(manager).patch(`/customers/${c.id}/notes/${first.id}`, { isPinned: true }).expect(200)).body.isPinned).toBe(true);
      expect((await t.as(manager).patch(`/customers/${c.id}/notes/${first.id}`, { body: 'Rewritten by someone else' }).expect(403)).body.code).toBe('NOTE_NOT_YOURS');
      expect((await t.as(receptionist).patch(`/customers/${c.id}/notes/${first.id}`, { body: 'Called three times' }).expect(200)).body.body).toBe('Called three times');
      // A receptionist deletes own notes only; a manager (archive permission) may remove any.
      expect((await t.as(receptionist).delete(`/customers/${c.id}/notes/${pinned.id}`).expect(403)).body.code).toBe('NOTE_NOT_YOURS');
      await t.as(receptionist).delete(`/customers/${c.id}/notes/${third.id}`).expect(200);
      await t.as(manager).delete(`/customers/${c.id}/notes/${first.id}`).expect(200);
      expect(await t.sys.customerNote.count({ where: { customerId: c.id } })).toBe(1);

      // The audit trail records that notes changed, not what they say.
      const logs = await t.sys.auditLog.findMany({ where: { tenantId: alpha.id, resourceId: c.id, action: { startsWith: 'customer.note_' } } });
      expect(logs.map((l) => l.action).sort()).toEqual(['customer.note_added', 'customer.note_added', 'customer.note_added', 'customer.note_deleted', 'customer.note_deleted', 'customer.note_updated', 'customer.note_updated']);
      expect(JSON.stringify(logs)).not.toContain('sponsor letter');
    });

    it('validates and enforces permissions; a note is reachable only through its own customer', async () => {
      const c = await createCustomer(t, alpha);
      const other = await createCustomer(t, alpha);
      await t.as(receptionist).post(`/customers/${c.id}/notes`, { body: '' }).expect(400);
      await t.as(receptionist).post(`/customers/${c.id}/notes`, { body: 'x'.repeat(4001) }).expect(400);
      await t.as(operator).post(`/customers/${c.id}/notes`, { body: 'Operators only read customers' }).expect(403);
      const note = (await t.as(receptionist).post(`/customers/${c.id}/notes`, { body: 'Mine' }).expect(201)).body;
      await t.as(receptionist).patch(`/customers/${other.id}/notes/${note.id}`, { isPinned: true }).expect(404);
      await t.as(receptionist).delete(`/customers/${other.id}/notes/${note.id}`).expect(404);
    });
  });

  // ------------------------------------------------------------------ tags
  describe('tags', () => {
    it('creates, renames, assigns, replaces and deletes tags', async () => {
      const name = `Priority ${uniq()}`;
      const tag = (await t.as(receptionist).post('/customer-tags', { name, color: '#00A166' }).expect(201)).body;
      expect(tag).toMatchObject({ name, color: '#00A166', tenantId: alpha.id, customerCount: 0 });
      expect((await t.as(receptionist).post('/customer-tags', { name: name.toUpperCase() }).expect(409)).body.code).toBe('DUPLICATE_TAG');
      await t.as(receptionist).post('/customer-tags', { name: 'x', color: 'green' }).expect(400);
      const second = (await t.as(receptionist).post('/customer-tags', { name: `Late payer ${uniq()}` }).expect(201)).body;
      expect((await t.as(receptionist).patch(`/customer-tags/${second.id}`, { name }).expect(409)).body.code).toBe('DUPLICATE_TAG');
      const renamed = (await t.as(receptionist).patch(`/customer-tags/${second.id}`, { name: `${second.name} (review)`, color: '#0B2240' }).expect(200)).body;
      expect(renamed).toMatchObject({ color: '#0B2240' });

      const c = await createCustomer(t, alpha);
      expect((await t.as(receptionist).post(`/customers/${c.id}/tags/${tag.id}`).expect(200)).body).toEqual([{ id: tag.id, name, color: '#00A166' }]);
      // Assigning twice is harmless.
      expect((await t.as(receptionist).post(`/customers/${c.id}/tags/${tag.id}`).expect(200)).body).toHaveLength(1);
      expect((await t.as(receptionist).put(`/customers/${c.id}/tags`, { tagIds: [second.id] }).expect(200)).body.map((x: any) => x.id)).toEqual([second.id]);
      expect((await t.as(receptionist).put(`/customers/${c.id}/tags`, { tagIds: [tag.id, second.id] }).expect(200)).body).toHaveLength(2);
      expect((await t.as(receptionist).delete(`/customers/${c.id}/tags/${second.id}`).expect(200)).body.map((x: any) => x.id)).toEqual([tag.id]);
      await t.as(receptionist).delete(`/customers/${c.id}/tags/${second.id}`).expect(404);
      expect((await t.as(receptionist).get('/customer-tags').expect(200)).body.find((x: any) => x.id === tag.id).customerCount).toBe(1);
      expect((await t.as(receptionist).get(`/customers/${c.id}`)).body.tags).toEqual([{ id: tag.id, name, color: '#00A166' }]);

      expect((await t.as(receptionist).delete(`/customer-tags/${tag.id}`).expect(200)).body).toEqual({ status: 'DELETED', removedFromCustomers: 1 });
      expect((await t.as(receptionist).get(`/customers/${c.id}`)).body.tags).toEqual([]);
      expect((await audit(alpha.id, 'customer.tags_changed', c.id)).length).toBe(2);
      expect((await audit(alpha.id, 'customer_tag.deleted', tag.id)).length).toBe(1);
    });

    it('enforces permissions', async () => {
      const c = await createCustomer(t, alpha);
      const tag = (await t.as(receptionist).post('/customer-tags', { name: `Perm ${uniq()}` }).expect(201)).body;
      await t.as(operator).get('/customer-tags').expect(200);
      await t.as(operator).post('/customer-tags', { name: 'Nope' }).expect(403);
      await t.as(operator).patch(`/customer-tags/${tag.id}`, { name: 'Nope' }).expect(403);
      await t.as(operator).delete(`/customer-tags/${tag.id}`).expect(403);
      await t.as(operator).post(`/customers/${c.id}/tags/${tag.id}`).expect(403);
      await t.as(operator).put(`/customers/${c.id}/tags`, { tagIds: [tag.id] }).expect(403);
      await t.as(portalCustomer).get('/customer-tags').expect(403);
    });
  });

  // ------------------------------------------------------------------ contacts
  describe('contacts', () => {
    it('keeps exactly one primary contact per type', async () => {
      const c = await createCustomer(t, alpha);
      const base = `/customers/${c.id}/contacts`;
      const e1 = (await t.as(receptionist).post(base, { type: 'EMAIL', value: ' Work@Example.TEST ', label: 'Work' }).expect(201)).body;
      expect(e1).toMatchObject({ type: 'EMAIL', value: 'work@example.test', label: 'Work', isPrimary: true });
      const e2 = (await t.as(receptionist).post(base, { type: 'EMAIL', value: 'home@example.test' }).expect(201)).body;
      expect(e2.isPrimary).toBe(false);
      const p1 = (await t.as(receptionist).post(base, { type: 'PHONE', value: '+971 4 222 3333' }).expect(201)).body;
      expect(p1).toMatchObject({ value: '+97142223333', isPrimary: true });
      const e3 = (await t.as(receptionist).post(base, { type: 'EMAIL', value: 'new@example.test', isPrimary: true }).expect(201)).body;
      const primaries = async () => (await t.sys.customerContact.findMany({ where: { customerId: c.id, isPrimary: true }, orderBy: { type: 'asc' } })).map((x) => [x.type, x.value]);
      expect(await primaries()).toEqual([['EMAIL', 'new@example.test'], ['PHONE', '+97142223333']]);

      await t.as(receptionist).patch(`${base}/${e2.id}`, { isPrimary: true }).expect(200);
      expect(await primaries()).toEqual([['EMAIL', 'home@example.test'], ['PHONE', '+97142223333']]);
      expect((await t.as(receptionist).patch(`${base}/${e2.id}`, { isPrimary: false }).expect(422)).body.code).toBe('PRIMARY_CONTACT_REQUIRED');
      // Removing the primary promotes the oldest remaining contact of that type.
      await t.as(receptionist).delete(`${base}/${e2.id}`).expect(200);
      expect(await primaries()).toEqual([['EMAIL', 'work@example.test'], ['PHONE', '+97142223333']]);
      expect((await t.as(receptionist).get(base).expect(200)).body.map((x: any) => x.id).sort()).toEqual([e1.id, p1.id, e3.id].sort());
    });

    it('validates values against the contact type and refuses duplicates', async () => {
      const c = await createCustomer(t, alpha);
      const base = `/customers/${c.id}/contacts`;
      await t.as(receptionist).post(base, { type: 'EMAIL', value: '+971501234567' }).expect(400);
      await t.as(receptionist).post(base, { type: 'PHONE', value: 'someone@example.test' }).expect(400);
      await t.as(receptionist).post(base, { type: 'FAX', value: '+97142223333' }).expect(400);
      const w = (await t.as(receptionist).post(base, { type: 'WHATSAPP', value: '+971501112233' }).expect(201)).body;
      expect((await t.as(receptionist).post(base, { type: 'WHATSAPP', value: '+971 50 111 2233' }).expect(409)).body.code).toBe('DUPLICATE_CONTACT');
      await t.as(receptionist).patch(`${base}/${w.id}`, { value: 'not a phone' }).expect(400);
      expect((await t.as(receptionist).patch(`${base}/${w.id}`, { value: '+971 50 999 8877', label: 'New SIM' }).expect(200)).body).toMatchObject({ value: '+971509998877', label: 'New SIM', type: 'WHATSAPP' });
      await t.as(operator).post(base, { type: 'EMAIL', value: 'x@example.test' }).expect(403);
      await t.as(operator).get(base).expect(200);
    });
  });

  // ------------------------------------------------------------------ consents
  describe('consents', () => {
    it('staff record decisions: current state plus an append-only history', async () => {
      const c = await createCustomer(t, alpha);
      const base = `/customers/${c.id}/consents`;
      const initial = (await t.as(receptionist).get(base).expect(200)).body;
      expect(initial.consents.map((x: any) => x.purpose)).toEqual(['SERVICE_PROCESSING', 'REMINDERS', 'MARKETING', 'AI_PROCESSING', 'DOCUMENT_REUSE', 'WHATSAPP']);
      expect(initial.consents.find((x: any) => x.purpose === 'SERVICE_PROCESSING')).toMatchObject({ status: 'GRANTED', granted: true, lawfulBasis: 'CONTRACT' });
      expect(initial.consents.find((x: any) => x.purpose === 'AI_PROCESSING')).toMatchObject({ status: 'NOT_SET', granted: false, lawfulBasis: 'CONSENT', grantedAt: null });
      expect(initial.history).toHaveLength(1);

      const granted = (await t.as(receptionist).put(base, { purpose: 'AI_PROCESSING', granted: true, noticeVersion: 'v2' }).expect(200)).body;
      expect(granted.changed).toBe(true);
      expect(granted.consents.find((x: any) => x.purpose === 'AI_PROCESSING')).toMatchObject({ status: 'GRANTED', noticeVersion: 'v2', withdrawnAt: null });
      // Saving the same decision again writes nothing.
      expect((await t.as(receptionist).put(base, { purpose: 'AI_PROCESSING', granted: true, noticeVersion: 'v2' }).expect(200)).body.changed).toBe(false);
      const withdrawn = (await t.as(manager).put(base, { purpose: 'AI_PROCESSING', granted: false }).expect(200)).body;
      const ai = withdrawn.consents.find((x: any) => x.purpose === 'AI_PROCESSING');
      expect(ai).toMatchObject({ status: 'WITHDRAWN', granted: false });
      expect(ai.grantedAt).not.toBeNull();
      expect(ai.withdrawnAt).not.toBeNull();
      await t.as(receptionist).put(base, { purpose: 'REMINDERS', granted: true, lawfulBasis: 'LEGITIMATE_INTEREST' }).expect(200);

      const history = (await t.as(receptionist).get(base).expect(200)).body.history;
      expect(history.map((h: any) => [h.purpose, h.status, h.capturedVia])).toEqual([
        ['REMINDERS', 'GRANTED', 'STAFF_RECORDED'], ['AI_PROCESSING', 'WITHDRAWN', 'STAFF_RECORDED'], ['AI_PROCESSING', 'GRANTED', 'STAFF_RECORDED'], ['SERVICE_PROCESSING', 'GRANTED', 'STAFF_RECORDED'],
      ]);
      expect(history[0].lawfulBasis).toBe('LEGITIMATE_INTEREST');
      expect(history[1].capturedById).toBe(manager.userId);
      expect((await audit(alpha.id, 'customer.consent_granted', c.id)).length).toBe(2);
      expect((await audit(alpha.id, 'customer.consent_withdrawn', c.id)).length).toBe(1);

      // The history cannot be rewritten, not even with a direct database statement through the tenant connection.
      await expect(t.inTenant(alpha.id, () => t.db.tx((tx) => tx.consentRecord.updateMany({ where: { customerId: c.id }, data: { status: 'GRANTED' } })))).rejects.toThrow();
      await expect(t.inTenant(alpha.id, () => t.db.tx((tx) => tx.consentRecord.deleteMany({ where: { customerId: c.id } })))).rejects.toThrow();
      expect(await t.sys.consentRecord.count({ where: { customerId: c.id } })).toBe(4);
    });

    it('validates purposes and permissions', async () => {
      const c = await createCustomer(t, alpha);
      await t.as(receptionist).put(`/customers/${c.id}/consents`, { purpose: 'SELL_DATA', granted: true }).expect(400);
      await t.as(receptionist).put(`/customers/${c.id}/consents`, { purpose: 'MARKETING' }).expect(400);
      await t.as(receptionist).put(`/customers/${c.id}/consents`, { purpose: 'MARKETING', granted: true, lawfulBasis: 'BECAUSE' }).expect(400);
      await t.as(operator).put(`/customers/${c.id}/consents`, { purpose: 'MARKETING', granted: true }).expect(403);
      await t.as(operator).get(`/customers/${c.id}/consents`).expect(200);
    });

    it('customers manage their own consents; marketing and WhatsApp stay in step with the profile', async () => {
      const login = await t.addCustomer(alpha, { fullName: 'Consent Owner' });
      const mine = (await t.as(login).get('/me/consents').expect(200)).body;
      expect(Object.fromEntries(mine.consents.map((x: any) => [x.purpose, x.status]))).toMatchObject({ SERVICE_PROCESSING: 'GRANTED', MARKETING: 'WITHDRAWN', REMINDERS: 'NOT_SET' });
      expect(mine.consents[0].description).toEqual(expect.any(String));
      expect(mine).not.toHaveProperty('history');

      const res = (await t.as(login).put('/me/consents', { consents: [{ purpose: 'MARKETING', granted: true }, { purpose: 'WHATSAPP', granted: true }, { purpose: 'REMINDERS', granted: true, noticeVersion: '2026-01' }] }).expect(200)).body;
      expect(res.changed).toEqual(['MARKETING', 'WHATSAPP', 'REMINDERS']);
      expect(await row(login.customerId!)).toMatchObject({ marketingOptIn: true, communicationPrefs: { email: true, sms: true, whatsapp: true, push: true } });
      expect((await t.as(login).get('/me/customer')).body).toMatchObject({ marketingOptIn: true, communicationPrefs: { whatsapp: true } });
      const records = await t.sys.consentRecord.findMany({ where: { customerId: login.customerId!, purpose: { in: ['WHATSAPP', 'REMINDERS'] } } });
      expect(records.every((r) => r.capturedVia === 'PORTAL' && r.userId === login.userId && r.capturedById === login.userId)).toBe(true);

      // Unticking WhatsApp on the profile withdraws the consent.
      await t.as(login).patch('/me/customer', { communicationPrefs: { whatsapp: false } }).expect(200);
      expect((await t.as(login).get('/me/consents')).body.consents.find((x: any) => x.purpose === 'WHATSAPP').status).toBe('WITHDRAWN');
      expect((await t.as(login).put('/me/consents', { consents: [{ purpose: 'MARKETING', granted: true }] }).expect(200)).body.changed).toEqual([]);

      // Processing that the service itself depends on is not a toggle.
      const refused = await t.as(login).put('/me/consents', { consents: [{ purpose: 'REMINDERS', granted: false }, { purpose: 'SERVICE_PROCESSING', granted: false }] }).expect(422);
      expect(refused.body.code).toBe('CONSENT_REQUIRED_FOR_SERVICE');
      // ...and the whole request was rolled back, including the valid part.
      expect((await t.as(login).get('/me/consents')).body.consents.find((x: any) => x.purpose === 'REMINDERS').status).toBe('GRANTED');
      await t.as(login).put('/me/consents', { consents: [] }).expect(400);
      await t.as(login).put('/me/consents', { consents: [{ purpose: 'MARKETING', granted: true }, { purpose: 'MARKETING', granted: false }] }).expect(400);
      // Staff see the customer's own decisions in the history.
      const staffView = (await t.as(receptionist).get(`/customers/${login.customerId}/consents`).expect(200)).body;
      expect(staffView.history.filter((h: any) => h.capturedVia === 'PORTAL').length).toBeGreaterThanOrEqual(4);
    });
  });

  // ------------------------------------------------------------------ overview + activity
  describe('overview and activity', () => {
    it('shows the masked profile, tags, pinned notes, counters and last activity', async () => {
      const gamma = await t.createTenant();
      const corp = await t.sys.corporateAccount.create({ data: { tenantId: gamma.id, accountNo: 'CORP-000009', companyName: 'Oryx Logistics LLC', status: 'ACTIVE' } });
      const tag = (await t.as(gamma.owner).post('/customer-tags', { name: 'Corporate' }).expect(201)).body;
      const eid = uniqueEmiratesId();
      const c = await createCustomer(t, gamma, { emiratesId: eid, corporateAccountId: corp.id, tagIds: [tag.id] });
      const empty = (await t.as(gamma.owner).get(`/customers/${c.id}`).expect(200)).body;
      expect(empty.counters).toEqual({ openRequests: 0, totalRequests: 0, documents: 0, unpaidInvoices: 0, unpaidInvoicesBalance: '0.00', currency: null, upcomingAppointments: 0, openTickets: 0 });
      expect(empty).toMatchObject({ portalAccess: { status: 'NONE' }, mergedInto: null, mergedFrom: [], pinnedNotes: [], contacts: [] });

      await seedEverything(t, gamma, c.id);
      await seedRequest(t, gamma, c.id, { status: 'COMPLETED' });
      await seedRequest(t, gamma, c.id, { status: 'CANCELLED' });
      await seedInvoice(t, gamma, c.id, 'PARTIALLY_PAID', '200.00', '50.50');
      await seedInvoice(t, gamma, c.id, 'PAID', '80.00', '80.00');
      await t.sys.document.create({ data: { tenantId: gamma.id, customerId: c.id, documentTypeKey: 'photo', title: 'Old photo', status: 'DELETED', deletedAt: new Date() } });
      const yesterday = new Date(Date.now() - 86400_000);
      await t.sys.appointment.create({ data: { tenantId: gamma.id, customerId: c.id, branchId: gamma.headOfficeId, startsAt: yesterday, endsAt: new Date(yesterday.getTime() + 1800_000), status: 'COMPLETED' } });
      await t.sys.supportTicket.create({ data: { tenantId: gamma.id, customerId: c.id, ticketNo: `TKT-${uniq()}`, subject: 'Closed one', status: 'CLOSED' } });
      await t.as(gamma.owner).post(`/customers/${c.id}/notes`, { body: 'Pinned note', isPinned: true }).expect(201);
      await t.as(gamma.owner).post(`/customers/${c.id}/notes`, { body: 'Ordinary note' }).expect(201);
      // Rows of another customer never leak into the counters.
      const other = await createCustomer(t, gamma);
      await seedEverything(t, gamma, other.id);

      const overview = (await t.as(gamma.owner).get(`/customers/${c.id}`).expect(200)).body;
      expect(overview).toMatchObject({
        id: c.id, customerNo: c.customerNo, emiratesIdMasked: `•••• ${eid.slice(-4)}`,
        corporateAccount: { id: corp.id, accountNo: 'CORP-000009', companyName: 'Oryx Logistics LLC' },
        tags: [{ id: tag.id, name: 'Corporate' }],
        counters: { openRequests: 1, totalRequests: 3, documents: 1, unpaidInvoices: 2, unpaidInvoicesBalance: '449.50', currency: 'AED', upcomingAppointments: 1, openTickets: 1 },
      });
      expect(overview.pinnedNotes.map((n: any) => n.body)).toEqual(['Pinned note']);
      expect(overview.lastActivityAt).not.toBeNull();
      expectNoSecrets(overview, eid);
    });

    it('last activity moves forward when other modules report something about the customer', async () => {
      const c = await createCustomer(t, alpha);
      const past = new Date('2020-01-01T00:00:00Z');
      await t.sys.customer.update({ where: { id: c.id }, data: { lastActivityAt: past } });
      const versionBefore = (await row(c.id)).version;
      await t.inTenant(alpha.id, () => t.db.tx((tx) => t.get(DomainEvents).emit(tx, 'request.created', { requestId: uniq(), customerId: c.id, serviceId: uniq(), branchId: alpha.headOfficeId, source: 'WALK_IN' })));
      await t.settle();
      const after = await row(c.id);
      expect(after.lastActivityAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
      expect(after.version).toBe(versionBefore);
      // Events about other things, or without a customer, change nothing.
      const stamp = after.lastActivityAt!.getTime();
      await t.inTenant(alpha.id, () => t.db.tx((tx) => t.get(DomainEvents).emit(tx, 'payment.completed', { paymentId: uniq(), customerId: null, amount: '1.00', currency: 'AED', method: 'CASH', invoiceIds: [], requestIds: [] })));
      await t.settle();
      expect((await row(c.id)).lastActivityAt!.getTime()).toBe(stamp);
    });

    it('activity history lists the audit trail of the customer; field values need the audit permission', async () => {
      const c = await createCustomer(t, alpha, { fullName: 'Activity Person' });
      await t.as(receptionist).patch(`/customers/${c.id}`, { nationality: 'AE' }).expect(200);
      await t.as(receptionist).post(`/customers/${c.id}/notes`, { body: 'A note' }).expect(201);
      await t.as(manager).get(`/customers/${c.id}/identity`).expect(200);
      await createCustomer(t, alpha, { fullName: 'Unrelated Person' });

      const asOwner = (await t.as(alpha.owner).get(`/customers/${c.id}/activity`).expect(200)).body;
      expect(asOwner.data.map((a: any) => a.action)).toEqual(['customer.identity_revealed', 'customer.note_added', 'customer.updated', 'customer.created']);
      expect(asOwner.meta.total).toBe(4);
      expect(asOwner.data.every((a: any) => a.resourceId === c.id)).toBe(true);
      expect(asOwner.data[2]).toMatchObject({ actorType: 'STAFF', actorUserId: receptionist.userId, before: { nationality: null }, after: { nationality: 'AE' } });
      // The receptionist sees what happened and who did it, but not the field values.
      const asReceptionist = (await t.as(receptionist).get(`/customers/${c.id}/activity?pageSize=2`).expect(200)).body;
      expect(asReceptionist.data).toHaveLength(2);
      expect(asReceptionist.meta).toMatchObject({ total: 4, totalPages: 2 });
      expect(asReceptionist.data[0]).toMatchObject({ action: 'customer.identity_revealed', actorLabel: expect.any(String) });
      expect(asReceptionist.data[0]).not.toHaveProperty('after');
      expect(asReceptionist.data[0]).not.toHaveProperty('before');
    });
  });

  // ------------------------------------------------------------------ portal invitation
  describe('portal invitation', () => {
    it('invites a walk-in customer; accepting links the login to exactly that record', async () => {
      const email = `walkin-${uniq()}@example.test`;
      const c = await createCustomer(t, alpha, { fullName: 'Walk In Guest', email });
      await seedRequest(t, alpha, c.id);
      const invite = (await t.as(receptionist).post(`/customers/${c.id}/portal-invitation`, {}).expect(201)).body;
      expect(invite).toMatchObject({ status: 'INVITED', email, membershipId: expect.any(String), dev: { invitationToken: expect.any(String) } });
      const membership = await t.sys.tenantMembership.findUniqueOrThrow({ where: { id: invite.membershipId }, include: { role: true, user: true } });
      expect(membership).toMatchObject({ tenantId: alpha.id, kind: 'CUSTOMER', status: 'INVITED', customerId: c.id, invitedById: receptionist.userId, role: { key: 'customer' }, user: { email, passwordHash: null } });
      expect(t.messenger.lastFor(email, 'staff.invitation')!.data.link).toContain('accept-invitation?token=');
      expect((await t.as(receptionist).get(`/customers/${c.id}`)).body.portalAccess).toMatchObject({ status: 'INVITED', email });
      expect((await t.as(receptionist).get(`/customers?q=${c.customerNo}`)).body.data[0].portalAccess).toBe('INVITED');
      expect((await audit(alpha.id, 'customer.portal_invited', c.id))[0].after).toMatchObject({ membershipId: invite.membershipId, email });

      // Sending again re-uses the membership and replaces the earlier link.
      const again = (await t.as(receptionist).post(`/customers/${c.id}/portal-invitation`, {}).expect(201)).body;
      expect(again.membershipId).toBe(invite.membershipId);
      await t.http.post('/api/v1/auth/invitations/accept').send({ token: invite.dev.invitationToken, password: PASSWORD, app: 'customer' }).expect(400);
      const accepted = await t.http.post('/api/v1/auth/invitations/accept').send({ token: again.dev.invitationToken, password: PASSWORD, app: 'customer' }).expect(200);
      expect(accepted.body.session.membership).toMatchObject({ kind: 'CUSTOMER', customerId: c.id });

      const login = await t.login(email, PASSWORD, 'customer', alpha.slug);
      expect(login.customerId).toBe(c.id);
      expect((await t.as(login).get('/me/customer').expect(200)).body).toMatchObject({ id: c.id, customerNo: c.customerNo, fullName: 'Walk In Guest' });
      expect((await t.as(receptionist).get(`/customers/${c.id}`)).body.portalAccess.status).toBe('ACTIVE');
      expect((await t.as(receptionist).get('/customers?hasAccount=true&pageSize=100')).body.data.map((x: any) => x.id)).toContain(c.id);
      expect((await t.as(receptionist).post(`/customers/${c.id}/portal-invitation`, {}).expect(409)).body.code).toBe('ALREADY_HAS_ACCESS');
    });

    it('can go to a different address, which also fills an empty email on the record', async () => {
      const c = await createCustomer(t, alpha, { email: null });
      expect((await t.as(receptionist).post(`/customers/${c.id}/portal-invitation`, {}).expect(422)).body.code).toBe('EMAIL_REQUIRED');
      const first = `first-${uniq()}@example.test`;
      const second = `second-${uniq()}@example.test`;
      const one = (await t.as(receptionist).post(`/customers/${c.id}/portal-invitation`, { email: first }).expect(201)).body;
      expect((await row(c.id)).email).toBe(first);
      // A corrected address withdraws the earlier, unanswered invitation.
      const two = (await t.as(receptionist).post(`/customers/${c.id}/portal-invitation`, { email: second }).expect(201)).body;
      expect(two.membershipId).not.toBe(one.membershipId);
      expect(await t.sys.tenantMembership.findUniqueOrThrow({ where: { id: one.membershipId } })).toMatchObject({ status: 'REMOVED', customerId: null });
      await t.http.post('/api/v1/auth/invitations/accept').send({ token: one.dev.invitationToken, password: PASSWORD, app: 'customer' }).expect(400);
      await t.http.post('/api/v1/auth/invitations/accept').send({ token: two.dev.invitationToken, password: PASSWORD, app: 'customer' }).expect(200);
      expect((await t.login(second, PASSWORD, 'customer', alpha.slug)).customerId).toBe(c.id);
    });

    it('refuses an address that already signs in to another customer profile, and needs customer.update', async () => {
      const taken = await t.addCustomer(alpha);
      const c = await createCustomer(t, alpha);
      const res = await t.as(receptionist).post(`/customers/${c.id}/portal-invitation`, { email: taken.email }).expect(409);
      expect(res.body.code).toBe('EMAIL_IN_USE');
      expect(await t.sys.tenantMembership.count({ where: { customerId: c.id } })).toBe(0);
      expect((await t.sys.tenantMembership.findFirstOrThrow({ where: { userId: taken.userId, tenantId: alpha.id } })).customerId).toBe(taken.customerId);
      await t.as(operator).post(`/customers/${c.id}/portal-invitation`, {}).expect(403);
      await t.as(portalCustomer).post(`/customers/${c.id}/portal-invitation`, {}).expect(403);
      await t.as(receptionist).post(`/customers/${c.id}/portal-invitation`, { email: 'nope' }).expect(400);
    });

    it('the same person can be a customer of two centres with one login', async () => {
      const email = `both-${uniq()}@example.test`;
      const a = await createCustomer(t, alpha, { email });
      const b = await createCustomer(t, beta, { email });
      const ia = (await t.as(alpha.owner).post(`/customers/${a.id}/portal-invitation`, {}).expect(201)).body;
      await t.http.post('/api/v1/auth/invitations/accept').send({ token: ia.dev.invitationToken, password: PASSWORD, app: 'customer' }).expect(200);
      const ib = (await t.as(beta.owner).post(`/customers/${b.id}/portal-invitation`, {}).expect(201)).body;
      await t.http.post('/api/v1/auth/invitations/accept').send({ token: ib.dev.invitationToken, app: 'customer' }).expect(200);
      const atAlpha = await t.login(email, PASSWORD, 'customer', alpha.slug);
      const atBeta = await t.login(email, PASSWORD, 'customer', beta.slug);
      expect((await t.as(atAlpha).get('/me/customer')).body.id).toBe(a.id);
      expect((await t.as(atBeta).get('/me/customer')).body.id).toBe(b.id);
    });
  });

  // ------------------------------------------------------------------ self-service
  describe('customer self-service', () => {
    it('customers read their own profile: masked, without internal fields', async () => {
      const eid = uniqueEmiratesId();
      await t.as(receptionist).patch(`/customers/${portalCustomer.customerId}`, { emiratesId: eid, nationality: 'AE' }).expect(200);
      const tag = (await t.as(receptionist).post('/customer-tags', { name: `Internal label ${uniq()}` }).expect(201)).body;
      await t.as(receptionist).post(`/customers/${portalCustomer.customerId}/tags/${tag.id}`).expect(200);
      await t.as(receptionist).post(`/customers/${portalCustomer.customerId}/notes`, { body: 'Internal: difficult customer', isPinned: true }).expect(201);

      const me = (await t.as(portalCustomer).get('/me/customer').expect(200)).body;
      expect(me).toMatchObject({ id: portalCustomer.customerId, fullName: 'Portal Person', email: portalCustomer.email, nationality: 'AE', emiratesIdMasked: `•••• ${eid.slice(-4)}`, hasEmiratesId: true });
      expectNoSecrets(me, eid);
      const text = JSON.stringify(me);
      for (const internal of ['difficult customer', 'Internal label', 'pinnedNotes', 'tags', 'createdById', 'mergedIntoId', 'counters', 'tenantId', 'version']) expect(text).not.toContain(internal);
    });

    it('customers change their own details; the login address, identity numbers and internal fields never get through', async () => {
      const login = await t.addCustomer(alpha, { fullName: 'Self Editor' });
      const before = await row(login.customerId!);
      const res = await t.as(login).patch('/me/customer', {
        fullName: 'Self  Editor   Renamed', fullNameAr: 'محرر', preferredLanguage: 'ar', address: { line1: 'Flat 4', city: 'Abu Dhabi' }, communicationPrefs: { sms: false },
        // None of these may get through:
        email: 'hijack@example.test', emiratesId: uniqueEmiratesId(), passportNo: 'ZZ999999', passportCountry: 'US', emiratesIdExpiry: '2031-01-01', status: 'ARCHIVED', customerNo: 'CUS-000001',
        corporateAccountId: '00000000-0000-4000-8000-000000000000', marketingOptIn: true, type: 'BUSINESS',
      }).expect(200);
      expect(res.body).toMatchObject({ fullName: 'Self Editor Renamed', fullNameAr: 'محرر', preferredLanguage: 'ar', address: { line1: 'Flat 4', city: 'Abu Dhabi' }, communicationPrefs: { email: true, sms: false, whatsapp: false, push: true } });
      const after = await row(login.customerId!);
      expect(after).toMatchObject({
        email: before.email, phone: before.phone, emiratesIdHash: null, passportNoHash: null, status: 'ACTIVE', customerNo: before.customerNo, corporateAccountId: null,
        marketingOptIn: false, type: 'INDIVIDUAL', nationality: null, dateOfBirth: null, passportCountry: null, emiratesIdExpiry: null, version: before.version + 1,
      });
      const log = (await audit(alpha.id, 'customer.self_updated', login.customerId!))[0];
      expect(log).toMatchObject({ actorType: 'CUSTOMER', actorUserId: login.userId });
      expect(log.before).toMatchObject({ fullName: 'Self Editor', preferredLanguage: 'en' });
      await t.as(login).patch('/me/customer', { fullName: 'X' }).expect(400);
      await t.as(login).patch('/me/customer', { preferredLanguage: 'fr' }).expect(400);
      // An empty change is not an error and writes nothing.
      await t.as(login).patch('/me/customer', {}).expect(200);
      expect((await row(login.customerId!)).version).toBe(before.version + 1);
    });

    it('customers fill in and correct their phone, nationality and date of birth - until the centre has confirmed the value', async () => {
      // ---- registered online: the record is the customer's own entry from the start
      const login = await t.addCustomer(alpha, { fullName: 'Fills In Later' });
      const id = login.customerId!;
      expect((await t.as(login).get('/me/customer').expect(200)).body).toMatchObject({ phone: null, nationality: null, dateOfBirth: null, editable: { phone: true, nationality: true, dateOfBirth: true } });
      const phone = uniquePhone();
      const filled = (await t.as(login).patch('/me/customer', { phone, nationality: 'IN', dateOfBirth: '1991-07-23' }).expect(200)).body;
      expect(filled).toMatchObject({ phone, nationality: 'IN', dateOfBirth: '1991-07-23', editable: { phone: true, nationality: true, dateOfBirth: true } });
      expect(await row(id)).toMatchObject({ phone, nationality: 'IN', dateOfBirth: new Date('1991-07-23T00:00:00.000Z') });
      const first = (await audit(alpha.id, 'customer.self_updated', id)).pop()!;
      expect(first).toMatchObject({ actorType: 'CUSTOMER', actorUserId: login.userId, before: { phone: null, nationality: null, dateOfBirth: null }, after: { phone, nationality: 'IN', dateOfBirth: '1991-07-23' } });
      // Their own entry is theirs to correct - a typo, a new number.
      const corrected = uniquePhone();
      expect((await t.as(login).patch('/me/customer', { phone: corrected, dateOfBirth: '1991-07-24' }).expect(200)).body).toMatchObject({ phone: corrected, dateOfBirth: '1991-07-24', nationality: 'IN' });
      // Validation is the same as at the counter.
      await t.as(login).patch('/me/customer', { phone: '12345' }).expect(400);
      await t.as(login).patch('/me/customer', { nationality: 'Indian' }).expect(400);
      await t.as(login).patch('/me/customer', { dateOfBirth: '23/07/1991' }).expect(400);
      await t.as(login).patch('/me/customer', { dateOfBirth: new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10) }).expect(400);

      // ---- the centre confirms the nationality (staff edit): from now on it is a correction request for the customer
      await t.as(receptionist).patch(`/customers/${id}`, { nationality: 'PK' }).expect(200);
      expect((await t.as(login).get('/me/customer').expect(200)).body).toMatchObject({ nationality: 'PK', editable: { phone: true, nationality: false, dateOfBirth: true } });
      const versionBefore = (await row(id)).version;
      const refused = await t.as(login).patch('/me/customer', { nationality: 'IN', phone: uniquePhone() }).expect(409);
      expect(refused.body).toMatchObject({ code: 'CORRECTION_REQUIRED', details: { fields: ['nationality'] } });
      expect(refused.body.message).toMatch(/nationality was confirmed by the centre/);
      // Nothing of a refused change is applied - not the part that would have been allowed either.
      expect(await row(id)).toMatchObject({ nationality: 'PK', phone: corrected, version: versionBefore });
      // Sending the value that is already there is not a change.
      await t.as(login).patch('/me/customer', { nationality: 'PK', fullName: 'Fills In Later' }).expect(200);
      // Clearing a confirmed value is a change too.
      expect((await t.as(login).patch('/me/customer', { nationality: null }).expect(409)).body.code).toBe('CORRECTION_REQUIRED');
      // The rest stays theirs: the phone they entered, the date they entered.
      const newer = uniquePhone();
      expect((await t.as(login).patch('/me/customer', { phone: newer }).expect(200)).body).toMatchObject({ phone: newer, editable: { phone: true, nationality: false, dateOfBirth: true } });
      // The way to change a confirmed value exists and is open to them.
      const correction = await t.as(login).post('/privacy/my/requests', { type: 'CORRECTION', details: 'My nationality is Indian, not Pakistani.' }).expect(201);
      expect(correction.body).toMatchObject({ type: 'CORRECTION', status: 'RECEIVED' });

      // The centre removes a value: the field is empty, so the customer may fill it in again.
      await t.as(receptionist).patch(`/customers/${id}`, { nationality: null, dateOfBirth: '1990-01-01' }).expect(200);
      expect((await t.as(login).get('/me/customer').expect(200)).body.editable).toEqual({ phone: true, nationality: true, dateOfBirth: false });
      expect((await t.as(login).patch('/me/customer', { nationality: 'IN' }).expect(200)).body).toMatchObject({ nationality: 'IN', editable: { nationality: true, dateOfBirth: false } });
      expect((await t.as(login).patch('/me/customer', { dateOfBirth: '1991-07-23' }).expect(409)).body.details.fields).toEqual(['dateOfBirth']);
      expect((await t.as(login).patch('/me/customer', { dateOfBirth: '1991-07-23', nationality: 'PK' }).expect(409)).body.details.fields).toEqual(['dateOfBirth']);

      // ---- registered at the counter: what staff typed in is confirmed from the start; what is empty is open
      const counterPhone = uniquePhone();
      const email = `counter-${uniq()}@example.test`;
      const walkIn = await createCustomer(t, alpha, { fullName: 'Counter Customer', email, phone: counterPhone, dateOfBirth: '1985-03-02' });
      const invite = (await t.as(receptionist).post(`/customers/${walkIn.id}/portal-invitation`, {}).expect(201)).body;
      await t.http.post('/api/v1/auth/invitations/accept').send({ token: invite.dev.invitationToken, password: PASSWORD, app: 'customer' }).expect(200);
      const invited = await t.login(email, PASSWORD, 'customer', alpha.slug);
      expect((await t.as(invited).get('/me/customer').expect(200)).body).toMatchObject({ phone: counterPhone, dateOfBirth: '1985-03-02', nationality: null, editable: { phone: false, nationality: true, dateOfBirth: false } });
      const both = await t.as(invited).patch('/me/customer', { phone: uniquePhone(), dateOfBirth: '1985-03-03' }).expect(409);
      expect(both.body.details.fields).toEqual(['phone', 'dateOfBirth']);
      expect(both.body.message).toMatch(/phone number and date of birth were confirmed by the centre/);
      expect((await t.as(invited).patch('/me/customer', { nationality: 'EG', address: { city: 'Sharjah' } }).expect(200)).body).toMatchObject({ nationality: 'EG', address: { city: 'Sharjah' }, phone: counterPhone });
      // Another customer's record is never reached by any of this, and an archived record is locked altogether.
      expect(await row(id)).toMatchObject({ nationality: 'IN' });
      await t.as(alpha.owner).post(`/customers/${walkIn.id}/archive`, {}).expect(200);
      expect((await t.as(invited).patch('/me/customer', { nationality: 'JO' }).expect(409)).body.code).toBe('PROFILE_LOCKED');
    });

    it('customers reach only their own record and none of the staff endpoints', async () => {
      const mine = portalCustomer.customerId!;
      const someoneElse = await createCustomer(t, alpha, { fullName: 'Somebody Else' });
      const other = await t.addCustomer(alpha, { fullName: 'Another Login' });
      expect((await t.as(other).get('/me/customer')).body.id).toBe(other.customerId);
      expect((await t.as(other).get('/me/customer')).body.id).not.toBe(mine);

      for (const path of ['/customers', `/customers/${mine}`, `/customers/${someoneElse.id}`, `/customers/${mine}/notes`, `/customers/${mine}/activity`, `/customers/${mine}/consents`, `/customers/${mine}/contacts`, `/customers/${someoneElse.id}/identity`, '/customer-tags']) {
        await t.as(portalCustomer).get(path).expect(403);
      }
      await t.as(portalCustomer).post('/customers', customerBody()).expect(403);
      await t.as(portalCustomer).patch(`/customers/${mine}`, { fullName: 'Self Service Bypass' }).expect(403);
      await t.as(portalCustomer).post('/customers/duplicates/check', { fullName: 'Somebody Else' }).expect(403);
      await t.as(portalCustomer).post(`/customers/${mine}/archive`, {}).expect(403);
      await t.as(portalCustomer).put(`/customers/${someoneElse.id}/consents`, { purpose: 'MARKETING', granted: true }).expect(403);
      expect((await row(someoneElse.id)).fullName).toBe('Somebody Else');

      // Staff have no "own customer" and cannot use the self-service endpoints.
      await t.as(receptionist).get('/me/customer').expect(403);
      await t.as(alpha.owner).patch('/me/customer', { fullName: 'Owner As Customer' }).expect(403);
      await t.as(receptionist).get('/me/consents').expect(403);
      await t.as(null).get('/me/customer').expect(401);
    });

    it('a customer whose record was archived cannot edit it', async () => {
      const login = await t.addCustomer(alpha);
      await t.as(manager).post(`/customers/${login.customerId}/archive`, {}).expect(200);
      expect((await t.as(login).patch('/me/customer', { fullName: 'Still Here' }).expect(409)).body.code).toBe('PROFILE_LOCKED');
      await t.as(login).get('/me/customer').expect(200);
    });
  });

  // ------------------------------------------------------------------ permissions
  describe('staff permissions', () => {
    it('an operator reads customers but cannot register, edit, archive, merge or reveal', async () => {
      const c = await createCustomer(t, alpha);
      await t.as(operator).get('/customers').expect(200);
      await t.as(operator).get(`/customers/${c.id}`).expect(200);
      await t.as(operator).get(`/customers/${c.id}/activity`).expect(200);
      await t.as(operator).post('/customers', customerBody()).expect(403);
      await t.as(operator).patch(`/customers/${c.id}`, { fullName: 'Nope Nope' }).expect(403);
      await t.as(operator).post('/customers/duplicates/check', { fullName: 'Any Name' }).expect(403);
      await t.as(operator).post(`/customers/${c.id}/archive`, {}).expect(403);
      await t.as(operator).get(`/customers/${c.id}/identity`).expect(403);
      await t.as(null).get('/customers').expect(401);
      await t.as(null).post('/customers', customerBody()).expect(401);
    });

    it('an accountant reads customers only', async () => {
      const accountant = await t.addStaff(alpha, 'accountant');
      const c = await createCustomer(t, alpha);
      await t.as(accountant).get(`/customers/${c.id}`).expect(200);
      await t.as(accountant).post('/customers', customerBody()).expect(403);
      await t.as(accountant).post(`/customers/${c.id}/notes`, { body: 'Nope' }).expect(403);
      await t.as(accountant).get(`/customers/${c.id}/identity`).expect(403);
    });

    it('customers are not tied to a branch: staff limited to one branch see all customers of the centre', async () => {
      const second = (await t.as(alpha.owner).post('/branches', { code: `C${uniq().slice(-5).toUpperCase()}`, name: 'Second branch' }).expect(201)).body;
      const limited = await t.addStaff(alpha, 'receptionist', { branchIds: [second.id] });
      const c = await createCustomer(t, alpha);
      expect((await t.as(limited).get(`/customers?q=${c.customerNo}`).expect(200)).body.data.map((x: any) => x.id)).toEqual([c.id]);
      await t.as(limited).get(`/customers/${c.id}`).expect(200);
      await t.as(limited).post('/customers', customerBody()).expect(201);
    });
  });

  // ------------------------------------------------------------------ tenant isolation
  describe('tenant isolation', () => {
    it('centre A cannot read, change or reference customers, notes, tags, contacts or consents of centre B', async () => {
      const eid = uniqueEmiratesId();
      const marker = `Betaonly${uniq()}`;
      const b = await createCustomer(t, beta, { fullName: `${marker} Person`, emiratesId: eid });
      const bNote = (await t.as(beta.owner).post(`/customers/${b.id}/notes`, { body: 'Beta internal note' }).expect(201)).body;
      const bTag = (await t.as(beta.owner).post('/customer-tags', { name: `Beta tag ${uniq()}` }).expect(201)).body;
      const bContact = (await t.as(beta.owner).post(`/customers/${b.id}/contacts`, { type: 'EMAIL', value: 'beta.contact@example.test' }).expect(201)).body;
      const bCorp = await t.sys.corporateAccount.create({ data: { tenantId: beta.id, accountNo: `CORP-${uniq()}`, companyName: 'Beta Corp', status: 'ACTIVE' } });
      const bRequest = await seedRequest(t, beta, b.id, { requestNo: 'TE-424242' });
      const own = await createCustomer(t, alpha);
      const a = t.as(alpha.owner);

      // Reads: nothing of B is visible, by id or by search.
      expect((await a.get('/customers?pageSize=100&status=ALL')).body.data.every((c: any) => c.id !== b.id)).toBe(true);
      expect((await a.get(`/customers?q=${marker}`)).body.data).toEqual([]);
      expect((await a.get(`/customers?q=${b.customerNo}`)).body.data.every((c: any) => c.id !== b.id)).toBe(true);
      expect((await a.get(`/customers?emiratesId=${eid}`)).body.data).toEqual([]);
      expect((await a.get('/customers?requestNo=TE-424242')).body.data).toEqual([]);
      expect((await a.get(`/customers?tagId=${bTag.id}`)).body.data).toEqual([]);
      expect((await a.get(`/customers?corporateAccountId=${bCorp.id}`)).body.data).toEqual([]);
      expect((await a.post('/customers/duplicates/check', { emiratesId: eid, fullName: `${marker} Person` })).body.candidates).toEqual([]);
      expect((await a.get('/customer-tags')).body.every((x: any) => x.id !== bTag.id)).toBe(true);
      for (const path of ['', '/identity', '/activity', '/notes', '/contacts', '/consents']) await a.get(`/customers/${b.id}${path}`).expect(404);
      expect(bRequest.customerId).toBe(b.id);

      // Writes on B's rows.
      await a.patch(`/customers/${b.id}`, { fullName: 'Hijacked Name' }).expect(404);
      await a.post(`/customers/${b.id}/archive`, {}).expect(404);
      await a.post(`/customers/${b.id}/restore`).expect(404);
      await a.post(`/customers/${b.id}/notes`, { body: 'Injected' }).expect(404);
      await a.patch(`/customers/${own.id}/notes/${bNote.id}`, { isPinned: true }).expect(404);
      await a.delete(`/customers/${own.id}/notes/${bNote.id}`).expect(404);
      await a.post(`/customers/${b.id}/contacts`, { type: 'EMAIL', value: 'x@example.test' }).expect(404);
      await a.patch(`/customers/${own.id}/contacts/${bContact.id}`, { label: 'Hijacked' }).expect(404);
      await a.delete(`/customers/${own.id}/contacts/${bContact.id}`).expect(404);
      await a.put(`/customers/${b.id}/consents`, { purpose: 'MARKETING', granted: true }).expect(404);
      await a.put(`/customers/${b.id}/tags`, { tagIds: [] }).expect(404);
      await a.post(`/customers/${b.id}/portal-invitation`, { email: 'x@example.test' }).expect(404);
      await a.patch(`/customer-tags/${bTag.id}`, { name: 'Hijacked' }).expect(404);
      await a.delete(`/customer-tags/${bTag.id}`).expect(404);

      // References to B's rows from A's records.
      await a.post('/customers', customerBody({ corporateAccountId: bCorp.id })).expect(404);
      await a.post('/customers', customerBody({ tagIds: [bTag.id] })).expect(404);
      await a.patch(`/customers/${own.id}`, { corporateAccountId: bCorp.id }).expect(404);
      await a.patch(`/customers/${own.id}`, { tagIds: [bTag.id] }).expect(404);
      await a.put(`/customers/${own.id}/tags`, { tagIds: [bTag.id] }).expect(404);
      await a.post(`/customers/${own.id}/tags/${bTag.id}`).expect(404);

      // B is exactly as it was, and no "revealed" entry exists for it.
      expect(await row(b.id)).toMatchObject({ fullName: `${marker} Person`, status: 'ACTIVE', tenantId: beta.id });
      expect(await t.sys.customerNote.count({ where: { customerId: b.id } })).toBe(1);
      expect(await t.sys.customerContact.count({ where: { customerId: b.id } })).toBe(1);
      expect((await t.sys.customerTag.findUniqueOrThrow({ where: { id: bTag.id } })).name).toBe(bTag.name);
      expect(await t.sys.auditLog.count({ where: { resourceId: b.id, action: 'customer.identity_revealed' } })).toBe(0);
      expect(await t.sys.customerConsent.count({ where: { customerId: b.id, purpose: 'MARKETING' } })).toBe(0);
    });

    it('row-level security holds even for an unfiltered query', async () => {
      await createCustomer(t, beta);
      const rows = await t.inTenant(alpha.id, () => t.db.tx((tx) => tx.customer.findMany({ select: { tenantId: true } })));
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.tenantId === alpha.id)).toBe(true);
      const notes = await t.inTenant(alpha.id, () => t.db.tx((tx) => tx.customerNote.findMany({ select: { tenantId: true } })));
      expect(notes.every((r) => r.tenantId === alpha.id)).toBe(true);
    });

    it('a customer of centre A cannot use that login against centre B', async () => {
      const b = await createCustomer(t, beta);
      await t.as(portalCustomer).get(`/customers/${b.id}`).expect(403);
      // The session is bound to Alpha: "my customer" is always the Alpha record.
      expect((await t.as(portalCustomer).get('/me/customer')).body.id).toBe(portalCustomer.customerId);
      await expect(t.login(portalCustomer.email, PASSWORD, 'customer', beta.slug)).rejects.toThrow(/login failed/);
    });
  });
});
