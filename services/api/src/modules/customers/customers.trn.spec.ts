import { Actor, TenantFixture, TestApp } from '../../../test/helpers';
import { customerBody } from './fixtures';

/** The TRN of a business customer, printed on its tax invoices (migration 0004). */
describe('Customers: tax registration number', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  let receptionist: Actor;

  beforeAll(async () => {
    t = await TestApp.create();
    alpha = await t.createTenant({ name: 'Alpha Typing' });
    receptionist = await t.addStaff(alpha, 'receptionist');
  });
  afterAll(() => t.close());

  it('stores a 15-digit TRN for a business customer (spaces ignored) and returns it on the profile', async () => {
    const res = await t
      .as(receptionist)
      .post('/customers', customerBody({ type: 'BUSINESS', fullName: 'Gulf Trading LLC', taxRegistrationNo: '100 1234 5670 0003' }))
      .expect(201);
    expect(res.body.taxRegistrationNo).toBe('100123456700003');
    const profile = await t.as(receptionist).get(`/customers/${res.body.id}`).expect(200);
    expect(profile.body.taxRegistrationNo).toBe('100123456700003');
  });

  it('rejects a TRN that is not 15 digits, on create and on update', async () => {
    const bad = await t.as(receptionist).post('/customers', customerBody({ type: 'BUSINESS', fullName: 'Short TRN LLC', taxRegistrationNo: '12345' })).expect(400);
    expect(JSON.stringify(bad.body)).toContain('taxRegistrationNo');
    const ok = await t.as(receptionist).post('/customers', customerBody({ type: 'BUSINESS', fullName: 'Later TRN LLC' })).expect(201);
    expect(ok.body.taxRegistrationNo).toBeNull();
    await t.as(receptionist).patch(`/customers/${ok.body.id}`).send({ taxRegistrationNo: 'ABC123456789012' }).expect(400);
    const updated = await t.as(receptionist).patch(`/customers/${ok.body.id}`).send({ taxRegistrationNo: '100987654300003' }).expect(200);
    expect(updated.body.taxRegistrationNo).toBe('100987654300003');
  });

  it('is also enforced by the database', async () => {
    const ok = await t.as(receptionist).post('/customers', customerBody({ type: 'BUSINESS', fullName: 'Direct Write LLC' })).expect(201);
    await expect(t.sys.customer.update({ where: { id: ok.body.id }, data: { taxRegistrationNo: '123' } })).rejects.toThrow(/customers_trn_format/);
  });
});
