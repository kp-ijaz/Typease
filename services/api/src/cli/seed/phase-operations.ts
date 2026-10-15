import type { AppointmentFx, TaskFx } from './fixture-types';
import { DAY, daysAgo, step } from './runtime';
import { SeedContext, TenantState } from './state';

/** Dubai has no daylight saving time: local time is always UTC+4. */
const TZ_MS = 4 * 3_600_000;
const localDay = (at: Date) => new Date(at.getTime() + TZ_MS).toISOString().slice(0, 10);
const addDays = (day: string, n: number) => new Date(new Date(`${day}T00:00:00Z`).getTime() + n * DAY).toISOString().slice(0, 10);
const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Today's walk-in queue at the head office: issued, called, served, a no-show, a cancelled token, people still waiting. */
export async function runQueue(ctx: SeedContext, t: TenantState): Promise<void> {
  const plan = t.fx.queueToday ?? [];
  if (!plan.length) return;
  const { rt } = ctx;
  const branch = t.branch();
  const desk = rt.as(t.receptionist(branch.code));
  await step(`${t.fx.name}: today's queue at ${branch.name} (${plan.length} tokens)`, async () => {
    const tokens: any[] = [];
    for (const p of plan) {
      tokens.push(await desk.post('/queue/tokens', { branchId: branch.id, ...(p.service ? { serviceId: t.service(p.service).id } : {}), ...(p.customer ? { customerId: t.customer(p.customer).id } : {}) }));
    }
    // Somebody leaves before being called.
    for (const [i, p] of plan.entries()) if (p.state === 'CANCELLED') await desk.post(`/queue/tokens/${tokens[i].id}/cancel`);
    // Counters press "next": the longest-waiting token comes up, in the order the tokens were issued.
    for (const [i, p] of plan.entries()) {
      if (p.state === 'WAITING' || p.state === 'CANCELLED') continue;
      const called = await desk.post('/queue/call-next', { branchId: branch.id, counter: p.counter ?? '1' });
      if (called.token?.id !== tokens[i].id) throw new Error(`Queue: expected token ${tokens[i].tokenNo} to be called next, got ${called.token?.tokenNo ?? 'nobody'}.`);
      if (p.state === 'NO_SHOW') await desk.post(`/queue/tokens/${tokens[i].id}/no-show`);
      if (p.state === 'SERVING' || p.state === 'COMPLETED') await desk.post(`/queue/tokens/${tokens[i].id}/start`);
      if (p.state === 'COMPLETED') await desk.post(`/queue/tokens/${tokens[i].id}/complete`);
    }
    // A signed link for the waiting-room screen.
    const display = await desk.post('/queue/display-tokens', { branchId: branch.id, validDays: 30 });
    const state = await rt.anonymous().get(`/public/queue/display?token=${encodeURIComponent(display.token)}`);
    ctx.highlights.push(`Queue display of ${t.fx.name} / ${branch.name}: now serving ${state.nowServing.map((x: any) => x.tokenNo).join(', ') || '-'}, ${state.waitingCount} waiting. The signed display link is issued under Queue > Display in the centre app.`);
    t.count('queueTokens', tokens.length);
  });
}

/**
 * Appointments: past (completed, no-show, cancelled), today, upcoming, one rescheduled.
 *
 * The API only books future slots, as it should. An appointment of a past day
 * (or of today, when today's slot has already gone) is therefore booked through
 * the API on the same weekday of a coming week and then moved back by whole
 * weeks.
 *
 * DIRECT DATABASE ACCESS (documented exception): appointments.startsAt /
 * endsAt / checkedInAt / createdAt / updatedAt of those rows. Status changes
 * still go through the API; a past appointment that was attended passes
 * through "today" so that check-in, start and complete are the real calls.
 */
export async function runAppointments(ctx: SeedContext, t: TenantState): Promise<void> {
  const list = t.fx.appointments ?? [];
  if (!list.length) return;
  const { rt } = ctx;
  const today = localDay(new Date());

  const shiftTo = async (id: string, day: string, extra: Record<string, Date> = {}) => {
    const row = await rt.sys.appointment.findUniqueOrThrow({ where: { id } });
    const delta = new Date(`${day}T00:00:00Z`).getTime() - new Date(`${localDay(row.startsAt)}T00:00:00Z`).getTime();
    await rt.sys.appointment.update({ where: { id }, data: { startsAt: new Date(row.startsAt.getTime() + delta), endsAt: new Date(row.endsAt.getTime() + delta), ...extra } });
    ctx.noteDirectDb('appointments: startsAt / endsAt / checkedInAt / createdAt of past and same-day appointments (the API only books future slots; they are booked for a coming week and moved back by whole weeks).');
  };

  /**
   * The free slot of that branch closest to the wanted time, on the wanted day or - when the branch is
   * closed or fully booked that day (the fixtures are relative to "today", so a wanted day can fall on a
   * weekend) - on the next day with a free slot, up to a week later.
   */
  const slotFor = async (a: AppointmentFx, day: string, time: string): Promise<string> => {
    const branch = t.branch(a.branch);
    for (let offset = 0; offset < 7; offset++) {
      const date = addDays(day, offset);
      const availability = await rt.as(t.receptionist(a.branch)).get('/appointments/availability', { query: { branchId: branch.id, date, ...(a.service ? { serviceId: t.service(a.service).id } : {}) } });
      const free = (availability.slots as any[]).filter((s) => s.available);
      if (free.length) return free.reduce((best, s) => (Math.abs(minutes(s.localStart) - minutes(time)) < Math.abs(minutes(best.localStart) - minutes(time)) ? s : best)).startsAt;
    }
    throw new Error(`${a.ref}: no free appointment slot at ${branch.name} in the week from ${day}.`);
  };

  const book = async (a: AppointmentFx, day: string, time: string): Promise<any> => {
    const branch = t.branch(a.branch);
    const common = { branchId: branch.id, startsAt: await slotFor(a, day, time), ...(a.service ? { serviceId: t.service(a.service).id } : {}), ...(a.notes ? { notes: a.notes } : {}) };
    if (a.via === 'PORTAL') {
      const portal = t.customer(a.customer!).portal;
      if (!portal) throw new Error(`${a.ref}: customer ${a.customer} has no portal account to book online with.`);
      return rt.as(portal).post('/me/appointments', common);
    }
    return rt.as(t.receptionist(a.branch)).post('/appointments', {
      ...common,
      ...(a.customer ? { customerId: t.customer(a.customer).id } : { guestName: a.guest!.name, guestPhone: ctx.fixtures.identity.phone(ctx.nextIdentity()) }),
      // A named staff member is only booked when their weekly schedule covers the slot.
      ...(a.staff && onDuty(a.staff, day, common.startsAt) ? { staffId: t.actor(a.staff).membershipId } : {}),
    });
  };
  const onDuty = (staffKey: string, day: string, startsAt: string): boolean => {
    const fx = t.fx.staff.find((s) => s.key === staffKey);
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    const local = new Date(new Date(startsAt).getTime() + TZ_MS).toISOString().slice(11, 16);
    return !!fx?.shifts?.some((sh) => (sh.days as number[]).includes(weekday) && sh.start <= local && minutes(local) + 30 <= minutes(sh.end));
  };

  await step(`${t.fx.name}: ${list.length} appointments (past, today, upcoming)`, async () => {
    const outcomes: Record<string, number> = {};
    for (const a of [...list].sort((x, y) => x.day - y.day)) {
      const desk = rt.as(t.receptionist(a.branch));
      const target = addDays(today, a.day);
      // Same weekday, first week that is still ahead.
      let bookDay = target;
      while (bookDay <= today) bookDay = addDays(bookDay, 7);
      const created = await book(a, bookDay, a.time);
      const id: string = created.id;
      const bookedAgo = Math.max(0.2, -a.day + 1 + (t.rng(`appointment:${a.ref}`).int(0, 3)));
      const createdAt = ctx.timeline.clamp(daysAgo(bookedAgo));
      let result: string = a.outcome;

      if (a.outcome === 'RESCHEDULED') {
        // A new appointment is created for the new time; the original one becomes RESCHEDULED.
        await desk.post(`/appointments/${id}/reschedule`, { startsAt: await slotFor(a, addDays(today, a.movedTo!.day), a.movedTo!.time), reason: a.cancelReason ?? 'Rescheduled (demo).' });
        await rt.sys.appointment.update({ where: { id }, data: { createdAt } });
        outcomes.RESCHEDULED = (outcomes.RESCHEDULED ?? 0) + 1;
        outcomes.BOOKED = (outcomes.BOOKED ?? 0) + 1;
        t.count('appointments', 2);
        continue;
      }

      if (bookDay !== target) {
        if (a.outcome === 'COMPLETED' || a.outcome === 'AUTO') await shiftTo(id, today, { createdAt });
        else await shiftTo(id, target, { createdAt });
      } else {
        await rt.sys.appointment.update({ where: { id }, data: { createdAt } });
      }
      const row = await rt.sys.appointment.findUniqueOrThrow({ where: { id } });

      if (a.outcome === 'COMPLETED') {
        await desk.post(`/appointments/${id}/confirm`);
        await desk.post(`/appointments/${id}/check-in`, { issueToken: false });
        await desk.post(`/appointments/${id}/start`);
        await desk.post(`/appointments/${id}/complete`);
        if (target !== today) await shiftTo(id, target);
        const after = await rt.sys.appointment.findUniqueOrThrow({ where: { id } });
        await rt.sys.appointment.update({ where: { id }, data: { checkedInAt: new Date(after.startsAt.getTime() - 5 * 60_000), updatedAt: after.endsAt } });
      } else if (a.outcome === 'NO_SHOW') {
        await desk.post(`/appointments/${id}/no-show`);
      } else if (a.outcome === 'CANCELLED') {
        await desk.post(`/appointments/${id}/cancel`, { reason: a.cancelReason ?? 'Cancelled (demo).' });
      } else if (a.outcome === 'CONFIRMED') {
        await desk.post(`/appointments/${id}/confirm`);
      } else if (a.outcome === 'AUTO') {
        // Today: what happened so far depends on the time of day the seed runs.
        const minutesAway = (row.startsAt.getTime() - Date.now()) / 60_000;
        if (minutesAway <= -75) {
          await desk.post(`/appointments/${id}/confirm`);
          await desk.post(`/appointments/${id}/check-in`, { issueToken: false });
          await desk.post(`/appointments/${id}/start`);
          await desk.post(`/appointments/${id}/complete`);
          await rt.sys.appointment.update({ where: { id }, data: { checkedInAt: new Date(row.startsAt.getTime() - 5 * 60_000) } });
          result = 'COMPLETED';
        } else if (minutesAway <= 20) {
          await desk.post(`/appointments/${id}/check-in`, { issueToken: true });
          result = 'CHECKED_IN';
        } else {
          await desk.post(`/appointments/${id}/confirm`);
          result = 'CONFIRMED';
        }
      }
      outcomes[result] = (outcomes[result] ?? 0) + 1;
      t.count('appointments');
    }
    return outcomes;
  }, (o) => Object.entries(o).map(([k, n]) => `${n} ${k}`).join(', '));
}

/** Tasks staff give each other, besides the ones the workflow creates. */
export async function runTasks(ctx: SeedContext, t: TenantState): Promise<void> {
  const list = t.fx.tasks ?? [];
  if (!list.length) return;
  const { rt } = ctx;
  await step(`${t.fx.name}: ${list.length} manual tasks`, async () => {
    for (const k of list as TaskFx[]) {
      const creator = t.actor(k.by);
      const pin = ctx.timeline.begin(ctx.timeline.office(daysAgo(k.createdDaysAgo)));
      const request = k.request ? t.request(k.request) : null;
      const task = await rt.as(creator).post('/tasks', {
        title: k.title,
        description: k.description ?? null,
        type: k.type,
        priority: k.priority,
        ...(request ? { requestId: request.id } : k.branch ? { branchId: t.branch(k.branch).id } : {}),
        ...(k.customer ? { customerId: t.customer(k.customer).id } : {}),
        ...(k.dueInDays !== undefined ? { dueAt: new Date(Date.now() + k.dueInDays * DAY).toISOString() } : {}),
        assigneeIds: (k.assignees ?? []).map((key) => t.actor(key).membershipId),
        ...(k.roleKey ? { roleKey: k.roleKey } : {}),
      });
      pin(task.id);
      t.count('tasks');
      if (k.state === 'OPEN') continue;
      const worker = k.assignees?.length ? t.actor(k.assignees[0]) : creator;
      // The work happened some time after the task was created.
      ctx.timeline.mark(task.id, ctx.timeline.office(daysAgo(Math.max(0.05, k.createdDaysAgo - Math.min(2, k.createdDaysAgo / 2)))));
      if (k.state === 'CANCELLED') {
        await rt.as(creator).post(`/tasks/${task.id}/status`, { status: 'CANCELLED', reason: 'No longer needed. (demo)' });
        continue;
      }
      await rt.as(worker).post(`/tasks/${task.id}/status`, { status: 'IN_PROGRESS' });
      if (k.state === 'DONE') await rt.as(worker).post(`/tasks/${task.id}/status`, { status: 'DONE' });
    }
  });
}
