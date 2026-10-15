import { BillingClock } from '../../services/api/src/modules/subscriptions/billing-clock';
import { TenantResolver } from '../../services/api/src/modules/tenancy/tenant-resolver.service';
import { Actor, aed, anonymous, api, Centre, expectRefused, fils, finishCheckout, inviteStaff, pathOf, png, ratio, registerPortalCustomer, runScheduledJob, signUpCentre, TestApp, uniq } from '../support';

/**
 * Scenarios 21-23: one centre grows out of its plan.
 *
 * It signs up on the Starter plan, pays its first invoice when the trial ends,
 * upgrades to Business (prorated invoice, paid through the hosted checkout),
 * switches on its own brand, and puts its customer portal on its own domain.
 *
 * Time: SaaS billing reads the time from its injectable BillingClock (made for
 * exactly this); the test moves that clock instead of waiting 14 days. DNS: the
 * API's test harness replaces the DNS lookup with a table the test fills -
 * no real DNS query is made, and no real certificate is issued. The age of a
 * domain claim is set in the database (72 hours cannot be waited for).
 */
describe('Subscription, white label and custom domain (scenarios 21-23)', () => {
  let t: TestApp;
  let clock: BillingClock;
  let centre: Centre;
  let manager: Actor;
  let platformAdmin: Actor;
  let prices: Record<string, { monthly: bigint; features: Record<string, boolean>; limits: Record<string, number> }>;
  const id = uniq();
  const DAY = 86_400_000;
  const domain = `portal-${id}.example.ae`;

  const subscription = () => api(t, centre.owner).get('/subscription');
  const publicConfig = (query: string) => anonymous(t).req('GET', `/public/tenant-config?${query}`);
  /** Pay a subscription invoice on the platform's hosted (test) checkout. */
  async function payInvoice(invoiceId: string) {
    const checkout = await api(t, centre.owner).post(`/subscription/invoices/${invoiceId}/pay`, {}, 201);
    const done = await finishCheckout(t, checkout);
    expect(done.webhook).toMatchObject({ delivered: true, status: 200 });
    await t.settle();
    return checkout;
  }

  beforeAll(async () => {
    t = await TestApp.create();
    clock = t.get(BillingClock);
    platformAdmin = await t.createPlatformAdmin('SUPER_ADMIN');
    // Plans are data: read the prices and features the same way the pricing page does.
    const plans: any[] = await anonymous(t).get('/public/plans');
    prices = Object.fromEntries(plans.map((p) => [p.key, { monthly: fils(p.monthlyPrice), features: p.features, limits: p.limits }]));
    centre = await signUpCentre(t, { plan: 'starter', name: `Growing Centre ${id}` });
    manager = await inviteStaff(t, centre, 'manager');
    await t.settle();
  });
  afterAll(async () => {
    clock?.reset();
    await t.close();
  });

  it('S21 subscription is upgraded', async () => {
    const o = api(t, centre.owner);
    expect(prices.starter.features.whiteLabel).toBe(false);
    expect(prices.business.features).toMatchObject({ whiteLabel: true, customDomains: true });

    // --- on Starter: the plan's limits are enforced by the API, with a message about the plan
    const trial = await subscription();
    expect(trial).toMatchObject({ tenantStatus: 'TRIAL', plan: { key: 'starter' }, subscription: { status: 'TRIALING' }, openInvoices: [] });
    expectRefused(await o.req('PUT', '/branding', { mode: 'WHITE_LABEL', primaryColor: '#7A1F5C' }), 402, 'PLAN_LIMIT_REACHED');
    expectRefused(await o.req('POST', '/domains', { domain }), 402, 'PLAN_LIMIT_REACHED');
    expectRefused(await o.req('POST', '/branches', { code: 'B2', name: 'Second branch' }), 402, 'PLAN_LIMIT_REACHED');
    // Only the owner manages the subscription.
    expectRefused(await api(t, manager).req('GET', '/subscription'), 403);
    expectRefused(await api(t, manager).req('POST', '/subscription/change-plan', { planKey: 'business' }), 403);

    // --- the trial ends: the hourly billing job issues the first invoice; the owner pays it
    clock.set(new Date(new Date(trial.subscription.trialEndsAt).getTime() + 3_600_000));
    await runScheduledJob(t, 'subscriptions.lifecycle');
    const due = await subscription();
    expect(due.subscription.status).toBe('PAST_DUE');
    expect(due.openInvoices).toHaveLength(1);
    expect(due.openInvoices[0]).toMatchObject({ reason: 'FIRST_PERIOD', total: aed(prices.starter.monthly), currency: 'AED' });
    await o.get('/branches'); // the centre keeps working while the invoice is open
    const firstInvoiceId = due.openInvoices[0].id;
    await payInvoice(firstInvoiceId);
    const active = await subscription();
    expect(active).toMatchObject({ tenantStatus: 'ACTIVE', plan: { key: 'starter' }, subscription: { status: 'ACTIVE', billingCycle: 'MONTHLY' }, openInvoices: [] });

    // --- ten days into the paid period the owner upgrades to Business
    const start = new Date(active.subscription.currentPeriodStart).getTime();
    const end = new Date(active.subscription.currentPeriodEnd).getTime();
    const now = start + 10 * DAY;
    clock.set(new Date(now));
    // Expected, computed here: the price difference for the part of the period that is left, rounded half-up.
    const expected = ratio(prices.business.monthly - prices.starter.monthly, BigInt(end - now), BigInt(end - start));
    expect(expected > 0n && expected < prices.business.monthly - prices.starter.monthly).toBe(true);

    const change = await o.post('/subscription/change-plan', { planKey: 'business' }, [200, 201]);
    expect(change.change).toMatchObject({ kind: 'UPGRADE', effective: 'AFTER_PAYMENT', amount: aed(expected) });
    expect(change.plan.key).toBe('starter'); // nothing unlocks before the money arrives
    expect(change.pendingChange).toMatchObject({ plan: { key: 'business' }, effective: 'AFTER_PAYMENT' });
    expect(change.openInvoices).toHaveLength(1);
    expect(change.openInvoices[0]).toMatchObject({ reason: 'UPGRADE', total: aed(expected) });
    expectRefused(await o.req('PUT', '/branding', { mode: 'WHITE_LABEL', primaryColor: '#7A1F5C' }), 402, 'PLAN_LIMIT_REACHED');

    // --- paying the upgrade invoice switches the plan; the billing period does not move
    const upgradeInvoiceId = change.openInvoices[0].id;
    await payInvoice(upgradeInvoiceId);
    const upgraded = await subscription();
    expect(upgraded).toMatchObject({ tenantStatus: 'ACTIVE', plan: { key: 'business' }, pendingChange: null, openInvoices: [], subscription: { status: 'ACTIVE', currentPeriodEnd: active.subscription.currentPeriodEnd } });
    expect(upgraded.usage.find((u: any) => u.metric === 'branches')).toMatchObject({ used: 1, limit: prices.business.limits.branches });
    // What was refused an hour ago works now.
    await o.post('/branches', { code: 'B2', name: 'Second branch' }, 201);
    // Paying the same invoice again is not possible.
    expectRefused(await o.req('POST', `/subscription/invoices/${upgradeInvoiceId}/pay`), 409, 'INVOICE_NOT_PAYABLE');

    // --- the billing history is complete and belongs to SaaS billing, not to the centre's own books
    const invoices = await o.get('/subscription/invoices?pageSize=50');
    const paid = invoices.data.filter((i: any) => i.status === 'PAID');
    expect(paid.map((i: any) => [i.reason, i.total]).sort()).toEqual([['FIRST_PERIOD', aed(prices.starter.monthly)], ['UPGRADE', aed(expected)]].sort());
    expect(invoices.data.every((i: any) => i.status !== 'OPEN')).toBe(true);
    const pdfFile = await o.download(`/subscription/invoices/${upgradeInvoiceId}/pdf`);
    expect(pdfFile.body.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await o.get('/payments')).meta.total).toBe(0);
    expect((await o.get('/invoices')).meta.total).toBe(0);
    // TypEase billing staff see the same subscription.
    const billing = await api(t, platformAdmin).get(`/platform/tenants/${centre.id}`);
    expect(billing.subscription).toMatchObject({ status: 'ACTIVE', plan: { key: 'business' } });
    // Going back to a plan the centre has outgrown (two branches, Starter allows one) is refused.
    expectRefused(await o.req('POST', '/subscription/change-plan', { planKey: 'starter' }), 422, 'DOWNGRADE_BLOCKED_BY_USAGE');
    clock.reset();
  });

  it('S22 white-label theme is changed', async () => {
    const o = api(t, centre.owner);
    // Before: TypEase presentation, although the plan now allows the centre's own.
    const before = (await publicConfig(`slug=${centre.slug}`)).body;
    expect(before).toMatchObject({ tenantId: centre.id, mode: 'TYPEASE', logoUrl: null });
    const typeaseColors = before.colors;

    // Invalid input is refused and changes nothing; branding is not the manager's to change.
    expectRefused(await o.req('PUT', '/branding', { mode: 'WHITE_LABEL', primaryColor: 'purple' }), 400);
    expectRefused(await api(t, manager).req('PUT', '/branding', { mode: 'WHITE_LABEL', primaryColor: '#7A1F5C' }), 403);
    expect((await publicConfig(`slug=${centre.slug}`)).body.mode).toBe('TYPEASE');

    const theme = { mode: 'WHITE_LABEL', businessName: 'Al Noor Documents', primaryColor: '#7A1F5C', accentColor: '#F59E0B', websiteTitle: 'Al Noor - documents made simple', tagline: 'Your papers, done right.', supportEmail: `help-${id}@alnoor.example` };
    await o.put('/branding', theme);
    const logo = png('logo.png', 900);
    const uploaded = await api(t, centre.owner).upload('/branding/logo', 'file', logo);
    expect([200, 201]).toContain(uploaded.status);

    // After: what the customer portal and the mobile app read before anybody signs in.
    const after = (await publicConfig(`slug=${centre.slug}`)).body;
    expect(after).toMatchObject({
      tenantId: centre.id,
      mode: 'WHITE_LABEL',
      name: 'Al Noor Documents',
      websiteTitle: theme.websiteTitle,
      tagline: theme.tagline,
      supportEmail: theme.supportEmail,
      colors: { primary: '#7A1F5C', accent: '#F59E0B', secondary: typeaseColors.secondary }, // a colour that was not chosen keeps the default
    });
    // The logo is served publicly (it is on the login page), and it is the file that was uploaded.
    expect(after.logoUrl).toBeTruthy();
    const served = await t.http.get(pathOf(after.logoUrl)).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(served.status).toBe(200);
    expect(served.headers['content-type']).toContain('image/png');
    expect((served.body as Buffer).equals(logo.content)).toBe(true);

    // The owner's settings page shows what was saved; the change is audited.
    const settings = await o.get('/branding');
    expect(JSON.stringify(settings)).toContain('#7A1F5C');
    const audit = await o.get('/audit-logs?pageSize=100');
    expect(audit.data.some((e: any) => /^branding\./.test(e.action))).toBe(true);

    // The brand also reaches what is sent in the centre's name: a customer who registers now is written to by "Al Noor Documents".
    const customer = await registerPortalCustomer(t, centre, { fullName: 'Brand Witness', email: `witness-${id}@example.test` });
    await t.settle();
    const log = await o.get(`/notifications?customerId=${customer.customerId}&pageSize=50`);
    expect(log.data.length).toBeGreaterThanOrEqual(1);
    const preview = await o.post('/notifications/templates/preview', { eventKey: 'request.completed', channel: 'EMAIL', language: 'en' }, [200, 201]);
    expect(preview.html).toContain('Al Noor Documents');
    expect(preview.html).toContain('#7A1F5C');

    // Another centre is untouched by this centre's theme.
    const other = await signUpCentre(t, { plan: 'business' });
    expect((await publicConfig(`slug=${other.slug}`)).body).toMatchObject({ mode: 'TYPEASE', colors: typeaseColors });
    // Switching back to the TypEase presentation is one setting; the chosen colours are kept for later.
    await o.put('/branding', { mode: 'TYPEASE' });
    expect((await publicConfig(`slug=${centre.slug}`)).body).toMatchObject({ mode: 'TYPEASE', colors: typeaseColors, logoUrl: null });
    await o.put('/branding', { mode: 'WHITE_LABEL' });
    expect((await publicConfig(`slug=${centre.slug}`)).body).toMatchObject({ mode: 'WHITE_LABEL', colors: { primary: '#7A1F5C' } });
  });

  it('S23 custom-domain configuration is validated', async () => {
    const o = api(t, centre.owner);
    const rival = await signUpCentre(t, { plan: 'business' });
    const corsOrigin = async () => (await t.http.get('/api/v1/public/plans').set('Origin', `https://${domain}`)).headers['access-control-allow-origin'];

    // Nonsense is refused before anything is stored; domains are the owner's business.
    for (const bad of ['not a domain', 'localhost', 'http://portal.example.ae', '192.168.1.10']) expectRefused(await o.req('POST', '/domains', { domain: bad }), 400);
    expectRefused(await api(t, manager).req('POST', '/domains', { domain }), 403);
    expectRefused(await o.req('POST', '/domains', { domain: `${rival.slug}.typease.test` }), 400, 'DOMAIN_NOT_ALLOWED'); // TypEase's own hosts cannot be claimed

    // --- the owner adds the domain: it is PENDING and the answer says which DNS record to create
    const added = await o.post('/domains', { domain }, 201);
    expect(added).toMatchObject({ domain, status: 'PENDING', app: 'customer' });
    expect(added.dns.txt.name).toBe(`_typease-verify.${domain}`);
    expect(added.dns.txt.value).toBeTruthy();

    // Until ownership is proven the domain is not routed: no certificate, no portal, no browser access.
    expectRefused(await anonymous(t).req('GET', `/internal/tls/ask?domain=${domain}`), 404);
    expectRefused(await publicConfig(`host=${domain}`), 404);
    expect(await corsOrigin()).toBeUndefined();

    // --- verification: no record, then a wrong record, then the right one
    const none = await o.post(`/domains/${added.id}/verify`, {}, [200, 201]);
    expect(none.verified).toBe(false);
    expect(none.status).not.toBe('VERIFIED');
    expect(JSON.stringify(none)).toContain(`_typease-verify.${domain}`); // the answer says which record is missing
    t.dns.records.set(`_typease-verify.${domain}`, ['typease-verify=somebody-elses-token', 'v=spf1 -all']);
    expect((await o.post(`/domains/${added.id}/verify`, {}, [200, 201])).verified).toBe(false);
    expectRefused(await publicConfig(`host=${domain}`), 404);

    // While it is pending, another centre cannot take the same domain, nor verify or remove this claim.
    expectRefused(await api(t, rival.owner).req('POST', '/domains', { domain }), 409);
    expectRefused(await api(t, rival.owner).req('POST', `/domains/${added.id}/verify`), 404);
    expectRefused(await api(t, rival.owner).req('DELETE', `/domains/${added.id}`), 404);

    t.dns.records.set(`_typease-verify.${domain}`, ['v=spf1 -all', added.dns.txt.value]);
    const verified = await o.post(`/domains/${added.id}/verify`, {}, [200, 201]);
    expect(verified).toMatchObject({ verified: true, status: 'VERIFIED' });

    // --- from now on the domain IS this centre's customer portal
    await anonymous(t).get(`/internal/tls/ask?domain=${domain}`, 200); // the reverse proxy may request a certificate
    const config = (await publicConfig(`host=${domain}`)).body;
    expect(config).toMatchObject({ tenantId: centre.id, slug: centre.slug, mode: 'WHITE_LABEL', name: 'Al Noor Documents' });
    // A browser on that domain needs no slug: the host header of the portal identifies the centre.
    const byHost = await anonymous(t).with({ 'x-tenant-host': domain }).get('/public/tenant-config');
    expect(byHost.tenantId).toBe(centre.id);
    expect(await corsOrigin()).toBe(`https://${domain}`);
    const listed = await o.get('/domains');
    const rows: any[] = Array.isArray(listed) ? listed : (listed.domains ?? listed.data);
    expect(rows.find((d) => d.id === added.id)).toMatchObject({ status: 'VERIFIED' });
    expect((await api(t, platformAdmin).get(`/platform/tenants/${centre.id}`)).domains.map((d: any) => [d.domain, d.status])).toEqual([[domain, 'VERIFIED']]);

    // A verified domain stays exclusive, a look-alike host resolves nothing, and unknown hosts get no certificate.
    expectRefused(await api(t, rival.owner).req('POST', '/domains', { domain }), 409);
    expectRefused(await publicConfig(`host=evil-${domain}`), 404);
    expectRefused(await anonymous(t).req('GET', '/internal/tls/ask?domain=evil.example.com'), 404);
    // The platform subdomain of the centre keeps working next to its own domain.
    await anonymous(t).get(`/internal/tls/ask?domain=${centre.slug}.typease.test`, 200);

    // --- removing the domain takes it out of routing again
    await o.delete(`/domains/${added.id}`, [200, 204]);
    expectRefused(await publicConfig(`host=${domain}`), 404);
    expectRefused(await anonymous(t).req('GET', `/internal/tls/ask?domain=${domain}`), 404);
    expect(await corsOrigin()).toBeUndefined();
  });

  it('S23 an unverified claim does not block a domain for ever, and a verified domain follows the plan', async () => {
    const o = api(t, centre.owner);
    const rival = await signUpCentre(t, { plan: 'business' });
    const r = api(t, rival.owner);
    const listOf = async (who: typeof o) => ((await who.get('/domains')).domains ?? []) as any[];

    // --- a claim that is never verified: it blocks other centres for 72 hours, not longer
    const squatted = `shop-${id}.example.ae`;
    const claim = await o.post('/domains', { domain: squatted }, 201);
    expect(claim.status).toBe('PENDING');
    expect(new Date(claim.claim.releasableAt).getTime() - new Date(claim.createdAt).getTime()).toBe(72 * 3_600_000);
    expectRefused(await r.req('POST', '/domains', { domain: squatted }), 409, 'DOMAIN_IN_USE');
    // Time travel (database): the claim is 71 hours old - still blocking; then 73 hours old.
    await t.sys.tenantDomain.update({ where: { id: claim.id }, data: { createdAt: new Date(Date.now() - 71 * 3_600_000) } });
    expectRefused(await r.req('POST', '/domains', { domain: squatted }), 409, 'DOMAIN_IN_USE');
    await t.sys.tenantDomain.update({ where: { id: claim.id }, data: { createdAt: new Date(Date.now() - 73 * 3_600_000) } });
    const taken = await r.post('/domains', { domain: squatted }, 201);
    expect(taken).toMatchObject({ domain: squatted, status: 'PENDING', tenantId: rival.id });
    // The new claim has a verification token of its own: the first centre's DNS record proves nothing for it.
    expect(taken.dns.txt.value).not.toBe(claim.dns.txt.value);
    t.dns.records.set(`_typease-verify.${squatted}`, [claim.dns.txt.value]);
    expect((await r.post(`/domains/${taken.id}/verify`, {}, [200, 201])).verified).toBe(false);
    expectRefused(await publicConfig(`host=${squatted}`), 404);
    // The first centre lost the claim, cannot verify it any more, and finds the release on its audit trail.
    expect((await listOf(o)).map((d) => d.domain)).not.toContain(squatted);
    expectRefused(await o.req('POST', `/domains/${claim.id}/verify`), 404);
    const released = await o.get('/audit-logs?action=domain.claim_released&pageSize=10');
    expect(released.data.length).toBe(1);
    expect(JSON.stringify(await o.get(`/audit-logs/${released.data[0].id}`))).not.toContain(rival.id); // it does not say who took it
    // A VERIFIED domain is never released like that, however old.
    t.dns.records.set(`_typease-verify.${squatted}`, [taken.dns.txt.value]);
    expect((await r.post(`/domains/${taken.id}/verify`, {}, [200, 201])).status).toBe('VERIFIED');
    await t.sys.tenantDomain.update({ where: { id: taken.id }, data: { createdAt: new Date(Date.now() - 400 * 86_400_000) } });
    expectRefused(await o.req('POST', '/domains', { domain: squatted }), 409, 'DOMAIN_IN_USE');
    expect((await publicConfig(`host=${squatted}`)).body.tenantId).toBe(rival.id);

    // --- the plan: custom domains are a feature of Business. TypEase moves the rival centre to Starter.
    const resolver = t.get(TenantResolver);
    const moved = await api(t, platformAdmin).post(`/platform/billing/tenants/${rival.id}/change-plan`, { planKey: 'starter', immediate: true, reason: 'Agreed with the owner by phone (test data)' }, [200, 201]);
    expect(moved.plan?.key ?? moved.subscription?.plan?.key).toBe('starter');
    // (answers about hosts are cached for 30 seconds per API instance; the cache is emptied here instead of waiting)
    resolver.invalidate();
    // The domain no longer leads anywhere: no portal, no certificate, no browser access ...
    expectRefused(await publicConfig(`host=${squatted}`), 404);
    expectRefused(await anonymous(t).req('GET', `/internal/tls/ask?domain=${squatted}`), 404);
    expect((await t.http.get('/api/v1/public/plans').set('Origin', `https://${squatted}`)).headers['access-control-allow-origin']).toBeUndefined();
    // ... the settings page says why, the centre's own address keeps working, and the domain still belongs to it.
    const suspended = await r.get('/domains');
    expect(suspended.customDomainsIncluded).toBe(false);
    expect(suspended.domains.find((d: any) => d.id === taken.id)).toMatchObject({ status: 'SUSPENDED_BY_PLAN', routed: false });
    expect((await publicConfig(`slug=${rival.slug}`)).body.tenantId).toBe(rival.id);
    await anonymous(t).get(`/internal/tls/ask?domain=${rival.slug}.typease.test`, 200);
    expectRefused(await o.req('POST', '/domains', { domain: squatted }), 409, 'DOMAIN_IN_USE');
    expectRefused(await r.req('POST', '/domains', { domain: `second-${id}.example.ae` }), 402, 'PLAN_LIMIT_REACHED');
    // Back on a plan with the feature, the domain answers again - nothing has to be verified again.
    await api(t, platformAdmin).post(`/platform/billing/tenants/${rival.id}/change-plan`, { planKey: 'business', immediate: true, reason: 'Upgrade agreed with the owner (test data)' }, [200, 201]);
    resolver.invalidate();
    expect((await publicConfig(`host=${squatted}`)).body.tenantId).toBe(rival.id);
    expect((await r.get('/domains')).domains.find((d: any) => d.id === taken.id)).toMatchObject({ status: 'VERIFIED', routed: true });
  });
});
