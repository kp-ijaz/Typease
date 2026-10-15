import { authenticator } from 'otplib';
import { Actor, TenantFixture, TestApp } from './helpers';

/**
 * The name shown next to the code in an authenticator app: the centre's own brand for people of a
 * white-label centre, "TypEase" for platform staff and for centres that are presented as TypEase.
 */
describe('MFA enrolment: issuer', () => {
  let t: TestApp;
  let branded: TenantFixture;
  let plain: TenantFixture;
  let starter: TenantFixture;

  beforeAll(async () => {
    t = await TestApp.create();
    branded = await t.createTenant({ name: 'Al Noor Documents LLC' });
    plain = await t.createTenant({ name: 'Plain Typing' });
    starter = await t.createTenant({ name: 'Starter Typing', plan: 'starter' });
    await t.as(branded.owner).put('/branding', { mode: 'WHITE_LABEL', businessName: 'Al Noor: Typing Centre', primaryColor: '#7A1F5C' }).expect(200);
  });
  afterAll(() => t.close());

  const setup = async (actor: Actor) => (await t.as(actor).post('/auth/mfa/setup').expect(200)).body as { secret: string; issuer: string; otpauthUrl: string };
  const issuerIn = (url: string) => new URL(url).searchParams.get('issuer');

  it('is the brand name of a white-label centre for its staff and its customers', async () => {
    const staff = await t.addStaff(branded, 'receptionist');
    const enrol = await setup(staff);
    // A colon would split "issuer:account" in the app: it is replaced by a space.
    expect(enrol.issuer).toBe('Al Noor Typing Centre');
    expect(issuerIn(enrol.otpauthUrl)).toBe('Al Noor Typing Centre');
    expect(decodeURIComponent(new URL(enrol.otpauthUrl).pathname)).toBe(`/Al Noor Typing Centre:${staff.email}`);
    expect(enrol.otpauthUrl.startsWith('otpauth://totp/')).toBe(true);
    expect(enrol.otpauthUrl).not.toMatch(/TypEase/i);
    // The issuer is a label only: the secret works as before.
    const enabled = await t.as(staff).post('/auth/mfa/enable', { code: authenticator.generate(enrol.secret) }).expect(200);
    expect(enabled.body.recoveryCodes).toHaveLength(10);

    const customer = await t.addCustomer(branded);
    expect(await setup(customer)).toMatchObject({ issuer: 'Al Noor Typing Centre', secret: expect.any(String) });
  });

  it('stays "TypEase" for centres that are not white-labelled, for a plan without white label, and for platform staff', async () => {
    const owner = await setup(plain.owner);
    expect(owner.issuer).toBe('TypEase');
    expect(issuerIn(owner.otpauthUrl)).toBe('TypEase');
    expect(decodeURIComponent(new URL(owner.otpauthUrl).pathname)).toBe(`/TypEase:${plain.owner.email}`);

    // The starter plan does not include white label: whatever is stored, the presentation is TypEase.
    await t.sys.brandingSettings.upsert({
      where: { id: (await t.sys.brandingSettings.findFirst({ where: { tenantId: starter.id, branchId: null } }))?.id ?? '00000000-0000-4000-8000-000000000000' },
      update: { mode: 'WHITE_LABEL', businessName: 'Hidden Brand' },
      create: { tenantId: starter.id, mode: 'WHITE_LABEL', businessName: 'Hidden Brand' },
    });
    expect((await t.http.get(`/api/v1/public/tenant-config?slug=${starter.slug}`).expect(200)).body).toMatchObject({ mode: 'TYPEASE', name: 'Hidden Brand' });
    expect((await setup(starter.owner)).issuer).toBe('TypEase');

    const platformAdmin = await t.createPlatformAdmin('SUPER_ADMIN');
    const platform = await setup(platformAdmin);
    expect(platform.issuer).toBe('TypEase');
    expect(issuerIn(platform.otpauthUrl)).toBe('TypEase');

    // Switching white label off again brings "TypEase" back for new enrolments.
    await t.as(branded.owner).put('/branding', { mode: 'TYPEASE' }).expect(200);
    const later = await t.addStaff(branded, 'operator');
    expect((await setup(later)).issuer).toBe('TypEase');
  });
});
