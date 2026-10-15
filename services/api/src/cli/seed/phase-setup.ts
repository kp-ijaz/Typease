import type { StaffFx, Weekday } from './fixture-types';
import { daysAgo, isoDay, step } from './runtime';
import { sampleLogo } from './sample-documents';
import { SeedContext, TenantState } from './state';

const staffEmail = (t: TenantState, s: StaffFx) => `${s.login}@${t.fx.emailDomain}`;

/**
 * Step 1 of a centre's life: the owner signs up on the public page, confirms
 * email and phone, and fills in the business details - exactly as the centre
 * web app does it.
 */
export async function signUp(ctx: SeedContext, t: TenantState): Promise<void> {
  const { rt, fixtures } = ctx;
  const anon = rt.anonymous();
  const owner = t.fx.owner;
  const email = staffEmail(t, owner);
  const phone = fixtures.identity.phone(ctx.nextIdentity());

  await step(`${t.fx.name}: sign-up, email and phone verification, business details`, async () => {
    const created = daysAgo(t.fx.trialStartedDaysAgo + 0.05);
    // Account messages of this centre (verification email, one-time code) belong to the sign-up day.
    const pinCentre = ctx.timeline.begin(created);
    const signup = await anon.post('/public/signup', { businessName: t.fx.name, slug: t.fx.slug, ownerName: owner.fullName, email, phone, password: rt.password, acceptTerms: true });
    const token = signup.dev?.emailVerificationToken;
    if (!token) throw new Error('The sign-up response carries no verification token. The seed needs EXPOSE_DEV_TOKENS=true (never in production).');
    t.id = signup.tenantId;
    pinCentre(t.id);
    await anon.post('/auth/verify-email', { token });
    t.owner = await rt.login(email, 'centre', t.slug, `${t.slug} owner`);
    const otp = await rt.as(t.owner).post('/auth/phone/request-verification', { phone });
    await rt.as(t.owner).post('/auth/phone/verify', { phone, code: otp.dev.otp });
    await rt.as(t.owner).put('/onboarding/business', {
      legalName: t.fx.legalName,
      tradeLicenceNo: fixtures.identity.tradeLicenceNo(ctx.nextIdentity()),
      taxRegistrationNo: `SAMPLE-TRN-${t.fx.slug.toUpperCase().slice(0, 12)}`,
      emirate: t.fx.emirate,
      contactEmail: `info@${t.fx.emailDomain}`,
      contactPhone: phone,
      defaultLanguage: 'en',
    });
    ctx.credentials.push({ tenant: t.fx.name, slug: t.slug, app: 'Centre app', role: 'Centre owner', name: owner.fullName, email });
    ctx.timeline.set('tenants', t.id, { createdAt: created, approvedAt: created });
    ctx.timeline.mark(t.owner.userId, created);
    if (t.owner.membershipId) ctx.timeline.mark(t.owner.membershipId, created);
    ctx.timeline.setupDay(t.id, created);
  });
}

/**
 * The rest of onboarding, run on the (billing-clock) day the trial starts:
 * plan, tax and settings, branding, starter services, branches, completion.
 */
export async function finishOnboarding(ctx: SeedContext, t: TenantState): Promise<void> {
  const { rt } = ctx;
  const owner = rt.as(t.owner);
  await step(`${t.fx.name}: ${t.fx.planKey} plan, settings, branding, starter catalogue, branches, onboarding complete`, async () => {
    const plan = await owner.post('/onboarding/plan', { planKey: t.fx.planKey, billingCycle: 'MONTHLY', ...(t.fx.coupon ? { couponCode: t.fx.coupon } : {}) });
    await owner.patch('/tenant', { taxRatePercent: t.fx.taxRatePercent });
    if (t.fx.settings && Object.keys(t.fx.settings).length) await owner.patch('/tenant/settings', t.fx.settings);

    const b = t.fx.branding;
    if (b) {
      const { whiteLabel, logoText, ...fields } = b;
      await owner.put('/branding', { ...fields, mode: whiteLabel ? 'WHITE_LABEL' : 'TYPEASE', supportEmail: `support@${t.fx.emailDomain}`, publicCatalogueEnabled: true });
      if (whiteLabel && logoText) {
        const logo = sampleLogo(logoText, b.primaryColor ?? '#0B4F6C');
        await owner.upload('/branding/logo', 'file', logo);
      }
    }

    const starter = await owner.post('/services/starter-catalogue');
    t.count('starterServices', starter.createdCount);

    // The provisioned "Main Branch" becomes the head office of the demo centre; further branches are added.
    const existing = await owner.get('/branches');
    const [head, ...others] = t.fx.branches;
    const body = (br: (typeof t.fx.branches)[number], n: number) => ({
      code: br.code,
      name: br.name,
      nameAr: br.nameAr ?? null,
      address: br.address,
      emirate: br.emirate,
      phone: ctx.fixtures.identity.phone(700 + n),
      email: `${br.code.toLowerCase()}@${t.fx.emailDomain}`,
      workingHours: br.hours,
    });
    const main = existing.find((x: any) => x.isHeadOffice) ?? existing[0];
    const updated = await owner.patch(`/branches/${main.id}`, body(head, ctx.nextIdentity()));
    t.branches.set(head.code, { id: updated.id, code: head.code, name: head.name });
    for (const br of others) {
      const row = await owner.post('/branches', { ...body(br, ctx.nextIdentity()), isHeadOffice: false });
      t.branches.set(br.code, { id: row.id, code: br.code, name: br.name });
    }

    const done = await owner.post('/onboarding/complete');
    return { plan, done };
  }, (r) => `subscription ${r.plan.outcome}, centre ${r.done.status}`);
}

/** Staff are invited by the owner and accept the invitation with their own password. */
export async function inviteStaff(ctx: SeedContext, t: TenantState): Promise<void> {
  const { rt } = ctx;
  const owner = rt.as(t.owner);
  if (!t.fx.staff.length) return;
  await step(`${t.fx.name}: ${t.fx.staff.length} staff invited and joined`, async () => {
    for (const s of t.fx.staff) {
      const email = staffEmail(t, s);
      const all = s.branches === 'ALL';
      const joined = daysAgo(s.joinedDaysAgo);
      // The invitation email is dated like the day the colleague joined.
      ctx.timeline.mark(t.id, joined);
      const invite = await owner.post('/staff/invitations', { email, fullName: s.fullName, roleKey: s.roleKey, jobTitle: s.jobTitle, allBranches: all, branchIds: all ? [] : (s.branches as string[]).map((code) => t.branch(code).id) });
      const accepted = await rt.anonymous().post('/auth/invitations/accept', { token: invite.dev.invitationToken, password: rt.password, app: 'centre' });
      if (accepted.status !== 'OK') throw new Error(`Invitation of ${email} ended with ${accepted.status}`);
      const actor = rt.actorFrom(accepted, email, 'centre', t.slug, `${t.slug} ${s.key} (${s.roleKey})`);
      t.staff.set(s.key, actor);
      ctx.credentials.push({ tenant: t.fx.name, slug: t.slug, app: 'Centre app', role: roleLabel(s), name: s.fullName, email, note: all ? undefined : `branch ${(s.branches as string[]).join(', ')} only` });
      ctx.timeline.mark(actor.userId, joined);
      if (actor.membershipId) ctx.timeline.mark(actor.membershipId, joined);
    }
  });
}

function roleLabel(s: StaffFx): string {
  return { owner: 'Centre owner', manager: 'Centre manager', receptionist: 'Receptionist', operator: 'Typing operator', reviewer: 'Document reviewer', accountant: 'Accountant' }[s.roleKey];
}

/** Catalogue, workflow, schedules, tags, calendars: what an owner configures in the first days. */
export async function configureCentre(ctx: SeedContext, t: TenantState): Promise<void> {
  const { rt } = ctx;
  const owner = rt.as(t.owner);

  // A record that only waits for review needs the review queue, i.e. the integrations module.
  if (t.fx.partner && (t.fx.partner.review !== 'PENDING' || rt.hasModule('IntegrationsModule'))) {
    const waiting = t.fx.partner.review === 'PENDING';
    await step(`${t.fx.name}: partner authorisation record ${waiting ? 'submitted (left waiting for the TypEase review)' : 'submitted and verified by TypEase'}`, () => ensurePartnerRecord(ctx, t));
  }

  await step(`${t.fx.name}: service catalogue`, async () => {
    const workflows: any[] = await owner.get('/workflows');
    const categories: any[] = await owner.get('/service-categories');
    let custom = 0;
    for (const s of t.fx.customServices ?? []) {
      if (s.complianceCapability === 'PARTNER_COORDINATION' && !t.partnerRecordId) throw new Error(`${t.slug}: service ${s.code} is a partner-coordination service, but the centre has no verified sample partner.`);
      const category = categories.find((c) => c.key === s.categoryKey);
      if (!category) throw new Error(`${t.slug}: service ${s.code} refers to category "${s.categoryKey}", which does not exist.`);
      const workflow = s.workflowKey ? workflows.find((w) => w.key === s.workflowKey) : null;
      if (s.workflowKey && !workflow) throw new Error(`${t.slug}: service ${s.code} refers to workflow "${s.workflowKey}", which does not exist.`);
      const service = await owner.post('/services', {
        categoryId: category.id,
        code: s.code,
        name: s.name,
        nameAr: s.nameAr,
        description: s.description,
        eligibilityGuidance: s.eligibilityGuidance ?? null,
        complianceCapability: s.complianceCapability,
        estimatedProcessingHours: s.estimatedProcessingHours,
        requiresApproval: s.requiresApproval ?? false,
        paymentPolicy: s.paymentPolicy ?? 'BEFORE_PROCESSING',
        ...(s.depositPercent ? { depositPercent: s.depositPercent } : {}),
        onlineAvailable: s.onlineAvailable ?? true,
        isPublic: s.isPublic ?? true,
        allBranches: !s.branches,
        branchIds: (s.branches ?? []).map((code) => t.branch(code).id),
        ...(workflow ? { workflowDefinitionId: workflow.id } : {}),
        price: s.price,
      });
      for (const r of s.requirements) await owner.post(`/services/${service.id}/requirements`, r);
      for (const bp of s.branchPrices ?? []) await owner.post(`/services/${service.id}/prices`, { branchId: t.branch(bp.branch).id, serviceFee: bp.serviceFee, governmentFeeEstimate: bp.governmentFeeEstimate, thirdPartyFeeEstimate: bp.thirdPartyFeeEstimate });
      if (s.form) {
        const draft = await owner.post(`/services/${service.id}/forms`, { schema: s.form });
        await owner.post(`/services/${service.id}/forms/${draft.id}/publish`);
      }
      custom += 1;
    }

    const list = await owner.get('/services', { query: { pageSize: 100 } });
    for (const a of t.fx.starterAdjustments ?? []) {
      const row = list.data.find((x: any) => x.code === a.code);
      if (!row) throw new Error(`${t.slug}: starter service ${a.code} was not installed.`);
      const patch: Record<string, unknown> = {};
      if (a.isActive !== undefined) patch.isActive = a.isActive;
      if (a.requiresApproval !== undefined) patch.requiresApproval = a.requiresApproval;
      if (Object.keys(patch).length) await owner.patch(`/services/${row.id}`, patch);
      if (a.price) await owner.post(`/services/${row.id}/prices`, a.price);
      if (a.branchPrice) await owner.post(`/services/${row.id}/prices`, { branchId: t.branch(a.branchPrice.branch).id, serviceFee: a.branchPrice.serviceFee });
    }
    if (t.fx.serviceStaffGroup) for (const row of list.data) await owner.patch(`/services/${row.id}`, { staffGroupRoleKey: t.fx.serviceStaffGroup });

    const final = await owner.get('/services', { query: { pageSize: 100 } });
    for (const row of final.data) {
      t.services.set(row.code, { id: row.id, code: row.code, name: row.name, requiresApproval: row.requiresApproval, complianceCapability: row.complianceCapability, paymentPolicy: row.paymentPolicy, depositPercent: row.depositPercent ? Number(row.depositPercent) : null });
    }
    return { total: final.data.length, custom };
  }, (r) => `${r.total} services (${r.custom} of the centre's own)`);

  await step(`${t.fx.name}: online payments (test gateway)`, () => enableSandboxGateway(ctx, t));

  await step(`${t.fx.name}: staff skills and weekly schedules`, async () => {
    const members: any[] = await owner.get('/staff');
    let schedules = 0;
    for (const s of t.fx.staff) {
      const actor = t.actor(s.key);
      const member = members.find((m) => m.id === actor.membershipId);
      if (!member) throw new Error(`${t.slug}: staff member ${s.key} is missing from the staff list.`);
      if (s.skills?.length) await owner.patch(`/staff/${member.id}`, { serviceIds: s.skills.map((code) => t.service(code).id) });
      if (s.shifts?.length) {
        const home = s.branches === 'ALL' ? t.branch().code : (s.branches as string[])[0];
        const entries = s.shifts.flatMap((shift) => shift.days.map((weekday: Weekday) => ({ branchId: t.branch(shift.branch ?? home).id, weekday, startTime: shift.start, endTime: shift.end })));
        await owner.put(`/staff/${member.id}/schedule`, { entries });
        schedules += 1;
      }
    }
    return schedules;
  }, (n) => `${n} schedules`);

  await step(`${t.fx.name}: customer tags, appointment calendar`, async () => {
    for (const tag of t.fx.tags ?? []) {
      const row = await owner.post('/customer-tags', tag);
      t.tags.set(tag.name, row.id);
    }
    let slots = 0;
    for (const br of t.fx.branches) {
      for (const [weekday, hours] of Object.entries(br.hours)) {
        if (!hours) continue;
        await owner.post('/appointments/slot-configs', { branchId: t.branch(br.code).id, weekday: Number(weekday), startTime: hours.open, endTime: hours.close, slotMinutes: 30, capacity: 2 });
        slots += 1;
      }
    }
    if (t.fx.branding?.whiteLabel) await owner.put('/appointments/settings', { guestBookingEnabled: true, noShowAfterMinutes: 30, reminderHoursBefore: [24, 2] });
    return slots;
  }, (n) => `${t.fx.tags?.length ?? 0} tags, ${n} calendar days`);

  if (t.fx.customDomain) {
    await step(`${t.fx.name}: custom domain ${t.fx.customDomain} (left waiting for DNS verification)`, async () => {
      await owner.post('/domains', { domain: t.fx.customDomain, app: 'customer' });
    });
  }
}

/** Publishes a customised copy of a workflow as a new version. Requests created earlier stay on the old one. */
export async function customiseWorkflow(ctx: SeedContext, t: TenantState, publishedDaysAgo: number): Promise<void> {
  const c = t.fx.workflowCustomisation;
  if (!c) return;
  const owner = ctx.rt.as(t.owner);
  await step(`${t.fx.name}: customised "${c.definitionKey}" workflow published as a new version`, async () => {
    const workflows: any[] = await owner.get('/workflows');
    const definition = workflows.find((w) => w.key === c.definitionKey);
    if (!definition) throw new Error(`${t.slug}: workflow "${c.definitionKey}" does not exist.`);
    const draft = await owner.post(`/workflows/${definition.id}/versions`, { notes: c.notes });
    const steps: any[] = [];
    for (const s of draft.steps) {
      const { id: _id, position: _p, versionId: _v, tenantId: _t, createdAt: _c, updatedAt: _u, ...rest } = s;
      const clean: any = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== null));
      if (clean.type === 'INTERNAL_APPROVAL' && c.reviewTimeoutHours) clean.timeoutHours = c.reviewTimeoutHours;
      steps.push(clean);
      if (clean.key === c.addNotificationAfter) {
        steps.push({ key: 'work-started', name: 'Tell the customer that work has started', nameAr: 'إبلاغ العميل ببدء العمل', type: 'NOTIFICATION', config: { message: c.message }, customerVisible: true });
      }
    }
    await owner.put(`/workflows/${definition.id}/versions/${draft.id}/steps`, { steps, notes: c.notes });
    const published = await owner.post(`/workflows/${definition.id}/versions/${draft.id}/publish`);
    const at = daysAgo(publishedDaysAgo);
    ctx.timeline.set('workflow_versions', published.id ?? draft.id, { createdAt: at, updatedAt: at, publishedAt: at });
    return published;
  }, (v) => `version ${v.version}`);
}

/**
 * Online payments need an ACTIVE payment gateway of the centre. The owner adds and enables the test gateway
 * in Settings > Integrations. Only an installation that runs without the integrations module (a reduced
 * TYPEASE_MODULES list) has no such endpoint; there the row is written directly, the documented exception.
 */
async function enableSandboxGateway(ctx: SeedContext, t: TenantState): Promise<void> {
  const { rt } = ctx;
  if (rt.hasModule('IntegrationsModule')) {
    const owner = rt.as(t.owner);
    const gateway = await owner.post('/integrations', { category: 'PAYMENT', provider: 'sandbox', mode: 'TEST' });
    const enabled = await owner.post(`/integrations/${gateway.id}/enable`);
    if (enabled.status !== 'ACTIVE') throw new Error(`${t.slug}: the test payment gateway should be ACTIVE after enabling it, but it is ${enabled.status}.`);
    return;
  }
  const existing = await rt.sys.integration.findFirst({ where: { tenantId: t.id, category: 'PAYMENT', provider: 'sandbox' } });
  if (!existing) {
    await rt.sys.integration.create({ data: { tenantId: t.id, category: 'PAYMENT', provider: 'sandbox', name: 'Sandbox (test payments - no money moves)', status: 'ACTIVE', mode: 'TEST', createdById: t.owner.userId } });
  }
  ctx.noteDirectDb('integration_credentials_metadata: this installation runs without the integrations module, so the ACTIVE "sandbox" PAYMENT row of each centre (the test gateway) and the sample PARTNER row were inserted directly instead of through Settings > Integrations.');
}

/**
 * A partner-coordination service needs a partner authorisation record. The owner submits it, a TypEase
 * administrator verifies it (it unlocks nothing before that) - or leaves it waiting when the fixture says so,
 * so that the platform console has a record to review.
 */
async function ensurePartnerRecord(ctx: SeedContext, t: TenantState): Promise<void> {
  const { rt } = ctx;
  const p = t.fx.partner;
  if (!p) throw new Error(`${t.slug} defines a partner-coordination service but no sample partner.`);
  if (t.partnerRecordId) return;
  if (rt.hasModule('IntegrationsModule')) {
    const record = await rt.as(t.owner).post('/integrations', {
      category: 'PARTNER',
      provider: 'authorised-partner',
      name: p.name,
      config: {
        partnerLegalName: p.legalName,
        serviceScope: p.serviceScope,
        agreementReference: p.agreementReference,
        agreementValidUntil: isoDay(daysAgo(-p.validForDays)),
        ...(p.contactName ? { contactName: p.contactName } : {}),
        ...(p.contactEmail ? { contactEmail: p.contactEmail } : {}),
      },
      authorisationNote: p.note,
    });
    t.partnerRecordId = record.id;
    if (p.review === 'PENDING') return;
    const verified = await rt.as(ctx.platformAdmin).post(`/platform/integrations/authorisations/${record.id}/verify`, { note: 'Demo review: the sample agreement was checked. (fictional record)' });
    if (verified.state !== 'VERIFIED') throw new Error(`${t.slug}: the partner record should be VERIFIED after the review, but it is ${verified.state}.`);
    return;
  }
  if (p.review === 'PENDING') return;
  const row = await rt.sys.integration.create({ data: { tenantId: t.id, category: 'PARTNER', provider: 'sample-partner', name: p.name, status: 'ACTIVE', mode: 'TEST', authorisationNote: p.note, createdById: t.owner.userId } });
  t.partnerRecordId = row.id;
}
