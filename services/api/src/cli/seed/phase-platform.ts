import { hashPassword } from '../../modules/auth/auth.service';
import { BillingClock } from '../../modules/subscriptions/billing-clock';
import { LIFECYCLE_JOB } from '../../modules/subscriptions/lifecycle.service';
import type { Actor } from './runtime';
import { ApiError, DAY, daysAgo, need, step } from './runtime';
import { SeedContext, TenantState } from './state';

/**
 * Platform staff and platform-level sample records.
 *
 * DIRECT DATABASE ACCESS (documented exception): the first platform
 * administrator is inserted with the system connection - the API deliberately
 * has no way to create one from the outside. Everybody else is added by that
 * administrator through the platform console API (POST /platform/staff) and
 * chooses a password with the invitation link, like a real colleague would.
 * Only an installation without the platform module has no such endpoint; there
 * the support agent is inserted directly as well.
 */
export async function createPlatformStaff(ctx: SeedContext): Promise<void> {
  const { rt, fixtures } = ctx;
  const viaApi = rt.hasModule('PlatformModule');
  await step(`Platform administrator${viaApi ? '; support agent invited through the platform console and activated' : ' and support agent'}`, async () => {
    const passwordHash = await hashPassword(rt.password);
    const { admin, support } = fixtures.platform;
    await rt.sys.user.create({ data: { email: admin.email, fullName: admin.fullName, passwordHash, emailVerifiedAt: new Date(), passwordChangedAt: new Date(), platformRole: 'SUPER_ADMIN' } });
    ctx.platformAdmin = await rt.login(admin.email, 'platform', undefined, 'platform admin');
    if (viaApi) {
      const invited = await rt.as(ctx.platformAdmin).post('/platform/staff', { email: support.email, fullName: support.fullName, role: 'SUPPORT_AGENT' });
      const token = need(invited.dev?.passwordResetToken as string | undefined, 'the invitation token of the support agent (EXPOSE_DEV_TOKENS)');
      await rt.anonymous().post('/auth/password/reset', { token, password: rt.password });
      ctx.noteDirectDb('users: the platform administrator is inserted directly (the API has no endpoint that creates the first platform administrator). The support agent was invited by that administrator through the API.');
    } else {
      await rt.sys.user.create({ data: { email: support.email, fullName: support.fullName, passwordHash, emailVerifiedAt: new Date(), passwordChangedAt: new Date(), platformRole: 'SUPPORT_AGENT' } });
      ctx.noteDirectDb('users: the platform administrator and the platform support agent are inserted directly (this installation runs without the platform module, so no endpoint creates platform staff).');
    }
    ctx.platformSupport = await rt.login(support.email, 'platform', undefined, 'platform support');
    ctx.credentials.push(
      { tenant: 'TypEase platform', app: 'Platform console', role: 'Platform super admin', name: admin.fullName, email: admin.email },
      { tenant: 'TypEase platform', app: 'Platform console', role: 'Platform support agent', name: support.fullName, email: support.email },
    );
  });

  await step('Platform records (coupon, incident register, vendor register)', async () => {
    const admin = rt.as(ctx.platformAdmin);
    const c = fixtures.platform.coupon;
    if (c) await admin.post('/platform/coupons', { code: c.code, description: c.description, percentOff: c.percentOff, durationMonths: c.durationMonths });
    const i = fixtures.platform.incident;
    if (i) {
      const incident = await admin.post('/platform/privacy/incidents', { title: i.title, description: i.description, severity: i.severity, personalDataInvolved: false, detectedAt: daysAgo(18).toISOString() });
      await admin.post(`/platform/privacy/incidents/${incident.id}/status`, { status: 'INVESTIGATING' });
      await admin.post(`/platform/privacy/incidents/${incident.id}/status`, { status: 'CONTAINED' });
      await admin.post(`/platform/privacy/incidents/${incident.id}/status`, { status: 'RESOLVED', resolutionNotes: 'Demo entry: queue backlog cleared; no data was affected.' });
    }
    for (const p of fixtures.platform.processors ?? []) {
      const row = await admin.post('/platform/privacy/processors', { name: p.name, purpose: p.purpose, dataCategories: p.dataCategories, country: p.country, ...(p.safeguards ? { safeguards: p.safeguards } : {}) });
      // One vendor is reviewed, the other stays "pending review" so both states are visible.
      if (p.safeguards) await admin.post(`/platform/privacy/processors/${row.id}/review`, { decision: 'APPROVED', safeguards: p.safeguards });
    }
  });
}

/**
 * SaaS billing history. The subscriptions module reads the time from its
 * BillingClock ("so that a support engineer can replay an incident in a
 * sandbox"); the seed moves that clock from the day the oldest centre started
 * its trial up to today, one day at a time, and lets the real lifecycle job,
 * the real checkout and the real webhook do everything else:
 *
 *   trial -> first invoice -> payment (test gateway, or recorded by TypEase
 *   billing staff) -> active -> renewal invoice a week before the period ends
 *   -> payment -> next period ...
 *
 * `onStartDay` runs for each centre on the day its trial starts (it chooses
 * the plan and finishes onboarding).
 */
export async function replayBillingHistory(ctx: SeedContext, onStartDay: (t: TenantState) => Promise<void>): Promise<void> {
  const { rt } = ctx;
  const clock = rt.get(BillingClock);
  const horizon = Math.max(...ctx.tenants.map((t) => Math.ceil(t.fx.trialStartedDaysAgo)));
  const startOf = (t: TenantState) => Math.ceil(t.fx.trialStartedDaysAgo);
  const paid: Record<string, number> = {};
  try {
    for (let d = horizon; d >= 0; d--) {
      // 10:00 UTC = 14:00 in the UAE: a plausible time of day for every billing event.
      const at = new Date(Math.min(Date.now() - 60_000, Math.floor((Date.now() - d * DAY) / DAY) * DAY + 10 * 3_600_000));
      clock.set(at);
      for (const t of ctx.tenants) if (t.subscriptionId) ctx.timeline.mark(t.subscriptionId, at);
      for (const t of ctx.tenants.filter((x) => startOf(x) === d)) {
        await onStartDay(t);
        const sub = await rt.as(t.owner).get('/subscription');
        t.subscriptionId = sub.subscription.id;
        ctx.timeline.mark(sub.subscription.id, at);
      }
      const active = ctx.tenants.filter((t) => t.subscriptionId);
      if (!active.length) continue;
      await rt.jobs.runScheduled(LIFECYCLE_JOB);
      for (const t of active) {
        const state = await rt.as(t.owner).get('/subscription');
        for (const invoice of state.openInvoices ?? []) {
          paid[t.slug] = (paid[t.slug] ?? 0) + 1;
          if (paid[t.slug] === 1 && t.fx.firstInvoice === 'OFFLINE') {
            await rt.as(ctx.platformAdmin).post(`/platform/billing/invoices/${invoice.id}/pay-offline`, { method: 'BANK_TRANSFER', reference: ctx.nextReference('TRF'), paidAt: at.toISOString() });
          } else {
            const checkout = await rt.as(t.owner).post(`/subscription/invoices/${invoice.id}/pay`);
            const done = await rt.anonymous().post(`${checkout.checkoutUrl}/complete`);
            if (!done.webhook?.delivered) throw new Error(`The test gateway could not deliver the webhook for ${invoice.number}: ${JSON.stringify(done.webhook)}`);
          }
        }
      }
      await rt.settle();
    }
  } finally {
    clock.reset();
  }
  await rt.runScheduled(LIFECYCLE_JOB);
  for (const t of ctx.tenants) t.counts.subscriptionInvoicesPaid = paid[t.slug] ?? 0;
}

/**
 * Time-limited support access: TypEase staff hold no permission inside a centre. The support agent asks,
 * the owner decides, and the access ends by itself or when the owner ends it. One request is used and
 * revoked (with the proof that the same token stops working), one waits for the owner, one is denied.
 */
export async function runSupportAccess(ctx: SeedContext): Promise<void> {
  const { rt, fixtures } = ctx;
  const list = fixtures.platform.supportAccess ?? [];
  if (!list.length || !rt.hasModule('PlatformModule')) return;
  await step(`Support access: ${list.length} request(s) from TypEase support to the centres`, async () => {
    const agent = rt.as(ctx.platformSupport);
    const outcomes: string[] = [];
    for (const a of list) {
      const t = need(ctx.tenants.find((x) => x.slug === a.centre), `centre "${a.centre}" for a support access request`);
      const owner = rt.as(t.owner);
      const grant = await agent.post(`/platform/tenants/${t.id}/access-grants`, { reason: a.reason, scopes: a.scopes, durationMinutes: a.durationMinutes });
      if (a.outcome === 'PENDING') {
        outcomes.push(`${t.slug}: waiting for the owner`);
        continue;
      }
      if (a.outcome === 'DENIED') {
        await owner.post(`/support-access/${grant.id}/deny`, { note: a.decisionNote });
        outcomes.push(`${t.slug}: denied`);
        continue;
      }
      const approvedScopes = a.approvedScopes ?? a.scopes;
      await owner.post(`/support-access/${grant.id}/approve`, { note: a.decisionNote, scopes: approvedScopes, durationMinutes: a.approvedMinutes ?? a.durationMinutes });
      const entered = await agent.post(`/platform/access-grants/${grant.id}/enter`);
      const inside: Actor = { ...ctx.platformSupport, label: `platform support inside ${t.slug}`, app: 'centre', tenantSlug: t.slug, token: entered.accessToken, membershipId: null, roleKey: null };
      const session = rt.as(inside);
      // What was approved works ...
      const customers = await session.get('/customers', { query: { pageSize: 5 } });
      // ... what was not approved does not (documents need the explicit document.read scope), and nothing can be changed.
      const noDocuments = await session.expectRefusal('GET', '/documents', undefined, { status: 403 });
      const noWriting = await session.expectRefusal('POST', '/customer-tags', { name: 'Support was here', color: '#000000' }, { status: 403 });
      // The owner ends the access early: the very same token is refused on the next request.
      await owner.post(`/support-access/${grant.id}/revoke`, { note: 'Thank you, the question is answered. (demo)' });
      let after: ApiError | null = null;
      try {
        await session.get('/customers', { query: { pageSize: 1 } });
      } catch (e) {
        if (!(e instanceof ApiError) || ![401, 403].includes(e.status)) throw e;
        after = e;
      }
      if (!after) throw new Error(`${t.slug}: the support session still works after the owner revoked the access.`);
      ctx.highlights.push(
        `Support access (${t.fx.name}): approved for ${approvedScopes.join(', ')} - the agent could list customers (${customers.data.length} rows read), GET /documents -> ${noDocuments.status} ${noDocuments.code}, POST /customer-tags -> ${noWriting.status} ${noWriting.code}; after the owner revoked it the same token -> ${after.status} ${after.code}.`,
      );
      outcomes.push(`${t.slug}: approved, used, revoked by the owner`);
    }
    return outcomes;
  }, (o) => o.join('; '));
}
