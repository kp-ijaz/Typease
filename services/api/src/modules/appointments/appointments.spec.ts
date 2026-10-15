import { Actor, TenantFixture, TestApp } from '../../../test/helpers';
import { makeCustomer, makeService } from '../notifications/fixtures';
import { LogProvider } from '../notifications/providers/log';
import { NO_SHOW_JOB, REMINDER_JOB } from './appointments.service';
import { localParts, zonedTimeToUtc } from './slots';

const TZ = 'Asia/Dubai';
const ymdPlus = (days: number) => {
  const today = localParts(new Date(), TZ).date;
  return new Date(new Date(`${today}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);
};
const at = (date: string, time: string) => zonedTimeToUtc(date, time, TZ).toISOString();
const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

describe('Appointments', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let receptionist: Actor;
  let operator: Actor;
  const day = ymdPlus(3);
  const otherDay = ymdPlus(4);

  /** Bookable hours for every weekday at a branch. */
  const openCalendar = async (tenant: TenantFixture, branchId: string, over: Record<string, unknown> = {}) => {
    for (let w = 0; w < 7; w++) await t.as(tenant.owner).post('/appointments/slot-configs', { branchId, weekday: w, startTime: '09:00', endTime: '12:00', slotMinutes: 30, capacity: 2, ...over }).expect(201);
  };
  /** An appointment that exists already (e.g. started a moment ago), written directly. */
  const seedAppointment = (tenant: TenantFixture, data: Record<string, any>) =>
    t.sys.appointment.create({ data: { tenantId: tenant.id, branchId: tenant.headOfficeId, startsAt: new Date(Date.now() - 60_000), endsAt: new Date(Date.now() + 29 * 60_000), status: 'BOOKED', ...data } as any });

  beforeAll(async () => {
    t = await TestApp.create();
    alpha = await t.createTenant({ name: 'Alpha Typing' });
    beta = await t.createTenant({ name: 'Beta Typing' });
    receptionist = await t.addStaff(alpha, 'receptionist');
    operator = await t.addStaff(alpha, 'operator');
    await openCalendar(alpha, alpha.headOfficeId);
    await openCalendar(beta, beta.headOfficeId);
    await t.settle();
  });
  afterAll(() => t.close());

  // ------------------------------------------------------------------ calendar configuration
  describe('branch calendar', () => {
    it('manages slot configurations, closures and settings with the right permissions', async () => {
      const gamma = await t.createTenant();
      const manager = await t.addStaff(gamma, 'manager');
      const viewer = await t.addStaff(gamma, 'operator'); // appointment.read only
      const accountant = await t.addStaff(gamma, 'accountant'); // no appointment permission
      const config = await t.as(manager).post('/appointments/slot-configs', { branchId: gamma.headOfficeId, weekday: 1, startTime: '08:00', endTime: '13:00', slotMinutes: 20, capacity: 3 }).expect(201);
      expect(config.body).toMatchObject({ branchId: gamma.headOfficeId, weekday: 1, startTime: '08:00', endTime: '13:00', slotMinutes: 20, capacity: 3, isActive: true, serviceId: null });
      await t.as(manager).post('/appointments/slot-configs', { branchId: gamma.headOfficeId, weekday: 1, startTime: '13:00', endTime: '09:00' }).expect(400);
      await t.as(manager).post('/appointments/slot-configs', { branchId: gamma.headOfficeId, weekday: 9, startTime: '09:00', endTime: '10:00' }).expect(400);
      await t.as(viewer).post('/appointments/slot-configs', { branchId: gamma.headOfficeId, weekday: 2, startTime: '09:00', endTime: '10:00' }).expect(403);
      expect((await t.as(viewer).get('/appointments/slot-configs').expect(200)).body).toHaveLength(1);
      await t.as(accountant).get('/appointments/slot-configs').expect(403);
      await t.as(accountant).get('/appointments').expect(403);

      const updated = await t.as(manager).patch(`/appointments/slot-configs/${config.body.id}`, { capacity: 5, isActive: false }).expect(200);
      expect(updated.body).toMatchObject({ capacity: 5, isActive: false });
      expect((await t.as(manager).patch(`/appointments/slot-configs/${config.body.id}`, { endTime: '07:00' }).expect(422)).body.code).toBe('INVALID_HOURS');
      expect((await t.as(manager).get('/appointments/slot-configs').expect(200)).body).toHaveLength(0);
      expect((await t.as(manager).get('/appointments/slot-configs?includeInactive=true').expect(200)).body).toHaveLength(1);
      await t.as(manager).delete(`/appointments/slot-configs/${config.body.id}`).expect(200);
      await t.as(manager).delete(`/appointments/slot-configs/${config.body.id}`).expect(404);

      const closure = await t.as(manager).post('/appointments/closures', { branchId: gamma.headOfficeId, date: day, reason: 'National Day' }).expect(201);
      expect(closure.body).toMatchObject({ date: day, reason: 'National Day', affectedAppointments: 0 });
      await t.as(manager).post('/appointments/closures', { branchId: gamma.headOfficeId, date: day }).expect(409);
      expect((await t.as(viewer).get(`/appointments/closures?from=${day}&to=${day}`).expect(200)).body).toEqual([{ id: closure.body.id, branchId: gamma.headOfficeId, date: day, reason: 'National Day' }]);
      await t.as(viewer).delete(`/appointments/closures/${closure.body.id}`).expect(403);
      await t.as(manager).delete(`/appointments/closures/${closure.body.id}`).expect(200);

      expect((await t.as(manager).get('/appointments/settings').expect(200)).body).toEqual({ guestBookingEnabled: false, noShowAfterMinutes: 30, customerCancelCutoffMinutes: 0, reminderHoursBefore: [24, 2], maxDaysAhead: 60, limitToStaffOnDuty: false });
      const settings = await t.as(manager).put('/appointments/settings', { noShowAfterMinutes: 45, reminderHoursBefore: [3, 48] }).expect(200);
      expect(settings.body).toMatchObject({ noShowAfterMinutes: 45, reminderHoursBefore: [48, 3], guestBookingEnabled: false });
      await t.as(viewer).put('/appointments/settings', { guestBookingEnabled: true }).expect(403);
      // Other settings of the centre are untouched.
      await t.as(gamma.owner).patch('/tenant/settings', { invoiceDueDays: 14 }).expect(200);
      await t.as(manager).put('/appointments/settings', { maxDaysAhead: 30 }).expect(200);
      const stored = (await t.sys.tenant.findUniqueOrThrow({ where: { id: gamma.id } })).settings as any;
      expect(stored.invoiceDueDays).toBe(14);
      expect(stored.appointments).toMatchObject({ noShowAfterMinutes: 45, maxDaysAhead: 30 });
      expect(await t.sys.auditLog.count({ where: { tenantId: gamma.id, action: { startsWith: 'appointment.' } } })).toBeGreaterThanOrEqual(7);
    });

    it('computes availability in the branch time zone, excluding closures, past times and full slots', async () => {
      const res = await t.as(receptionist).get(`/appointments/availability?branchId=${alpha.headOfficeId}&date=${day}`).expect(200);
      expect(res.body).toMatchObject({ branchId: alpha.headOfficeId, date: day, timezone: TZ, closed: false });
      expect(res.body.slots).toHaveLength(6);
      // 09:00 in Dubai is 05:00 UTC.
      expect(res.body.slots[0]).toEqual({ startsAt: at(day, '09:00'), endsAt: at(day, '09:30'), localStart: '09:00', localEnd: '09:30', available: true, remaining: 2, capacity: 2, booked: 0, staffOnDuty: 0 });
      expect(res.body.slots[0].startsAt).toBe(`${day}T05:00:00.000Z`);
      expect(res.body.slots.map((s: any) => s.localStart)).toEqual(['09:00', '09:30', '10:00', '10:30', '11:00', '11:30']);

      const closure = await t.as(alpha.owner).post('/appointments/closures', { branchId: alpha.headOfficeId, date: otherDay, reason: 'Eid holiday' }).expect(201);
      const closed = await t.as(receptionist).get(`/appointments/availability?branchId=${alpha.headOfficeId}&date=${otherDay}`).expect(200);
      expect(closed.body).toMatchObject({ closed: true, closedReason: 'Eid holiday', slots: [] });
      const customer = await makeCustomer(t, alpha);
      expect((await t.as(receptionist).post('/appointments', { branchId: alpha.headOfficeId, customerId: customer.id, startsAt: at(otherDay, '09:00') }).expect(422)).body.code).toBe('BRANCH_CLOSED');
      await t.as(alpha.owner).delete(`/appointments/closures/${closure.body.id}`).expect(200);

      const past = await t.as(receptionist).get(`/appointments/availability?branchId=${alpha.headOfficeId}&date=${ymdPlus(-1)}`).expect(200);
      expect(past.body.slots).toHaveLength(6);
      expect(past.body.slots.every((s: any) => s.available === false)).toBe(true);
      const tooFar = await t.as(receptionist).get(`/appointments/availability?branchId=${alpha.headOfficeId}&date=${ymdPlus(90)}`).expect(200);
      expect(tooFar.body.slots).toEqual([]);
      await t.as(receptionist).get(`/appointments/availability?branchId=${alpha.headOfficeId}&date=tomorrow`).expect(400);
      await t.as(receptionist).get(`/appointments/availability?branchId=${beta.headOfficeId}&date=${day}`).expect(404);
    });

    it('gives a service its own calendar and capacity', async () => {
      const medical = await makeService(t, alpha, { name: 'Medical typing' });
      await t.as(alpha.owner).post('/appointments/slot-configs', { branchId: alpha.headOfficeId, serviceId: medical.id, weekday: weekday(day), startTime: '14:00', endTime: '15:00', slotMinutes: 60, capacity: 1 }).expect(201);
      const own = await t.as(receptionist).get(`/appointments/availability?branchId=${alpha.headOfficeId}&date=${day}&serviceId=${medical.id}`).expect(200);
      expect(own.body.slots.map((s: any) => [s.localStart, s.localEnd, s.capacity])).toEqual([['14:00', '15:00', 1]]);
      const a = await makeCustomer(t, alpha);
      const b = await makeCustomer(t, alpha);
      await t.as(receptionist).post('/appointments', { branchId: alpha.headOfficeId, customerId: a.id, serviceId: medical.id, startsAt: at(day, '14:00') }).expect(201);
      expect((await t.as(receptionist).post('/appointments', { branchId: alpha.headOfficeId, customerId: b.id, serviceId: medical.id, startsAt: at(day, '14:00') }).expect(409)).body.code).toBe('SLOT_FULL');
      // The general calendar has no 14:00 slot and is not touched by the medical booking.
      expect((await t.as(receptionist).post('/appointments', { branchId: alpha.headOfficeId, customerId: b.id, startsAt: at(day, '14:00') }).expect(422)).body.code).toBe('SLOT_UNAVAILABLE');
      const general = await t.as(receptionist).get(`/appointments/availability?branchId=${alpha.headOfficeId}&date=${day}`).expect(200);
      expect(general.body.slots.every((s: any) => s.booked === 0)).toBe(true);
    });
  });

  // ------------------------------------------------------------------ booking
  describe('booking', () => {
    it('books for a customer, confirms it by email in branch time and validates the request', async () => {
      const customer = await makeCustomer(t, alpha, { fullName: 'Fatima Al Mansoori', phone: null });
      const service = await makeService(t, alpha, { name: 'Emirates ID renewal' });
      const booked = await t.as(receptionist).post('/appointments', { branchId: alpha.headOfficeId, customerId: customer.id, serviceId: service.id, startsAt: at(day, '10:00'), notes: 'Bring the old card' }).expect(201);
      expect(booked.body).toMatchObject({
        branchId: alpha.headOfficeId,
        customerId: customer.id,
        customerName: 'Fatima Al Mansoori',
        serviceName: 'Emirates ID renewal',
        startsAt: at(day, '10:00'),
        endsAt: at(day, '10:30'),
        localDate: day,
        localTime: '10:00',
        localEndTime: '10:30',
        timezone: TZ,
        status: 'BOOKED',
        source: 'STAFF',
        notes: 'Bring the old card',
        customerNoShowCount: 0,
      });
      await t.settle();
      const email = await t.sys.notification.findFirstOrThrow({ where: { tenantId: alpha.id, eventKey: 'appointment.confirmation', channel: 'EMAIL', relatedId: booked.body.id } });
      expect(email.status).toBe('SENT');
      expect(email.subject).toMatch(/^Appointment confirmed: .+ at 10:00$/);
      expect(email.body).toContain('Emirates ID renewal');
      expect(LogProvider.lastFor(customer.email!, 'EMAIL')!.message.text).toContain('(Main Branch)');

      const base = { branchId: alpha.headOfficeId, customerId: customer.id };
      expect((await t.as(receptionist).post('/appointments', { ...base, startsAt: at(day, '10:00') }).expect(409)).body.code).toBe('ALREADY_BOOKED');
      expect((await t.as(receptionist).post('/appointments', { ...base, startsAt: at(day, '10:10') }).expect(422)).body.code).toBe('SLOT_UNAVAILABLE');
      expect((await t.as(receptionist).post('/appointments', { ...base, startsAt: at(day, '18:00') }).expect(422)).body.code).toBe('SLOT_UNAVAILABLE');
      expect((await t.as(receptionist).post('/appointments', { ...base, startsAt: at(ymdPlus(-2), '10:00') }).expect(422)).body.code).toBe('SLOT_IN_PAST');
      expect((await t.as(receptionist).post('/appointments', { ...base, startsAt: at(ymdPlus(200), '10:00') }).expect(422)).body.code).toBe('TOO_FAR_AHEAD');
      await t.as(receptionist).post('/appointments', { branchId: alpha.headOfficeId, startsAt: at(day, '11:00') }).expect(400); // nobody to book for
      await t.as(receptionist).post('/appointments', { ...base, startsAt: 'next tuesday' }).expect(400);
      await t.as(operator).post('/appointments', { ...base, startsAt: at(day, '11:00') }).expect(403); // appointment.read only
      const walkIn = await t.as(receptionist).post('/appointments', { branchId: alpha.headOfficeId, guestName: 'Walk-in Visitor', guestPhone: '+971 50 123 4567', startsAt: at(day, '11:00') }).expect(201);
      expect(walkIn.body).toMatchObject({ customerId: null, guestName: 'Walk-in Visitor', guestPhone: '+971501234567' });
      expect(await t.sys.auditLog.count({ where: { tenantId: alpha.id, action: 'appointment.booked', resourceId: booked.body.id } })).toBe(1);
    });

    it('never lets two people take the last place in a slot (concurrent requests)', async () => {
      const delta = await t.createTenant();
      await openCalendar(delta, delta.headOfficeId, { capacity: 1 });
      const customers = [];
      for (let i = 0; i < 2; i++) customers.push(await makeCustomer(t, delta));
      const book = (customerId: string, time: string) => t.as(delta.owner).post('/appointments', { branchId: delta.headOfficeId, customerId, startsAt: at(day, time) });
      const [one, two] = await Promise.all([book(customers[0].id, '09:00'), book(customers[1].id, '09:00')]);
      expect([one.status, two.status].sort()).toEqual([201, 409]);
      expect([one, two].find((r) => r.status === 409)!.body.code).toBe('SLOT_FULL');
      expect(await t.sys.appointment.count({ where: { tenantId: delta.id, startsAt: new Date(at(day, '09:00')), status: 'BOOKED' } })).toBe(1);

      // The same with a bigger crowd and two places.
      await t.sys.appointmentSlotConfig.updateMany({ where: { tenantId: delta.id }, data: { capacity: 2 } });
      const crowd = [];
      for (let i = 0; i < 6; i++) crowd.push(await makeCustomer(t, delta));
      const results = await Promise.all(crowd.map((c) => book(c.id, '10:00')));
      expect(results.filter((r) => r.status === 201)).toHaveLength(2);
      expect(results.filter((r) => r.status === 409 && r.body.code === 'SLOT_FULL')).toHaveLength(4);
      const slot = (await t.as(delta.owner).get(`/appointments/availability?branchId=${delta.headOfficeId}&date=${day}`).expect(200)).body.slots.find((s: any) => s.localStart === '10:00');
      expect(slot).toMatchObject({ capacity: 2, booked: 2, remaining: 0, available: false });
    });

    it('moves through the statuses, checks in with a queue token and refuses invalid changes', async () => {
      const customer = await makeCustomer(t, alpha);
      const service = await makeService(t, alpha, { categoryKey: 'visa' }); // second category -> letter B
      const seeded = await seedAppointment(alpha, { customerId: customer.id, serviceId: service.id });
      const id = seeded.id;
      expect((await t.as(receptionist).post(`/appointments/${id}/start`).expect(409)).body.code).toBe('INVALID_TRANSITION');
      expect((await t.as(receptionist).post(`/appointments/${id}/complete`).expect(409)).body.code).toBe('INVALID_TRANSITION');
      expect((await t.as(receptionist).post(`/appointments/${id}/confirm`).expect(200)).body.status).toBe('CONFIRMED');
      await t.as(receptionist).post(`/appointments/${id}/confirm`).expect(409);
      await t.as(operator).post(`/appointments/${id}/check-in`).expect(403);

      const checkedIn = await t.as(receptionist).post(`/appointments/${id}/check-in`).expect(200);
      expect(checkedIn.body.status).toBe('CHECKED_IN');
      expect(checkedIn.body.checkedInAt).toBeTruthy();
      expect(checkedIn.body.queueToken).toMatchObject({ status: 'WAITING', tokenNo: expect.stringMatching(/^B-\d{3}$/) });
      const token = await t.sys.queueToken.findUniqueOrThrow({ where: { id: checkedIn.body.queueToken.id } });
      expect(token).toMatchObject({ appointmentId: id, customerId: customer.id, branchId: alpha.headOfficeId, categoryId: service.categoryId });

      // Serving the token moves the appointment along.
      const called = await t.as(receptionist).post('/queue/call-next', { branchId: alpha.headOfficeId, counter: '1', categoryId: service.categoryId }).expect(200);
      expect(called.body.token.id).toBe(token.id);
      await t.as(receptionist).post(`/queue/tokens/${token.id}/start`).expect(200);
      expect((await t.as(receptionist).get(`/appointments/${id}`).expect(200)).body).toMatchObject({ status: 'IN_SERVICE', queueToken: { tokenNo: token.tokenNo, status: 'SERVING', counter: '1' } });
      await t.as(receptionist).post(`/queue/tokens/${token.id}/complete`).expect(200);
      expect((await t.as(receptionist).get(`/appointments/${id}`).expect(200)).body.status).toBe('COMPLETED');

      for (const action of ['cancel', 'confirm', 'no-show', 'check-in', 'start']) expect((await t.as(receptionist).post(`/appointments/${id}/${action}`).expect(409)).body.code).toBe('INVALID_TRANSITION');
      expect((await t.as(receptionist).patch(`/appointments/${id}`, { notes: 'late note' }).expect(409)).body.code).toBe('APPOINTMENT_CLOSED');
      const future = (await t.as(receptionist).post('/appointments', { branchId: alpha.headOfficeId, customerId: customer.id, startsAt: at(day, '11:30') }).expect(201)).body;
      expect((await t.as(receptionist).post(`/appointments/${future.id}/check-in`).expect(422)).body.code).toBe('CHECK_IN_WRONG_DAY');
      expect((await t.as(receptionist).post(`/appointments/${future.id}/no-show`).expect(422)).body.code).toBe('TOO_EARLY');
      const cancelled = await t.as(receptionist).post(`/appointments/${future.id}/cancel`, { reason: 'Customer called' }).expect(200);
      expect(cancelled.body).toMatchObject({ status: 'CANCELLED', cancelledReason: 'Customer called' });
      expect(await t.sys.auditLog.count({ where: { tenantId: alpha.id, resourceId: id, action: { in: ['appointment.confirmed', 'appointment.checked_in'] } } })).toBe(2);
    });

    it('reschedules by creating a linked appointment and freeing the old place', async () => {
      const customer = await makeCustomer(t, alpha);
      const original = (await t.as(receptionist).post('/appointments', { branchId: alpha.headOfficeId, customerId: customer.id, startsAt: at(otherDay, '09:00'), notes: 'Needs Arabic speaker' }).expect(201)).body;
      expect((await t.as(receptionist).post(`/appointments/${original.id}/reschedule`, { startsAt: at(otherDay, '09:00') }).expect(422)).body.code).toBe('SAME_SLOT');
      expect((await t.as(receptionist).post(`/appointments/${original.id}/reschedule`, { startsAt: at(otherDay, '09:10') }).expect(422)).body.code).toBe('SLOT_UNAVAILABLE');
      expect((await t.as(receptionist).get(`/appointments/${original.id}`).expect(200)).body.status).toBe('BOOKED'); // a failed attempt changes nothing

      const moved = await t.as(receptionist).post(`/appointments/${original.id}/reschedule`, { startsAt: at(otherDay, '11:00'), reason: 'Customer asked for a later time' }).expect(200);
      expect(moved.body).toMatchObject({ status: 'BOOKED', rescheduledFromId: original.id, customerId: customer.id, localTime: '11:00', notes: 'Needs Arabic speaker' });
      expect(moved.body.id).not.toBe(original.id);
      expect((await t.as(receptionist).get(`/appointments/${original.id}`).expect(200)).body).toMatchObject({ status: 'RESCHEDULED', rescheduledToId: moved.body.id });
      const slots = (await t.as(receptionist).get(`/appointments/availability?branchId=${alpha.headOfficeId}&date=${otherDay}`).expect(200)).body.slots;
      expect(slots.find((s: any) => s.localStart === '09:00').booked).toBe(0);
      expect(slots.find((s: any) => s.localStart === '11:00').booked).toBe(1);
      expect((await t.as(receptionist).post(`/appointments/${original.id}/reschedule`, { startsAt: at(otherDay, '10:00') }).expect(409)).body.code).toBe('INVALID_TRANSITION');
      await t.settle();
      expect(await t.sys.notification.count({ where: { tenantId: alpha.id, eventKey: 'appointment.confirmation', channel: 'EMAIL', relatedId: moved.body.id } })).toBe(1);
    });

    it('assigns staff only when they are available, scheduled and free', async () => {
      const epsilon = await t.createTenant();
      await openCalendar(epsilon, epsilon.headOfficeId, { capacity: 3 });
      const clerk = await t.addStaff(epsilon, 'receptionist');
      const w = weekday(day);
      await t.sys.staffSchedule.create({ data: { tenantId: epsilon.id, membershipId: clerk.membershipId!, branchId: epsilon.headOfficeId, weekday: w, startTime: '09:00', endTime: '10:30' } });
      const [a, b] = [await makeCustomer(t, epsilon), await makeCustomer(t, epsilon)];
      const book = (customerId: string, time: string, staffId?: string) => t.as(epsilon.owner).post('/appointments', { branchId: epsilon.headOfficeId, customerId, startsAt: at(day, time), staffId });

      const first = await book(a.id, '09:00', clerk.membershipId!).expect(201);
      expect(first.body.staffName).toContain('receptionist');
      expect((await book(b.id, '09:00', clerk.membershipId!).expect(409)).body.code).toBe('STAFF_UNAVAILABLE'); // double-booked
      expect((await book(b.id, '11:00', clerk.membershipId!).expect(409)).body.code).toBe('STAFF_UNAVAILABLE'); // outside the schedule
      await book(b.id, '09:00', '00000000-0000-4000-8000-000000000000').expect(404);

      const forClerk = (await t.as(epsilon.owner).get(`/appointments/availability?branchId=${epsilon.headOfficeId}&date=${day}&staffId=${clerk.membershipId}`).expect(200)).body.slots;
      expect(forClerk.map((s: any) => [s.localStart, s.available, s.staffOnDuty])).toEqual([['09:00', false, 1], ['09:30', true, 1], ['10:00', true, 1], ['10:30', false, 0], ['11:00', false, 0], ['11:30', false, 0]]);

      // Optional rule: a slot cannot take more people than there are staff on duty.
      await t.as(epsilon.owner).put('/appointments/settings', { limitToStaffOnDuty: true }).expect(200);
      const limited = (await t.as(epsilon.owner).get(`/appointments/availability?branchId=${epsilon.headOfficeId}&date=${day}`).expect(200)).body.slots;
      expect(limited.map((s: any) => [s.localStart, s.capacity])).toEqual([['09:00', 1], ['09:30', 1], ['10:00', 1], ['10:30', 0], ['11:00', 0], ['11:30', 0]]);
      expect((await book(b.id, '11:00').expect(409)).body.code).toBe('SLOT_FULL');
      // A member who is marked unavailable is not on duty.
      await t.sys.tenantMembership.update({ where: { id: clerk.membershipId! }, data: { isAvailable: false } });
      expect((await book(b.id, '09:30', clerk.membershipId!).expect(409)).body.code).toBe('SLOT_FULL');
      await t.as(epsilon.owner).put('/appointments/settings', { limitToStaffOnDuty: false }).expect(200);
      expect((await book(b.id, '09:30', clerk.membershipId!).expect(409)).body.code).toBe('STAFF_UNAVAILABLE');
    });
  });

  // ------------------------------------------------------------------ customers
  describe('customers', () => {
    it('lets customers book, list, reschedule and cancel only their own appointments', async () => {
      const one = await t.addCustomer(alpha);
      const two = await t.addCustomer(alpha);
      const slots = await t.as(one).get(`/appointments/availability?branchId=${alpha.headOfficeId}&date=${ymdPlus(5)}`).expect(200);
      expect(slots.body.slots[0]).toEqual({ startsAt: at(ymdPlus(5), '09:00'), endsAt: at(ymdPlus(5), '09:30'), localStart: '09:00', localEnd: '09:30', available: true, remaining: 2 });
      expect(slots.body.closedReason).toBeNull();

      // customerId in the body is ignored: a customer always books for themselves.
      const mine = await t.as(one).post('/me/appointments', { branchId: alpha.headOfficeId, startsAt: at(ymdPlus(5), '09:00'), customerId: two.customerId, notes: 'First visit' }).expect(201);
      expect(mine.body).toMatchObject({ status: 'BOOKED', localTime: '09:00', branchName: 'Main Branch', canCancel: true, canReschedule: true });
      expect(mine.body.notes).toBeUndefined();
      const stored = await t.sys.appointment.findUniqueOrThrow({ where: { id: mine.body.id } });
      expect(stored).toMatchObject({ customerId: one.customerId, source: 'CUSTOMER' });
      const theirs = (await t.as(two).post('/me/appointments', { branchId: alpha.headOfficeId, startsAt: at(ymdPlus(5), '09:00') }).expect(201)).body;

      expect((await t.as(one).get('/me/appointments').expect(200)).body.data.map((a: any) => a.id)).toEqual([mine.body.id]);
      expect((await t.as(one).get('/me/appointments?upcoming=true').expect(200)).body.meta.total).toBe(1);
      await t.as(one).get(`/me/appointments/${theirs.id}`).expect(404);
      await t.as(one).post(`/me/appointments/${theirs.id}/cancel`).expect(404);
      await t.as(one).post(`/me/appointments/${theirs.id}/reschedule`, { startsAt: at(ymdPlus(5), '10:00') }).expect(404);
      // No access to the staff side.
      await t.as(one).get('/appointments').expect(403);
      await t.as(one).get(`/appointments/${mine.body.id}`).expect(403);
      await t.as(one).post(`/appointments/${theirs.id}/cancel`).expect(403);
      await t.as(one).post('/appointments', { branchId: alpha.headOfficeId, customerId: one.customerId, startsAt: at(ymdPlus(5), '10:00') }).expect(403);
      await t.as(one).get('/appointments/slot-configs').expect(403);
      // The slot is full now (2 of 2): a third customer cannot squeeze in.
      const three = await t.addCustomer(alpha);
      expect((await t.as(three).post('/me/appointments', { branchId: alpha.headOfficeId, startsAt: at(ymdPlus(5), '09:00') }).expect(409)).body.code).toBe('SLOT_FULL');

      const moved = await t.as(one).post(`/me/appointments/${mine.body.id}/reschedule`, { startsAt: at(ymdPlus(5), '10:30') }).expect(200);
      expect(moved.body).toMatchObject({ rescheduledFromId: mine.body.id, localTime: '10:30', status: 'BOOKED' });
      expect((await t.as(one).get(`/me/appointments/${mine.body.id}`).expect(200)).body).toMatchObject({ status: 'RESCHEDULED', canCancel: false, rescheduledToId: moved.body.id });
      const cancelled = await t.as(one).post(`/me/appointments/${moved.body.id}/cancel`, { reason: 'Travelling' }).expect(200);
      expect(cancelled.body).toMatchObject({ status: 'CANCELLED', cancelledReason: 'Travelling', canCancel: false });
      await t.as(one).post(`/me/appointments/${moved.body.id}/cancel`).expect(409);
    });

    it('does not let a customer cancel after the start or inside the cut-off', async () => {
      const portal = await t.addCustomer(beta);
      const started = await seedAppointment(beta, { customerId: portal.customerId });
      const late = await t.as(portal).post(`/me/appointments/${started.id}/cancel`).expect(409);
      expect(late.body.code).toBe('TOO_LATE_TO_CHANGE');
      expect((await t.as(portal).post(`/me/appointments/${started.id}/reschedule`, { startsAt: at(day, '09:00') }).expect(409)).body.code).toBe('TOO_LATE_TO_CHANGE');
      expect((await t.sys.appointment.findUniqueOrThrow({ where: { id: started.id } })).status).toBe('BOOKED');
      // Staff can still cancel it.
      expect((await t.as(beta.owner).post(`/appointments/${started.id}/cancel`).expect(200)).body.status).toBe('CANCELLED');

      await t.as(beta.owner).put('/appointments/settings', { customerCancelCutoffMinutes: 120 }).expect(200);
      const soon = await seedAppointment(beta, { customerId: portal.customerId, startsAt: new Date(Date.now() + 60 * 60_000), endsAt: new Date(Date.now() + 90 * 60_000) });
      const blocked = await t.as(portal).post(`/me/appointments/${soon.id}/cancel`).expect(409);
      expect(blocked.body.message).toContain('120 minutes');
      expect((await t.as(portal).get(`/me/appointments/${soon.id}`).expect(200)).body.canCancel).toBe(false);
      const farAhead = (await t.as(portal).post('/me/appointments', { branchId: beta.headOfficeId, startsAt: at(day, '09:30') }).expect(201)).body;
      expect((await t.as(portal).post(`/me/appointments/${farAhead.id}/cancel`).expect(200)).body.status).toBe('CANCELLED');
      await t.as(beta.owner).put('/appointments/settings', { customerCancelCutoffMinutes: 0 }).expect(200);
    });
  });

  // ------------------------------------------------------------------ guests
  describe('public guest booking', () => {
    it('is off unless the centre enables it, then books with name and phone only', async () => {
      const zeta = await t.createTenant({ name: 'Zeta Typing' });
      await openCalendar(zeta, zeta.headOfficeId);
      const body = { tenant: zeta.slug, branchId: zeta.headOfficeId, startsAt: at(day, '09:00'), guestName: 'Yousef Guest', guestPhone: '+971 55 222 3344' };
      expect((await t.http.post('/api/v1/public/appointments').send(body).expect(403)).body.code).toBe('GUEST_BOOKING_DISABLED');
      expect((await t.http.get(`/api/v1/public/appointments/availability?tenant=${zeta.slug}&branchId=${zeta.headOfficeId}&date=${day}`).expect(403)).body.code).toBe('GUEST_BOOKING_DISABLED');
      expect((await t.http.get(`/api/v1/public/appointments/options?tenant=${zeta.slug}`).expect(200)).body).toEqual({ guestBookingEnabled: false, maxDaysAhead: 60, branches: [], services: [] });

      await t.as(zeta.owner).put('/appointments/settings', { guestBookingEnabled: true }).expect(200);
      const options = await t.http.get(`/api/v1/public/appointments/options?tenant=${zeta.slug}`).expect(200);
      expect(options.body.guestBookingEnabled).toBe(true);
      expect(options.body.branches).toEqual([{ id: zeta.headOfficeId, name: 'Main Branch', nameAr: null, address: null, timezone: TZ }]);
      const availability = await t.http.get(`/api/v1/public/appointments/availability?tenant=${zeta.slug}&branchId=${zeta.headOfficeId}&date=${day}`).expect(200);
      expect(availability.body.slots[0]).toEqual({ startsAt: at(day, '09:00'), endsAt: at(day, '09:30'), localStart: '09:00', localEnd: '09:30', available: true, remaining: 2 });

      const booked = await t.http.post('/api/v1/public/appointments').send(body).expect(201);
      expect(booked.body).toMatchObject({ status: 'BOOKED', branchName: 'Main Branch', localDate: day, localTime: '09:00', manageToken: expect.any(String) });
      const row = await t.sys.appointment.findUniqueOrThrow({ where: { id: booked.body.id } });
      expect(row).toMatchObject({ tenantId: zeta.id, customerId: null, guestName: 'Yousef Guest', guestPhone: '+971552223344', source: 'GUEST', createdById: null });
      // The guest gets a text message; nothing else is known about them.
      await t.settle();
      const sms = await t.sys.notification.findFirstOrThrow({ where: { tenantId: zeta.id, eventKey: 'appointment.confirmation', relatedId: row.id } });
      expect(sms).toMatchObject({ channel: 'SMS', status: 'SENT', recipientAddress: '+971552223344', recipientCustomerId: null });
      expect(LogProvider.lastFor('+971552223344', 'SMS')!.message.text).toMatch(/your appointment at Main Branch is booked for .+ at 09:00\./);

      // Validation and abuse limits.
      await t.http.post('/api/v1/public/appointments').send({ ...body, guestPhone: '0501234567' }).expect(400);
      await t.http.post('/api/v1/public/appointments').send({ ...body, guestName: '' }).expect(400);
      expect((await t.http.post('/api/v1/public/appointments').send(body).expect(409)).body.code).toBe('ALREADY_BOOKED');
      await t.http.post('/api/v1/public/appointments').send({ ...body, startsAt: at(day, '10:00') }).expect(201);
      expect((await t.http.post('/api/v1/public/appointments').send({ ...body, startsAt: at(day, '11:00') }).expect(409)).body.code).toBe('TOO_MANY_BOOKINGS');
      await t.http.post('/api/v1/public/appointments').send({ ...body, tenant: 'no-such-centre' }).expect(404);
      // A branch of another centre cannot be used through this centre's page.
      await t.http.post('/api/v1/public/appointments').send({ ...body, branchId: alpha.headOfficeId, guestPhone: '+971551110000' }).expect(404);

      // Cancelling with the token from the booking.
      await t.http.post('/api/v1/public/appointments/cancel').send({ token: `${booked.body.manageToken}x` }).expect(401);
      const cancelled = await t.http.post('/api/v1/public/appointments/cancel').send({ token: booked.body.manageToken }).expect(200);
      expect(cancelled.body).toEqual({ id: booked.body.id, status: 'CANCELLED' });
      await t.http.post('/api/v1/public/appointments/cancel').send({ token: booked.body.manageToken }).expect(409);
      const audit = await t.sys.auditLog.findFirstOrThrow({ where: { tenantId: zeta.id, action: 'appointment.cancelled', resourceId: booked.body.id } });
      expect(audit).toMatchObject({ actorType: 'CUSTOMER', actorLabel: 'guest', actorUserId: null });
    });
  });

  // ------------------------------------------------------------------ jobs
  describe('reminders and no-shows (jobs)', () => {
    it('emits a reminder 24 hours and 2 hours before, once each', async () => {
      const eta = await t.createTenant({ name: 'Eta Typing' });
      const customer = await makeCustomer(t, eta, { phone: null });
      const startsAt = new Date(Date.now() + 30 * 3_600_000);
      const a = await seedAppointment(eta, { customerId: customer.id, startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000), createdAt: new Date(Date.now() - 5 * 86_400_000) });
      const run = async (now: Date) => {
        await t.jobs.execute(REMINDER_JOB, { now: now.toISOString() }, { attempt: 1, maxAttempts: 1 });
        await t.settle();
      };
      const reminders = () => t.sys.notification.findMany({ where: { tenantId: eta.id, eventKey: 'appointment.reminder', relatedId: a.id, channel: 'EMAIL' }, orderBy: { createdAt: 'asc' } });

      await run(new Date()); // 30 hours ahead: too early
      expect(await reminders()).toHaveLength(0);
      const dayBefore = new Date(startsAt.getTime() - 23.5 * 3_600_000);
      await run(dayBefore);
      await run(dayBefore);
      await run(new Date(dayBefore.getTime() + 15 * 60_000));
      let sent = await reminders();
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ status: 'SENT', recipientAddress: customer.email });
      expect(sent[0].subject).toMatch(/^Reminder: appointment on .+ at \d{2}:\d{2}$/);
      expect((await t.sys.appointment.findUniqueOrThrow({ where: { id: a.id } })).reminderSentAt!.toISOString()).toBe(dayBefore.toISOString());

      const twoHours = new Date(startsAt.getTime() - 100 * 60_000);
      await run(twoHours);
      await run(twoHours);
      sent = await reminders();
      expect(sent).toHaveLength(2);

      // A cancelled appointment gets no reminder.
      const other = await seedAppointment(eta, { customerId: customer.id, startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000), createdAt: new Date(Date.now() - 5 * 86_400_000), status: 'CANCELLED' });
      await run(twoHours);
      expect(await t.sys.notification.count({ where: { tenantId: eta.id, eventKey: 'appointment.reminder', relatedId: other.id } })).toBe(0);
    });

    it('marks missed appointments as no-shows, counts them per customer and allows a late check-in', async () => {
      const theta = await t.createTenant();
      await openCalendar(theta, theta.headOfficeId);
      const customer = await makeCustomer(t, theta);
      const missed = await seedAppointment(theta, { customerId: customer.id, startsAt: new Date(Date.now() - 45 * 60_000), endsAt: new Date(Date.now() - 15 * 60_000) });
      const recent = await seedAppointment(theta, { customerId: customer.id, startsAt: new Date(Date.now() - 10 * 60_000), endsAt: new Date(Date.now() + 20 * 60_000) });
      const checkedIn = await seedAppointment(theta, { customerId: customer.id, startsAt: new Date(Date.now() - 50 * 60_000), endsAt: new Date(Date.now() - 20 * 60_000), status: 'CHECKED_IN' });
      await t.jobs.execute(NO_SHOW_JOB, {}, { attempt: 1, maxAttempts: 1 });
      const status = async (id: string) => (await t.sys.appointment.findUniqueOrThrow({ where: { id } })).status;
      expect(await status(missed.id)).toBe('NO_SHOW');
      expect(await status(recent.id)).toBe('BOOKED'); // only 10 minutes late, the limit is 30
      expect(await status(checkedIn.id)).toBe('CHECKED_IN');
      const audit = await t.sys.auditLog.findFirstOrThrow({ where: { tenantId: theta.id, action: 'appointment.no_show', resourceId: missed.id } });
      expect(audit.actorType).toBe('SYSTEM');

      const next = (await t.as(theta.owner).post('/appointments', { branchId: theta.headOfficeId, customerId: customer.id, startsAt: at(day, '09:00') }).expect(201)).body;
      expect(next.customerNoShowCount).toBe(1);
      const list = await t.as(theta.owner).get(`/appointments?customerId=${customer.id}&status=BOOKED`).expect(200);
      expect(list.body.data.every((a: any) => a.customerNoShowCount === 1)).toBe(true);
      expect((await t.as(theta.owner).get('/appointments?status=NO_SHOW').expect(200)).body.data.map((a: any) => a.id)).toEqual([missed.id]);

      // The customer turns up late after all (same day): staff can still check them in.
      if (localParts(missed.startsAt, TZ).date === localParts(new Date(), TZ).date) {
        expect((await t.as(theta.owner).post(`/appointments/${missed.id}/check-in`, { issueToken: false }).expect(200)).body).toMatchObject({ status: 'CHECKED_IN', queueToken: null });
      }
      // Staff can also mark a no-show by hand once the start time has passed.
      expect((await t.as(theta.owner).post(`/appointments/${recent.id}/no-show`).expect(200)).body.status).toBe('NO_SHOW');
    });
  });

  // ------------------------------------------------------------------ lists, branches, isolation
  describe('lists, branch scope and tenant isolation', () => {
    it('filters the list and limits branch staff to their branches', async () => {
      const iota = await t.createTenant();
      const second = (await t.as(iota.owner).post('/branches', { code: 'B2', name: 'Second Branch' }).expect(201)).body;
      await openCalendar(iota, iota.headOfficeId);
      await openCalendar(iota, second.id);
      const branchClerk = await t.addStaff(iota, 'receptionist', { branchIds: [second.id] });
      const customer = await makeCustomer(t, iota, { fullName: 'Zainab Noor' });
      const main = (await t.as(iota.owner).post('/appointments', { branchId: iota.headOfficeId, customerId: customer.id, startsAt: at(day, '09:00') }).expect(201)).body;
      const other = (await t.as(iota.owner).post('/appointments', { branchId: second.id, guestName: 'Visitor Two', startsAt: at(otherDay, '10:00') }).expect(201)).body;

      expect((await t.as(iota.owner).get('/appointments').expect(200)).body.data.map((a: any) => a.id)).toEqual([main.id, other.id]); // by start time
      expect((await t.as(iota.owner).get(`/appointments?date=${day}&branchId=${iota.headOfficeId}`).expect(200)).body.data.map((a: any) => a.id)).toEqual([main.id]);
      expect((await t.as(iota.owner).get(`/appointments?from=${otherDay}&to=${otherDay}`).expect(200)).body.data.map((a: any) => a.id)).toEqual([other.id]);
      expect((await t.as(iota.owner).get('/appointments?q=zainab').expect(200)).body.data.map((a: any) => a.id)).toEqual([main.id]);
      expect((await t.as(iota.owner).get(`/appointments?customerId=${customer.id}&status=CANCELLED`).expect(200)).body.meta.total).toBe(0);

      // The clerk of the second branch sees and handles only that branch.
      expect((await t.as(branchClerk).get('/appointments').expect(200)).body.data.map((a: any) => a.id)).toEqual([other.id]);
      expect((await t.as(branchClerk).get(`/appointments/${main.id}`).expect(403)).body.code).toBe('BRANCH_FORBIDDEN');
      await t.as(branchClerk).post(`/appointments/${main.id}/cancel`).expect(403);
      await t.as(branchClerk).get(`/appointments?branchId=${iota.headOfficeId}`).expect(403);
      await t.as(branchClerk).post('/appointments', { branchId: iota.headOfficeId, customerId: customer.id, startsAt: at(day, '10:00') }).expect(403);
      await t.as(branchClerk).get(`/appointments/availability?branchId=${iota.headOfficeId}&date=${day}`).expect(403);
      await t.as(branchClerk).post('/appointments/slot-configs', { branchId: iota.headOfficeId, weekday: 1, startTime: '14:00', endTime: '15:00' }).expect(403);
      expect((await t.as(branchClerk).post(`/appointments/${other.id}/confirm`).expect(200)).body.status).toBe('CONFIRMED');
      expect((await t.as(branchClerk).get('/appointments/slot-configs').expect(200)).body.every((c: any) => c.branchId === second.id)).toBe(true);
    });

    it('never lets tenant B read, change or reference tenant A appointments and calendars', async () => {
      const customer = await makeCustomer(t, alpha);
      const a = (await t.as(alpha.owner).post('/appointments', { branchId: alpha.headOfficeId, customerId: customer.id, startsAt: at(ymdPlus(6), '09:00') }).expect(201)).body;
      const config = (await t.as(alpha.owner).get('/appointments/slot-configs').expect(200)).body[0];
      await t.as(beta.owner).get(`/appointments/${a.id}`).expect(404);
      for (const action of ['confirm', 'check-in', 'cancel', 'no-show', 'start', 'complete']) await t.as(beta.owner).post(`/appointments/${a.id}/${action}`).expect(404);
      await t.as(beta.owner).post(`/appointments/${a.id}/reschedule`, { startsAt: at(ymdPlus(6), '10:00') }).expect(404);
      await t.as(beta.owner).patch(`/appointments/${a.id}`, { notes: 'hijack' }).expect(404);
      await t.as(beta.owner).patch(`/appointments/slot-configs/${config.id}`, { capacity: 99 }).expect(404);
      await t.as(beta.owner).delete(`/appointments/slot-configs/${config.id}`).expect(404);
      // Cross-tenant references are "not found".
      const betaCustomer = await makeCustomer(t, beta);
      await t.as(beta.owner).post('/appointments', { branchId: alpha.headOfficeId, customerId: betaCustomer.id, startsAt: at(ymdPlus(6), '09:00') }).expect(404);
      await t.as(beta.owner).post('/appointments', { branchId: beta.headOfficeId, customerId: customer.id, startsAt: at(ymdPlus(6), '09:00') }).expect(404);
      await t.as(beta.owner).post('/appointments/slot-configs', { branchId: alpha.headOfficeId, weekday: 1, startTime: '09:00', endTime: '10:00' }).expect(404);
      await t.as(beta.owner).post('/appointments/closures', { branchId: alpha.headOfficeId, date: day }).expect(404);
      const betaPortal = await t.addCustomer(beta);
      await t.as(betaPortal).get(`/me/appointments/${a.id}`).expect(404);
      await t.as(betaPortal).post('/me/appointments', { branchId: alpha.headOfficeId, startsAt: at(ymdPlus(6), '09:30') }).expect(404);

      const list = await t.as(beta.owner).get('/appointments?pageSize=100').expect(200);
      expect(list.body.data.some((x: any) => x.id === a.id)).toBe(false);
      const seen = await t.inTenant(beta.id, () => t.db.tx((tx) => tx.appointment.findMany({ select: { tenantId: true } })));
      expect(seen.every((r) => r.tenantId === beta.id)).toBe(true);
      const untouched = await t.sys.appointment.findUniqueOrThrow({ where: { id: a.id } });
      expect(untouched).toMatchObject({ status: 'BOOKED', notes: null });
      expect((await t.sys.appointmentSlotConfig.findUniqueOrThrow({ where: { id: config.id } })).capacity).toBe(2);
    });
  });
});
