import { Actor, TenantFixture, TestApp, uniq } from '../../../test/helpers';
import { addCorporateUser, categoryId, createCorporateAccount, createService, serviceBody, simpleForm } from './fixtures';
import { installStarterCatalogue, STARTER_SERVICES } from './starter-catalogue';

describe('Catalogue', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let receptionist: Actor;
  let customer: Actor;
  let typing: string;

  beforeAll(async () => {
    t = await TestApp.create();
    alpha = await t.createTenant({ name: 'Alpha Typing' });
    beta = await t.createTenant({ name: 'Beta Typing' });
    receptionist = await t.addStaff(alpha, 'receptionist');
    customer = await t.addCustomer(alpha);
    typing = await categoryId(t, alpha);
  });
  afterAll(() => t.close());

  const audit = (tenantId: string, action: string, resourceId?: string) => t.sys.auditLog.findMany({ where: { tenantId, action, ...(resourceId ? { resourceId } : {}) }, orderBy: { createdAt: 'asc' } });

  // ------------------------------------------------------------------ categories
  describe('categories', () => {
    it('lists the 12 provisioned defaults in order with service counts', async () => {
      const res = await t.as(alpha.owner).get('/service-categories').expect(200);
      expect(res.body).toHaveLength(12);
      expect(res.body[0]).toMatchObject({ key: 'typing', name: 'Typing & Documentation', isActive: true, serviceCount: expect.any(Number) });
      expect(res.body.map((c: any) => c.sortOrder)).toEqual([...res.body.map((c: any) => c.sortOrder)].sort((a, b) => a - b));
    });

    it('creates (key derived from the name), edits, deactivates and deletes a category', async () => {
      const created = (await t.as(alpha.owner).post('/service-categories', { name: 'Notary Help Desk', nameAr: 'مكتب المساعدة' }).expect(201)).body;
      expect(created).toMatchObject({ key: 'notary-help-desk', isActive: true, tenantId: alpha.id });
      const again = (await t.as(alpha.owner).post('/service-categories', { name: 'Notary Help Desk' }).expect(201)).body;
      expect(again.key).toBe('notary-help-desk-2');
      await t.as(alpha.owner).post('/service-categories', { key: 'typing', name: 'Clash' }).expect(409);

      const updated = (await t.as(alpha.owner).patch(`/service-categories/${created.id}`, { name: 'Notary Desk', isActive: false }).expect(200)).body;
      expect(updated).toMatchObject({ name: 'Notary Desk', isActive: false, key: 'notary-help-desk' });
      const active = (await t.as(alpha.owner).get('/service-categories')).body;
      expect(active.find((c: any) => c.id === created.id)).toBeUndefined();
      const all = (await t.as(alpha.owner).get('/service-categories?includeInactive=true')).body;
      expect(all.find((c: any) => c.id === created.id)).toBeDefined();

      await t.as(alpha.owner).delete(`/service-categories/${created.id}`).expect(200);
      await t.as(alpha.owner).delete(`/service-categories/${again.id}`).expect(200);
      expect((await audit(alpha.id, 'service_category.created', created.id)).length).toBe(1);
      expect((await audit(alpha.id, 'service_category.deleted', created.id)).length).toBe(1);
    });

    it('refuses to delete a category that has services, and to put a service in an inactive category', async () => {
      const category = (await t.as(alpha.owner).post('/service-categories', { name: `Busy ${uniq()}` }).expect(201)).body;
      const service = await createService(t, alpha, { categoryId: category.id });
      const res = await t.as(alpha.owner).delete(`/service-categories/${category.id}`).expect(409);
      expect(res.body.code).toBe('CATEGORY_IN_USE');
      await t.as(alpha.owner).patch(`/service-categories/${category.id}`, { isActive: false }).expect(200);
      const blocked = await t.as(alpha.owner).post('/services', serviceBody(category.id)).expect(422);
      expect(blocked.body.code).toBe('CATEGORY_INACTIVE');
      expect(service.category.id).toBe(category.id);
    });

    it('reorders categories', async () => {
      const before = (await t.as(alpha.owner).get('/service-categories?includeInactive=true')).body;
      const [first, second] = before;
      const res = await t.as(alpha.owner).put('/service-categories/order', { ids: [second.id, first.id] }).expect(200);
      expect(res.body.slice(0, 2).map((c: any) => c.id)).toEqual([second.id, first.id]);
      expect(res.body).toHaveLength(before.length);
      // Restore so later tests see "typing" first again.
      await t.as(alpha.owner).put('/service-categories/order', { ids: before.map((c: any) => c.id) }).expect(200);
      const betaCategory = await categoryId(t, beta);
      await t.as(alpha.owner).put('/service-categories/order', { ids: [first.id, betaCategory] }).expect(404);
      await t.as(alpha.owner).put('/service-categories/order', { ids: [first.id, first.id] }).expect(400);
    });
  });

  // ------------------------------------------------------------------ document types
  describe('document types', () => {
    it('merges platform defaults with the centre\'s own types; the centre\'s row wins on the same key', async () => {
      const defaults = (await t.as(alpha.owner).get('/document-types').expect(200)).body;
      expect(defaults.map((d: any) => d.key)).toEqual(expect.arrayContaining(['passport', 'emirates_id', 'trade_licence', 'other']));
      expect(defaults.every((d: any) => d.source === 'PLATFORM')).toBe(true);
      expect(defaults[0].tenantId).toBeUndefined();

      const own = (await t.as(alpha.owner).post('/document-types', { key: 'salary_certificate', name: 'Salary Certificate', hasExpiry: false }).expect(201)).body;
      const override = (await t.as(alpha.owner).post('/document-types', { key: 'passport', name: 'Passport (bio page)', hasExpiry: true, reminderEnabled: true, ocrProfile: 'PASSPORT' }).expect(201)).body;
      const merged = (await t.as(alpha.owner).get('/document-types')).body;
      expect(merged.filter((d: any) => d.key === 'passport')).toEqual([expect.objectContaining({ id: override.id, name: 'Passport (bio page)', source: 'TENANT', overridesPlatformDefault: true })]);
      expect(merged.find((d: any) => d.key === 'salary_certificate')).toMatchObject({ id: own.id, source: 'TENANT', overridesPlatformDefault: false });
      expect(merged).toHaveLength(defaults.length + 1);

      // Beta still sees the untouched platform default and none of Alpha's types.
      const betaTypes = (await t.as(beta.owner).get('/document-types')).body;
      expect(betaTypes.find((d: any) => d.key === 'passport')).toMatchObject({ name: 'Passport', source: 'PLATFORM' });
      expect(betaTypes.find((d: any) => d.key === 'salary_certificate')).toBeUndefined();

      // An inactive override hides the key for this centre.
      await t.as(alpha.owner).patch(`/document-types/${override.id}`, { isActive: false }).expect(200);
      expect((await t.as(alpha.owner).get('/document-types')).body.find((d: any) => d.key === 'passport')).toBeUndefined();
      expect((await t.as(alpha.owner).get('/document-types?includeInactive=true')).body.find((d: any) => d.key === 'passport')).toMatchObject({ isActive: false });

      // Deleting the override falls back to the platform default.
      const removed = (await t.as(alpha.owner).delete(`/document-types/${override.id}`).expect(200)).body;
      expect(removed).toEqual({ status: 'DELETED', revertedToPlatformDefault: true });
      expect((await t.as(alpha.owner).get('/document-types')).body.find((d: any) => d.key === 'passport')).toMatchObject({ name: 'Passport', source: 'PLATFORM' });
    });

    it('platform defaults and other centres\' types cannot be edited or deleted', async () => {
      const platform = await t.sys.documentType.findFirstOrThrow({ where: { tenantId: null, key: 'photo' } });
      const res = await t.as(alpha.owner).patch(`/document-types/${platform.id}`, { name: 'Hacked' }).expect(409);
      expect(res.body.code).toBe('PLATFORM_DEFAULT');
      await t.as(alpha.owner).delete(`/document-types/${platform.id}`).expect(409);
      expect((await t.sys.documentType.findUniqueOrThrow({ where: { id: platform.id } })).name).toBe('Personal Photo');

      const betaType = (await t.as(beta.owner).post('/document-types', { key: 'beta_only', name: 'Beta only' }).expect(201)).body;
      await t.as(alpha.owner).patch(`/document-types/${betaType.id}`, { name: 'Hijacked' }).expect(404);
      await t.as(alpha.owner).delete(`/document-types/${betaType.id}`).expect(404);
    });

    it('validates keys, duplicates and the reminder rule; keeps types that are in use', async () => {
      await t.as(alpha.owner).post('/document-types', { key: 'Bad Key!', name: 'X' }).expect(400);
      await t.as(alpha.owner).post('/document-types', { key: 'no_expiry', name: 'No expiry', hasExpiry: false, reminderEnabled: true }).expect(422);
      const key = `noc_${uniq()}`.toLowerCase();
      const noc = (await t.as(alpha.owner).post('/document-types', { key, name: 'NOC letter' }).expect(201)).body;
      await t.as(alpha.owner).post('/document-types', { key, name: 'Again' }).expect(409);
      await t.as(alpha.owner).patch(`/document-types/${noc.id}`, { reminderEnabled: true }).expect(422);
      await t.as(alpha.owner).patch(`/document-types/${noc.id}`, { hasExpiry: true, reminderEnabled: true }).expect(200);

      const service = await createService(t, alpha);
      await t.as(alpha.owner).post(`/services/${service.id}/requirements`, { documentTypeKey: key, label: 'NOC from sponsor' }).expect(201);
      const res = await t.as(alpha.owner).delete(`/document-types/${noc.id}`).expect(409);
      expect(res.body.code).toBe('DOCUMENT_TYPE_IN_USE');
    });

    it('any member of the centre can read the list; only service managers can change it', async () => {
      await t.as(customer).get('/document-types').expect(200);
      await t.as(receptionist).get('/document-types').expect(200);
      await t.as(receptionist).post('/document-types', { key: 'nope', name: 'Nope' }).expect(403);
      await t.as(customer).post('/document-types', { key: 'nope', name: 'Nope' }).expect(403);
      await t.as(null).get('/document-types').expect(401);
    });
  });

  // ------------------------------------------------------------------ services
  describe('services', () => {
    it('creates a service with every attribute, a default price and an audit entry', async () => {
      const second = (await t.as(alpha.owner).post('/branches', { code: `S${uniq().slice(-5).toUpperCase()}`, name: 'Second branch' }).expect(201)).body;
      const workflow = await t.sys.workflowDefinition.create({ data: { tenantId: alpha.id, key: `wf-${uniq()}`, name: 'Standard typing' } });
      const body = serviceBody(typing, {
        code: 'ten-001',
        descriptionAr: 'وصف',
        eligibilityGuidance: 'Bring both parties\' identity documents.',
        estimatedProcessingHours: 4,
        requiresApproval: true,
        paymentPolicy: 'DEPOSIT',
        depositPercent: 40,
        taxMode: 'ALL_COMPONENTS',
        onlineAvailable: false,
        isPublic: false,
        allBranches: false,
        branchIds: [alpha.headOfficeId, second.id],
        staffGroupRoleKey: 'operator',
        workflowDefinitionId: workflow.id,
        sortOrder: 7,
        price: { serviceFee: '120.5', governmentFeeEstimate: '30', thirdPartyFeeEstimate: 10 },
      });
      const res = await t.as(alpha.owner).post('/services', body).expect(201);
      expect(res.body).toMatchObject({
        tenantId: alpha.id, code: 'TEN-001', name: 'Tenancy contract typing', nameAr: 'طباعة عقد الإيجار', complianceCapability: 'DOCUMENT_PREPARATION_ONLY',
        estimatedProcessingHours: 4, requiresApproval: true, paymentPolicy: 'DEPOSIT', depositPercent: '40', taxMode: 'ALL_COMPONENTS',
        onlineAvailable: false, isPublic: false, isActive: true, allBranches: false, staffGroupRoleKey: 'operator', workflowDefinitionId: workflow.id,
        sortOrder: 7, version: 1, deletedAt: null,
        category: { key: 'typing' },
        price: { serviceFee: '120.5', governmentFeeEstimate: '30', thirdPartyFeeEstimate: '10', currency: 'AED', branchId: null, isActive: true },
      });
      expect(res.body.branchIds.sort()).toEqual([alpha.headOfficeId, second.id].sort());

      const detail = (await t.as(alpha.owner).get(`/services/${res.body.id}`).expect(200)).body;
      expect(detail).toMatchObject({ id: res.body.id, workflowDefinition: { id: workflow.id, name: 'Standard typing' }, form: { published: null, draft: null }, requirements: [] });
      expect(detail.activePrices).toHaveLength(1);
      const logs = await audit(alpha.id, 'service.created', res.body.id);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({ actorUserId: alpha.owner.userId, resourceType: 'Service' });
    });

    it('validates input and references', async () => {
      const post = (over: Record<string, unknown>) => t.as(alpha.owner).post('/services', serviceBody(typing, over));
      await post({ name: 'x' }).expect(400);
      await post({ code: 'has space' }).expect(400);
      await post({ price: undefined }).expect(400);
      await post({ price: { serviceFee: '-5' } }).expect(400);
      await post({ price: { serviceFee: '10.999' } }).expect(400);
      await post({ paymentPolicy: 'DEPOSIT' }).expect(400);
      await post({ paymentPolicy: 'DEPOSIT', depositPercent: 0 }).expect(400);
      await post({ paymentPolicy: 'DEPOSIT', depositPercent: 101 }).expect(400);
      await post({ taxMode: 'VAT' }).expect(400);
      await post({ allBranches: false, branchIds: [] }).expect(400);
      expect((await post({ staffGroupRoleKey: 'customer' }).expect(422)).body.code).toBe('UNKNOWN_STAFF_GROUP');
      expect((await post({ staffGroupRoleKey: 'no_such_role' }).expect(422)).body.code).toBe('UNKNOWN_STAFF_GROUP');
      await post({ categoryId: '00000000-0000-4000-8000-000000000000' }).expect(404);
      // A deposit percentage is dropped when the policy is not DEPOSIT.
      expect((await post({ paymentPolicy: 'AFTER_COMPLETION', depositPercent: 30 }).expect(201)).body.depositPercent).toBeNull();
    });

    it('keeps the internal code unique per centre (also against deleted services), not across centres', async () => {
      const code = `DUP-${uniq()}`.toUpperCase();
      const first = await createService(t, alpha, { code });
      const clash = await t.as(alpha.owner).post('/services', serviceBody(typing, { code: code.toLowerCase() })).expect(409);
      expect(clash.body.code).toBe('DUPLICATE_CODE');
      await createService(t, beta, { code });
      await t.as(alpha.owner).delete(`/services/${first.id}`).expect(200);
      const afterDelete = await t.as(alpha.owner).post('/services', serviceBody(typing, { code })).expect(409);
      expect(afterDelete.body.message).toMatch(/deleted service/);
      expect(afterDelete.body.details).toMatchObject({ serviceId: first.id, deleted: true });
    });

    it('lists with search, filters, paging and sorting', async () => {
      const marker = `Zebra${uniq()}`;
      const visa = await categoryId(t, alpha, 'visa');
      const a = await createService(t, alpha, { name: `${marker} alpha`, sortOrder: 2 });
      const b = await createService(t, alpha, { name: `${marker} beta`, categoryId: visa, isPublic: false, onlineAvailable: false, sortOrder: 1 });
      const c = await createService(t, alpha, { name: `${marker} gamma`, isActive: false, sortOrder: 3 });
      const ids = (res: any) => res.body.data.map((s: any) => s.id);

      const all = await t.as(alpha.owner).get(`/services?q=${marker.toLowerCase()}`).expect(200);
      expect(ids(all)).toEqual([b.id, a.id, c.id]);
      expect(all.body.meta).toMatchObject({ total: 3, page: 1 });
      expect(all.body.data[0]).toMatchObject({ category: { key: 'visa' }, price: { serviceFee: '100' } });
      expect(ids(await t.as(alpha.owner).get(`/services?q=${marker}&sort=name:desc`))).toEqual([c.id, b.id, a.id]);
      expect(ids(await t.as(alpha.owner).get(`/services?q=${marker}&categoryId=${visa}`))).toEqual([b.id]);
      expect(ids(await t.as(alpha.owner).get(`/services?q=${marker}&isActive=false`))).toEqual([c.id]);
      expect(ids(await t.as(alpha.owner).get(`/services?q=${marker}&isPublic=true&isActive=true`))).toEqual([a.id]);
      expect(ids(await t.as(alpha.owner).get(`/services?q=${marker}&onlineAvailable=false`))).toEqual([b.id]);
      expect(ids(await t.as(alpha.owner).get(`/services?q=${b.code.toLowerCase()}`))).toEqual([b.id]);
      const page2 = await t.as(alpha.owner).get(`/services?q=${marker}&pageSize=2&page=2`).expect(200);
      expect(ids(page2)).toEqual([c.id]);
      expect(page2.body.meta).toMatchObject({ total: 3, totalPages: 2, pageSize: 2 });
      // Sorting by a column outside the allow-list falls back to the default.
      expect(ids(await t.as(alpha.owner).get(`/services?q=${marker}&sort=tenantId:asc`))).toEqual([b.id, a.id, c.id]);
      await t.as(alpha.owner).get('/services?categoryId=not-a-uuid').expect(400);
    });

    it('filters by branch: services for all branches plus the ones listed for that branch', async () => {
      const marker = `Branchy${uniq()}`;
      const second = (await t.as(alpha.owner).post('/branches', { code: `B${uniq().slice(-5).toUpperCase()}`, name: 'Branch two' }).expect(201)).body;
      const everywhere = await createService(t, alpha, { name: `${marker} everywhere` });
      const headOnly = await createService(t, alpha, { name: `${marker} head`, allBranches: false, branchIds: [alpha.headOfficeId] });
      const secondOnly = await createService(t, alpha, { name: `${marker} second`, allBranches: false, branchIds: [second.id] });
      const at = async (branchId: string) => (await t.as(alpha.owner).get(`/services?q=${marker}&branchId=${branchId}&sort=name:asc`).expect(200)).body.data.map((s: any) => s.id);
      expect(await at(alpha.headOfficeId)).toEqual([everywhere.id, headOnly.id]);
      expect(await at(second.id)).toEqual([everywhere.id, secondOnly.id]);
    });

    it('updates with optimistic concurrency and records what changed', async () => {
      const service = await createService(t, alpha);
      const updated = (await t.as(alpha.owner).patch(`/services/${service.id}`, { name: 'Tenancy typing (updated)', estimatedProcessingHours: 6, version: 1 }).expect(200)).body;
      expect(updated).toMatchObject({ name: 'Tenancy typing (updated)', estimatedProcessingHours: 6, version: 2 });
      // A second editor still holding version 1 is told to reload.
      const stale = await t.as(alpha.owner).patch(`/services/${service.id}`, { name: 'Stale write', version: 1 }).expect(409);
      expect(stale.body.code).toBe('VERSION_CONFLICT');
      expect((await t.sys.service.findUniqueOrThrow({ where: { id: service.id } })).name).toBe('Tenancy typing (updated)');
      // Without a version the edit applies to the latest state.
      expect((await t.as(alpha.owner).patch(`/services/${service.id}`, { isActive: false }).expect(200)).body).toMatchObject({ isActive: false, version: 3 });
      const logs = await audit(alpha.id, 'service.updated', service.id);
      expect(logs).toHaveLength(2);
      expect(logs[0].before).toMatchObject({ name: 'Tenancy contract typing' });
      expect(logs[0].after).toMatchObject({ name: 'Tenancy typing (updated)' });
    });

    it('keeps payment policy / deposit and branch rules consistent on update', async () => {
      const service = await createService(t, alpha);
      expect((await t.as(alpha.owner).patch(`/services/${service.id}`, { paymentPolicy: 'DEPOSIT' }).expect(422)).body.code).toBe('DEPOSIT_PERCENT_REQUIRED');
      expect((await t.as(alpha.owner).patch(`/services/${service.id}`, { paymentPolicy: 'DEPOSIT', depositPercent: 25 }).expect(200)).body).toMatchObject({ paymentPolicy: 'DEPOSIT', depositPercent: '25' });
      expect((await t.as(alpha.owner).patch(`/services/${service.id}`, { paymentPolicy: 'BEFORE_PROCESSING' }).expect(200)).body).toMatchObject({ paymentPolicy: 'BEFORE_PROCESSING', depositPercent: null });

      expect((await t.as(alpha.owner).patch(`/services/${service.id}`, { allBranches: false }).expect(422)).body.code).toBe('BRANCH_REQUIRED');
      expect((await t.as(alpha.owner).patch(`/services/${service.id}`, { allBranches: false, branchIds: [alpha.headOfficeId] }).expect(200)).body).toMatchObject({ allBranches: false, branchIds: [alpha.headOfficeId] });
      await t.as(alpha.owner).patch(`/services/${service.id}`, { branchIds: [] }).expect(422);
      expect((await t.as(alpha.owner).patch(`/services/${service.id}`, { allBranches: true }).expect(200)).body).toMatchObject({ allBranches: true, branchIds: [] });
      expect(await t.sys.serviceBranch.count({ where: { serviceId: service.id } })).toBe(0);
    });

    it('soft-deletes and restores; a service with open requests cannot be deleted', async () => {
      const service = await createService(t, alpha);
      const person = await t.sys.customer.create({ data: { tenantId: alpha.id, customerNo: `CUS-${uniq()}`, fullName: 'Walk In' } });
      const request = await t.sys.serviceRequest.create({ data: { tenantId: alpha.id, branchId: alpha.headOfficeId, requestNo: `TE-${uniq()}`, customerId: person.id, serviceId: service.id, status: 'IN_PREPARATION' } });
      expect((await t.as(alpha.owner).delete(`/services/${service.id}`).expect(409)).body.code).toBe('SERVICE_HAS_OPEN_REQUESTS');
      await t.sys.serviceRequest.update({ where: { id: request.id }, data: { status: 'COMPLETED' } });

      await t.as(alpha.owner).delete(`/services/${service.id}`).expect(200);
      const row = await t.sys.service.findUniqueOrThrow({ where: { id: service.id } });
      expect(row.deletedAt).not.toBeNull();
      expect(row.isActive).toBe(false);
      expect((await t.as(alpha.owner).get(`/services?q=${service.code}`)).body.data).toEqual([]);
      expect((await t.as(alpha.owner).get(`/services?q=${service.code}&deleted=true`)).body.data.map((s: any) => s.id)).toEqual([service.id]);
      await t.as(alpha.owner).patch(`/services/${service.id}`, { name: 'Zombie' }).expect(404);
      await t.as(alpha.owner).delete(`/services/${service.id}`).expect(404);
      await t.as(alpha.owner).get(`/services/${service.id}/full`).expect(404);

      const restored = (await t.as(alpha.owner).post(`/services/${service.id}/restore`).expect(200)).body;
      expect(restored).toMatchObject({ deletedAt: null, isActive: false });
      expect((await t.as(alpha.owner).post(`/services/${service.id}/restore`).expect(409)).body.code).toBe('NOT_DELETED');
      expect((await audit(alpha.id, 'service.deleted', service.id)).length).toBe(1);
      expect((await audit(alpha.id, 'service.restored', service.id)).length).toBe(1);
    });

    it('reorders services', async () => {
      const marker = `Order${uniq()}`;
      const one = await createService(t, alpha, { name: `${marker} 1` });
      const two = await createService(t, alpha, { name: `${marker} 2` });
      const three = await createService(t, alpha, { name: `${marker} 3` });
      await t.as(alpha.owner).put('/services/order', { ids: [three.id, one.id, two.id] }).expect(200);
      expect((await t.as(alpha.owner).get(`/services?q=${marker}`)).body.data.map((s: any) => s.id)).toEqual([three.id, one.id, two.id]);
      const foreign = await createService(t, beta);
      await t.as(alpha.owner).put('/services/order', { ids: [one.id, foreign.id] }).expect(404);
    });
  });

  // ------------------------------------------------------------------ compliance capability
  describe('compliance capability', () => {
    const integration = (tenant: TenantFixture, data: Record<string, unknown>) =>
      t.sys.integration.create({ data: { tenantId: tenant.id, provider: `p-${uniq()}`, name: 'Channel', category: 'PARTNER', status: 'DISABLED', ...data } as any });

    it('defaults to document preparation only', async () => {
      expect((await createService(t, alpha)).complianceCapability).toBe('DOCUMENT_PREPARATION_ONLY');
      expect((await createService(t, alpha, { complianceCapability: 'INFORMATIONAL_ONLY' })).complianceCapability).toBe('INFORMATIONAL_ONLY');
    });

    it('DIRECT_AUTHORISED needs an ACTIVE government integration whose authorisation was verified', async () => {
      const gamma = await t.createTenant();
      const cat = await categoryId(t, gamma);
      const attempt = () => t.as(gamma.owner).post('/services', serviceBody(cat, { complianceCapability: 'DIRECT_AUTHORISED' }));
      const none = await attempt().expect(422);
      expect(none.body.code).toBe('CAPABILITY_NOT_PERMITTED');
      expect(none.body.message).toMatch(/authorisation has been verified/);
      expect(none.body.details).toMatchObject({ requires: { integrationCategory: 'GOVERNMENT', authorisationVerified: true } });

      // Each of these is insufficient on its own.
      const unverified = await integration(gamma, { category: 'GOVERNMENT', status: 'ACTIVE' });
      await attempt().expect(422);
      await t.sys.integration.update({ where: { id: unverified.id }, data: { status: 'CONFIGURED', authorisationVerifiedAt: new Date() } });
      await attempt().expect(422);
      await integration(gamma, { category: 'PARTNER', status: 'ACTIVE', authorisationVerifiedAt: new Date() });
      await attempt().expect(422);
      // Another centre's verified integration does not count.
      await integration(beta, { category: 'GOVERNMENT', status: 'ACTIVE', authorisationVerifiedAt: new Date() });
      await attempt().expect(422);
      // A platform-level row (no tenant) does not count either.
      await t.sys.integration.create({ data: { tenantId: null, provider: `platform-${uniq()}`, name: 'Platform', category: 'GOVERNMENT', status: 'ACTIVE', authorisationVerifiedAt: new Date() } });
      await attempt().expect(422);

      await t.sys.integration.update({ where: { id: unverified.id }, data: { status: 'ACTIVE' } });
      expect((await attempt().expect(201)).body.complianceCapability).toBe('DIRECT_AUTHORISED');
    });

    it('PARTNER_COORDINATION needs a configured or active partner', async () => {
      const gamma = await t.createTenant();
      const cat = await categoryId(t, gamma);
      const attempt = () => t.as(gamma.owner).post('/services', serviceBody(cat, { complianceCapability: 'PARTNER_COORDINATION' }));
      const none = await attempt().expect(422);
      expect(none.body.code).toBe('CAPABILITY_NOT_PERMITTED');
      expect(none.body.message).toMatch(/partner has been set up/);
      const partner = await integration(gamma, { category: 'PARTNER', status: 'DISABLED' });
      await attempt().expect(422);
      await integration(gamma, { category: 'GOVERNMENT', status: 'ACTIVE', authorisationVerifiedAt: new Date() });
      await attempt().expect(422);
      await t.sys.integration.update({ where: { id: partner.id }, data: { status: 'CONFIGURED' } });
      expect((await attempt().expect(201)).body.complianceCapability).toBe('PARTNER_COORDINATION');
    });

    it('applies the same rule when an existing service is changed or reactivated', async () => {
      const gamma = await t.createTenant();
      const service = await createService(t, gamma);
      expect((await t.as(gamma.owner).patch(`/services/${service.id}`, { complianceCapability: 'DIRECT_AUTHORISED' }).expect(422)).body.code).toBe('CAPABILITY_NOT_PERMITTED');
      expect((await t.sys.service.findUniqueOrThrow({ where: { id: service.id } })).complianceCapability).toBe('DOCUMENT_PREPARATION_ONLY');
      const partner = await integration(gamma, { category: 'PARTNER', status: 'ACTIVE' });
      await t.as(gamma.owner).patch(`/services/${service.id}`, { complianceCapability: 'PARTNER_COORDINATION' }).expect(200);
      // Unrelated edits still work after the partner is switched off, but switching the service back on does not.
      await t.sys.integration.update({ where: { id: partner.id }, data: { status: 'DISABLED' } });
      await t.as(gamma.owner).patch(`/services/${service.id}`, { name: 'Renamed', isActive: false }).expect(200);
      await t.as(gamma.owner).patch(`/services/${service.id}`, { isActive: true }).expect(422);
      await t.as(gamma.owner).patch(`/services/${service.id}`, { isActive: true, complianceCapability: 'DOCUMENT_PREPARATION_ONLY' }).expect(200);
    });
  });

  // ------------------------------------------------------------------ prices
  describe('prices', () => {
    it('keeps history and exactly one active default price', async () => {
      const service = await createService(t, alpha);
      const next = (await t.as(alpha.owner).post(`/services/${service.id}/prices`, { serviceFee: '150', governmentFeeEstimate: '20.50' }).expect(201)).body;
      expect(next).toMatchObject({ serviceFee: '150', governmentFeeEstimate: '20.5', thirdPartyFeeEstimate: '0', branchId: null, isActive: true, validTo: null, currency: 'AED' });
      await t.as(alpha.owner).post(`/services/${service.id}/prices`, { serviceFee: '175' }).expect(201);

      const history = (await t.as(alpha.owner).get(`/services/${service.id}/prices`).expect(200)).body;
      expect(history.map((p: any) => [p.serviceFee, p.isActive, p.validTo === null])).toEqual([['175', true, true], ['150', false, false], ['100', false, false]]);
      expect(new Date(history[1].validTo).getTime()).toBe(new Date(history[0].validFrom).getTime());
      expect(await t.sys.servicePrice.count({ where: { serviceId: service.id, branchId: null, isActive: true } })).toBe(1);
      const logs = await audit(alpha.id, 'service_price.set', service.id);
      expect(logs).toHaveLength(2);
      expect(logs[1]).toMatchObject({ before: { serviceFee: '150' }, after: { serviceFee: '175' } });

      // The default price can be replaced but never removed.
      const active = history[0];
      expect((await t.as(alpha.owner).delete(`/services/${service.id}/prices/${active.id}`).expect(409)).body.code).toBe('DEFAULT_PRICE_REQUIRED');
      expect((await t.as(alpha.owner).delete(`/services/${service.id}/prices/${history[1].id}`).expect(409)).body.code).toBe('PRICE_ALREADY_ENDED');
    });

    it('concurrent price changes still leave exactly one active default price', async () => {
      const service = await createService(t, alpha);
      const results = await Promise.all(['11', '12', '13', '14'].map((fee) => t.as(alpha.owner).post(`/services/${service.id}/prices`, { serviceFee: fee })));
      expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201]);
      expect(await t.sys.servicePrice.count({ where: { serviceId: service.id, branchId: null, isActive: true } })).toBe(1);
      expect(await t.sys.servicePrice.count({ where: { serviceId: service.id } })).toBe(5);
    });

    it('resolves the effective price: branch price > default price', async () => {
      const second = (await t.as(alpha.owner).post('/branches', { code: `P${uniq().slice(-5).toUpperCase()}`, name: 'Price branch' }).expect(201)).body;
      const service = await createService(t, alpha, { price: { serviceFee: '100', governmentFeeEstimate: '350', thirdPartyFeeEstimate: '50' } });
      const branchPrice = (await t.as(alpha.owner).post(`/services/${service.id}/prices`, { branchId: second.id, serviceFee: '80', governmentFeeEstimate: '350', thirdPartyFeeEstimate: '40' }).expect(201)).body;

      const base = (await t.as(alpha.owner).get(`/services/${service.id}/price`).expect(200)).body;
      expect(base).toMatchObject({
        serviceId: service.id, source: 'DEFAULT', branchId: null, corporateAccountId: null, currency: 'AED',
        serviceFee: '100.00', serviceFeeSource: 'CATALOGUE', governmentFeeEstimate: '350.00', thirdPartyFeeEstimate: '50.00',
        taxMode: 'SERVICE_FEE_ONLY', taxRatePercent: '5.00', subtotal: '500.00', taxableAmount: '100.00', taxAmount: '5.00', total: '505.00',
        paymentPolicy: 'BEFORE_PROCESSING', dueBeforeProcessing: '505.00', containsEstimates: true,
      });
      expect(base.components).toHaveLength(3);
      const head = (await t.as(alpha.owner).get(`/services/${service.id}/price?branchId=${alpha.headOfficeId}`).expect(200)).body;
      expect(head).toMatchObject({ source: 'DEFAULT', branchId: alpha.headOfficeId, total: '505.00' });
      const atBranch = (await t.as(alpha.owner).get(`/services/${service.id}/price?branchId=${second.id}`).expect(200)).body;
      expect(atBranch).toMatchObject({ source: 'BRANCH', priceId: branchPrice.id, serviceFee: '80.00', thirdPartyFeeEstimate: '40.00', taxAmount: '4.00', total: '474.00' });

      // Ending the branch price falls back to the default.
      await t.as(alpha.owner).delete(`/services/${service.id}/prices/${branchPrice.id}`).expect(200);
      expect((await t.as(alpha.owner).get(`/services/${service.id}/price?branchId=${second.id}`)).body).toMatchObject({ source: 'DEFAULT', total: '505.00' });
    });

    it('a corporate contract price overrides only the service fee', async () => {
      const service = await createService(t, alpha, { price: { serviceFee: '100', governmentFeeEstimate: '350', thirdPartyFeeEstimate: '50' } });
      const company = await createCorporateAccount(t, alpha);
      const other = await createCorporateAccount(t, alpha);
      await t.sys.corporatePrice.create({ data: { tenantId: alpha.id, corporateAccountId: company.id, serviceId: service.id, serviceFee: '70' } });
      const priced = (await t.as(alpha.owner).get(`/services/${service.id}/price?corporateAccountId=${company.id}`).expect(200)).body;
      expect(priced).toMatchObject({
        corporateAccountId: company.id, serviceFee: '70.00', listServiceFee: '100.00', serviceFeeSource: 'CORPORATE_CONTRACT',
        governmentFeeEstimate: '350.00', thirdPartyFeeEstimate: '50.00', taxAmount: '3.50', total: '473.50',
      });
      // A company without a contract price for this service pays the catalogue fee.
      expect((await t.as(alpha.owner).get(`/services/${service.id}/price?corporateAccountId=${other.id}`)).body).toMatchObject({ serviceFee: '100.00', serviceFeeSource: 'CATALOGUE', total: '505.00' });
    });

    it('computes tax from the service tax mode and the centre\'s tax rate', async () => {
      const gamma = await t.createTenant();
      await t.as(gamma.owner).patch('/tenant', { taxRatePercent: 7.5 }).expect(200);
      const price = { serviceFee: '199.99', governmentFeeEstimate: '10.01', thirdPartyFeeEstimate: '0.33' };
      const feeOnly = await createService(t, gamma, { price, taxMode: 'SERVICE_FEE_ONLY' });
      const everything = await createService(t, gamma, { price, taxMode: 'ALL_COMPONENTS', paymentPolicy: 'DEPOSIT', depositPercent: 30 });
      const none = await createService(t, gamma, { price, taxMode: 'NONE', paymentPolicy: 'AFTER_COMPLETION' });
      expect((await t.as(gamma.owner).get(`/services/${feeOnly.id}/price`)).body).toMatchObject({ taxRatePercent: '7.50', taxableAmount: '199.99', taxAmount: '15.00', total: '225.33' });
      // Per component, rounded half-up: 15.00 + 0.75 + 0.02
      expect((await t.as(gamma.owner).get(`/services/${everything.id}/price`)).body).toMatchObject({ taxableAmount: '210.33', taxAmount: '15.77', total: '226.10', depositPercent: '30.00', dueBeforeProcessing: '67.83' });
      expect((await t.as(gamma.owner).get(`/services/${none.id}/price`)).body).toMatchObject({ taxAmount: '0.00', total: '210.33', dueBeforeProcessing: '0.00' });
    });

    it('validates branch prices and reports a missing price clearly', async () => {
      const second = (await t.as(alpha.owner).post('/branches', { code: `V${uniq().slice(-5).toUpperCase()}`, name: 'Other branch' }).expect(201)).body;
      const headOnly = await createService(t, alpha, { allBranches: false, branchIds: [alpha.headOfficeId] });
      expect((await t.as(alpha.owner).post(`/services/${headOnly.id}/prices`, { branchId: second.id, serviceFee: '10' }).expect(422)).body.code).toBe('SERVICE_NOT_AT_BRANCH');
      expect((await t.as(alpha.owner).get(`/services/${headOnly.id}/price?branchId=${second.id}`).expect(422)).body.code).toBe('SERVICE_NOT_AT_BRANCH');
      await t.as(alpha.owner).post(`/services/${headOnly.id}/prices`, { serviceFee: '-1' }).expect(400);
      await t.as(alpha.owner).post(`/services/${headOnly.id}/prices`, { serviceFee: 'free' }).expect(400);
      await t.as(alpha.owner).post(`/services/${headOnly.id}/prices`, {}).expect(400);

      // A service created outside the API (e.g. an import) may have no price yet.
      const bare = await t.sys.service.create({ data: { tenantId: alpha.id, categoryId: typing, code: `BARE-${uniq()}`.toUpperCase(), name: 'No price yet' } });
      expect((await t.as(alpha.owner).get(`/services/${bare.id}/price`).expect(422)).body.code).toBe('PRICE_NOT_SET');
      expect((await t.as(alpha.owner).post(`/services/${bare.id}/prices`, { branchId: alpha.headOfficeId, serviceFee: '10' }).expect(422)).body.code).toBe('DEFAULT_PRICE_REQUIRED');
      expect((await t.as(alpha.owner).get(`/services/${bare.id}/full`).expect(200)).body.price).toBeNull();
    });
  });

  // ------------------------------------------------------------------ requirements
  describe('requirements (document checklist)', () => {
    it('adds, edits, reorders and removes checklist items', async () => {
      const service = await createService(t, alpha);
      const add = async (body: Record<string, unknown>) => (await t.as(alpha.owner).post(`/services/${service.id}/requirements`, body).expect(201)).body;
      const passport = await add({ documentTypeKey: 'passport', label: 'Passport copy', labelAr: 'نسخة جواز السفر' });
      const photo = await add({ documentTypeKey: 'photo', label: 'Photo', isMandatory: false, allowReuse: false, maxAgeDays: 180 });
      const eid = await add({ documentTypeKey: 'emirates_id', label: 'Emirates ID' });
      expect(passport).toMatchObject({ isMandatory: true, allowReuse: true, maxAgeDays: null, sortOrder: 0, serviceId: service.id });
      expect(photo).toMatchObject({ isMandatory: false, allowReuse: false, maxAgeDays: 180, sortOrder: 1 });

      const reordered = (await t.as(alpha.owner).put(`/services/${service.id}/requirements/order`, { ids: [eid.id, passport.id] }).expect(200)).body;
      expect(reordered.map((r: any) => r.id)).toEqual([eid.id, passport.id, photo.id]);
      expect((await t.as(alpha.owner).patch(`/services/${service.id}/requirements/${photo.id}`, { label: 'Recent photo', isMandatory: true }).expect(200)).body).toMatchObject({ label: 'Recent photo', isMandatory: true, documentTypeKey: 'photo' });
      await t.as(alpha.owner).delete(`/services/${service.id}/requirements/${passport.id}`).expect(200);
      expect((await t.as(alpha.owner).get(`/services/${service.id}/requirements`).expect(200)).body.map((r: any) => r.label)).toEqual(['Emirates ID', 'Recent photo']);
      expect((await audit(alpha.id, 'service_requirement.created', service.id)).length).toBe(3);
      expect((await audit(alpha.id, 'service_requirement.deleted', service.id)).length).toBe(1);
    });

    it('only accepts document type keys that are valid and active for this centre', async () => {
      const service = await createService(t, alpha);
      const betaKey = `beta_${uniq()}`.toLowerCase();
      await t.as(beta.owner).post('/document-types', { key: betaKey, name: 'Beta private type' }).expect(201);
      const unknown = await t.as(alpha.owner).post(`/services/${service.id}/requirements`, { documentTypeKey: betaKey, label: 'Should not work' }).expect(422);
      expect(unknown.body.code).toBe('UNKNOWN_DOCUMENT_TYPE');
      await t.as(alpha.owner).post(`/services/${service.id}/requirements`, { documentTypeKey: 'made_up', label: 'Nope' }).expect(422);

      const ownKey = `own_${uniq()}`.toLowerCase();
      const own = (await t.as(alpha.owner).post('/document-types', { key: ownKey, name: 'Own type' }).expect(201)).body;
      const item = (await t.as(alpha.owner).post(`/services/${service.id}/requirements`, { documentTypeKey: ownKey, label: 'Own' }).expect(201)).body;
      await t.as(alpha.owner).patch(`/document-types/${own.id}`, { isActive: false }).expect(200);
      expect((await t.as(alpha.owner).post(`/services/${service.id}/requirements`, { documentTypeKey: ownKey, label: 'Inactive' }).expect(422)).body.code).toBe('DOCUMENT_TYPE_INACTIVE');
      expect((await t.as(alpha.owner).patch(`/services/${service.id}/requirements/${item.id}`, { documentTypeKey: 'made_up' }).expect(422)).body.code).toBe('UNKNOWN_DOCUMENT_TYPE');
    });

    it('a requirement can only be reached through its own service', async () => {
      const one = await createService(t, alpha);
      const two = await createService(t, alpha);
      const item = (await t.as(alpha.owner).post(`/services/${one.id}/requirements`, { documentTypeKey: 'passport', label: 'Passport' }).expect(201)).body;
      await t.as(alpha.owner).patch(`/services/${two.id}/requirements/${item.id}`, { label: 'Moved' }).expect(404);
      await t.as(alpha.owner).delete(`/services/${two.id}/requirements/${item.id}`).expect(404);
      await t.as(alpha.owner).put(`/services/${two.id}/requirements/order`, { ids: [item.id] }).expect(404);
    });
  });

  // ------------------------------------------------------------------ dynamic forms
  describe('dynamic forms', () => {
    it('DRAFT -> PUBLISHED; publishing archives the previous version; published versions are immutable', async () => {
      const service = await createService(t, alpha);
      const base = `/services/${service.id}/forms`;
      const draft = (await t.as(alpha.owner).post(base, { schema: simpleForm() }).expect(201)).body;
      expect(draft).toMatchObject({ version: 1, status: 'DRAFT', publishedAt: null, createdById: alpha.owner.userId });
      expect((await t.as(alpha.owner).post(base, {}).expect(409)).body).toMatchObject({ code: 'DRAFT_EXISTS', details: { formId: draft.id, version: 1 } });

      // A draft can be edited freely.
      const edited = simpleForm();
      edited.steps[0].fields.push({ key: 'notes', label: 'Notes', type: 'textarea' } as any);
      expect((await t.as(alpha.owner).put(`${base}/${draft.id}`, { schema: edited }).expect(200)).body.schema.steps[0].fields).toHaveLength(4);
      expect((await t.as(alpha.owner).get(`/services/${service.id}/full`)).body.form).toBeNull();

      const v1 = (await t.as(alpha.owner).post(`${base}/${draft.id}/publish`).expect(200)).body;
      expect(v1).toMatchObject({ id: draft.id, version: 1, status: 'PUBLISHED' });
      expect(v1.publishedAt).not.toBeNull();
      expect((await t.as(alpha.owner).get(`/services/${service.id}/full`)).body.form).toMatchObject({ id: draft.id, version: 1 });

      // Immutable from now on.
      const frozen = await t.as(alpha.owner).put(`${base}/${draft.id}`, { schema: simpleForm() }).expect(409);
      expect(frozen.body.code).toBe('FORM_VERSION_IMMUTABLE');
      expect((await t.as(alpha.owner).delete(`${base}/${draft.id}`).expect(409)).body.code).toBe('FORM_VERSION_IMMUTABLE');
      expect((await t.as(alpha.owner).post(`${base}/${draft.id}/publish`).expect(409)).body.code).toBe('FORM_VERSION_IMMUTABLE');
      expect((await t.sys.serviceFormDefinition.findUniqueOrThrow({ where: { id: draft.id } })).schema).toMatchObject({ steps: [{ fields: expect.arrayContaining([expect.objectContaining({ key: 'notes' })]) }] });

      // Edit = new draft copied from the published version.
      const copy = (await t.as(alpha.owner).post(base, {}).expect(201)).body;
      expect(copy).toMatchObject({ version: 2, status: 'DRAFT' });
      expect(copy.schema).toEqual(v1.schema);
      const changed = simpleForm({});
      changed.steps[0].fields = changed.steps[0].fields.slice(0, 2);
      await t.as(alpha.owner).put(`${base}/${copy.id}`, { schema: changed }).expect(200);
      // The live form is untouched while the draft is edited.
      expect((await t.as(alpha.owner).get(`/services/${service.id}/full`)).body.form).toMatchObject({ version: 1 });

      await t.as(alpha.owner).post(`${base}/${copy.id}/publish`).expect(200);
      const versions = (await t.as(alpha.owner).get(base).expect(200)).body;
      expect(versions.map((v: any) => [v.version, v.status, v.fields])).toEqual([[2, 'PUBLISHED', 2], [1, 'ARCHIVED', 4]]);
      expect(versions[0].schema).toBeUndefined();
      expect(await t.sys.serviceFormDefinition.count({ where: { serviceId: service.id, status: 'PUBLISHED' } })).toBe(1);
      expect((await t.as(alpha.owner).get(`/services/${service.id}/full`)).body.form).toMatchObject({ version: 2, id: copy.id });
      expect((await t.as(alpha.owner).put(`${base}/${draft.id}`, { schema: simpleForm() }).expect(409)).body.message).toMatch(/archived/);
      // The archived version stays readable for old requests.
      expect((await t.as(alpha.owner).get(`${base}/${draft.id}`).expect(200)).body).toMatchObject({ status: 'ARCHIVED', version: 1 });
      expect((await audit(alpha.id, 'service_form.published', service.id)).map((l: any) => l.after.version)).toEqual([1, 2]);
    });

    it('rejects invalid definitions with the path of each problem', async () => {
      const service = await createService(t, alpha);
      const post = (schema: unknown) => t.as(alpha.owner).post(`/services/${service.id}/forms`, { schema });
      const field = (over: Record<string, unknown>) => ({ key: 'a', label: 'A', type: 'text', ...over });
      const one = (...fields: unknown[]) => ({ steps: [{ key: 's', title: 'Step', fields }] });

      const duplicate = await post(one(field({}), field({}))).expect(400);
      expect(duplicate.body.code).toBe('VALIDATION_FAILED');
      expect(duplicate.body.details).toEqual([{ path: 'schema.steps.0.fields.1.key', message: 'Field key "a" is used more than once' }]);
      await post(one(field({ type: 'select' }))).expect(400);
      await post(one(field({ type: 'radio', options: [] }))).expect(400);
      await post(one(field({ key: 'b', showIf: { field: 'later', in: ['x'] } }), field({ key: 'later' }))).expect(400);
      await post(one(field({ prefillFrom: 'customer.passportNo' }))).expect(400);
      await post(one(field({ type: 'signature' }))).expect(400);
      await post(one(field({ pattern: '(' }))).expect(400);
      await post({ steps: 'nope' }).expect(400);
      expect(await t.sys.serviceFormDefinition.count({ where: { serviceId: service.id } })).toBe(0);
    });

    it('an empty draft cannot be published, a draft can be deleted, the published form can be withdrawn', async () => {
      const service = await createService(t, alpha);
      const base = `/services/${service.id}/forms`;
      const empty = (await t.as(alpha.owner).post(base, {}).expect(201)).body;
      expect(empty.schema).toEqual({ steps: [] });
      expect((await t.as(alpha.owner).post(`${base}/${empty.id}/publish`).expect(422)).body.code).toBe('FORM_EMPTY');
      expect((await t.as(alpha.owner).post(`${base}/${empty.id}/archive`).expect(409)).body.code).toBe('FORM_NOT_PUBLISHED');
      await t.as(alpha.owner).delete(`${base}/${empty.id}`).expect(200);
      await t.as(alpha.owner).get(`${base}/${empty.id}`).expect(404);

      const draft = (await t.as(alpha.owner).post(base, { schema: simpleForm() }).expect(201)).body;
      await t.as(alpha.owner).post(`${base}/${draft.id}/publish`).expect(200);
      expect((await t.as(alpha.owner).post(`${base}/${draft.id}/archive`).expect(200)).body.status).toBe('ARCHIVED');
      expect((await t.as(alpha.owner).get(`/services/${service.id}/full`)).body.form).toBeNull();
      // With nothing published, a new draft starts empty rather than from the archived version.
      expect((await t.as(alpha.owner).post(base, {}).expect(201)).body).toMatchObject({ version: 2, schema: { steps: [] } });
    });

    it('a form version can only be reached through its own service', async () => {
      const one = await createService(t, alpha);
      const two = await createService(t, alpha);
      const draft = (await t.as(alpha.owner).post(`/services/${one.id}/forms`, { schema: simpleForm() }).expect(201)).body;
      await t.as(alpha.owner).get(`/services/${two.id}/forms/${draft.id}`).expect(404);
      await t.as(alpha.owner).put(`/services/${two.id}/forms/${draft.id}`, { schema: simpleForm() }).expect(404);
      await t.as(alpha.owner).post(`/services/${two.id}/forms/${draft.id}/publish`).expect(404);
    });
  });

  // ------------------------------------------------------------------ /full (request wizard)
  it('GET /services/:id/full returns service, category, effective price, requirements and the published form', async () => {
    const service = await createService(t, alpha, { price: { serviceFee: '100', governmentFeeEstimate: '50' }, staffGroupRoleKey: 'operator' });
    await t.as(alpha.owner).post(`/services/${service.id}/requirements`, { documentTypeKey: 'passport', label: 'Passport' }).expect(201);
    const draft = (await t.as(alpha.owner).post(`/services/${service.id}/forms`, { schema: simpleForm() }).expect(201)).body;
    await t.as(alpha.owner).post(`/services/${service.id}/forms/${draft.id}/publish`).expect(200);
    const company = await createCorporateAccount(t, alpha);
    await t.sys.corporatePrice.create({ data: { tenantId: alpha.id, corporateAccountId: company.id, serviceId: service.id, serviceFee: '60' } });

    const full = (await t.as(receptionist).get(`/services/${service.id}/full?branchId=${alpha.headOfficeId}`).expect(200)).body;
    expect(full).toMatchObject({
      id: service.id, code: service.code, staffGroupRoleKey: 'operator', branchIds: [],
      category: { key: 'typing', name: 'Typing & Documentation' },
      price: { source: 'DEFAULT', branchId: alpha.headOfficeId, serviceFee: '100.00', taxAmount: '5.00', total: '155.00' },
      requirements: [{ documentTypeKey: 'passport', label: 'Passport', isMandatory: true }],
      form: { id: draft.id, version: 1, schema: { steps: [{ key: 'details' }] } },
    });
    const corporate = (await t.as(receptionist).get(`/services/${service.id}/full?corporateAccountId=${company.id}`).expect(200)).body;
    expect(corporate.price).toMatchObject({ serviceFee: '60.00', serviceFeeSource: 'CORPORATE_CONTRACT', total: '113.00' });
    await t.as(receptionist).get(`/services/${service.id}/full?branchId=${beta.headOfficeId}`).expect(404);
    const betaCompany = await createCorporateAccount(t, beta);
    await t.as(receptionist).get(`/services/${service.id}/full?corporateAccountId=${betaCompany.id}`).expect(404);
  });

  // ------------------------------------------------------------------ permissions
  describe('permissions', () => {
    it('a receptionist can read the catalogue but not change it', async () => {
      const service = await createService(t, alpha);
      const draft = (await t.as(alpha.owner).post(`/services/${service.id}/forms`, { schema: simpleForm() }).expect(201)).body;
      await t.as(receptionist).get('/services').expect(200);
      await t.as(receptionist).get(`/services/${service.id}`).expect(200);
      await t.as(receptionist).get(`/services/${service.id}/price`).expect(200);
      await t.as(receptionist).get(`/services/${service.id}/prices`).expect(200);
      await t.as(receptionist).get(`/services/${service.id}/requirements`).expect(200);
      await t.as(receptionist).get(`/services/${service.id}/forms`).expect(200);
      await t.as(receptionist).get('/service-categories').expect(200);

      await t.as(receptionist).post('/services', serviceBody(typing)).expect(403);
      await t.as(receptionist).patch(`/services/${service.id}`, { name: 'Nope' }).expect(403);
      await t.as(receptionist).delete(`/services/${service.id}`).expect(403);
      await t.as(receptionist).post(`/services/${service.id}/restore`).expect(403);
      await t.as(receptionist).put('/services/order', { ids: [service.id] }).expect(403);
      await t.as(receptionist).post('/services/starter-catalogue').expect(403);
      await t.as(receptionist).post(`/services/${service.id}/prices`, { serviceFee: '1' }).expect(403);
      await t.as(receptionist).post(`/services/${service.id}/requirements`, { documentTypeKey: 'passport', label: 'Passport' }).expect(403);
      await t.as(receptionist).post(`/services/${service.id}/forms`, {}).expect(403);
      await t.as(receptionist).put(`/services/${service.id}/forms/${draft.id}`, { schema: simpleForm() }).expect(403);
      await t.as(receptionist).post(`/services/${service.id}/forms/${draft.id}/publish`).expect(403);
      await t.as(receptionist).post('/service-categories', { name: 'Nope' }).expect(403);
      await t.as(receptionist).put('/service-categories/order', { ids: [typing] }).expect(403);
      await t.as(receptionist).patch(`/service-categories/${typing}`, { name: 'Nope' }).expect(403);
      await t.as(receptionist).delete(`/service-categories/${typing}`).expect(403);
    });

    it('customers cannot use the staff catalogue endpoints at all', async () => {
      const service = await createService(t, alpha);
      await t.as(customer).get('/services').expect(403);
      await t.as(customer).get(`/services/${service.id}`).expect(403);
      await t.as(customer).get(`/services/${service.id}/full`).expect(403);
      await t.as(customer).get(`/services/${service.id}/price`).expect(403);
      await t.as(customer).get('/service-categories').expect(403);
      await t.as(customer).post('/services', serviceBody(typing)).expect(403);
      await t.as(null).get('/services').expect(401);
      await t.as(null).get('/catalogue').expect(401);
    });
  });

  // ------------------------------------------------------------------ tenant isolation
  describe('tenant isolation', () => {
    it('centre A cannot read, change or reference anything of centre B', async () => {
      const betaService = await createService(t, beta, { name: 'Beta secret service' });
      const betaRequirement = (await t.as(beta.owner).post(`/services/${betaService.id}/requirements`, { documentTypeKey: 'passport', label: 'Beta passport' }).expect(201)).body;
      const betaForm = (await t.as(beta.owner).post(`/services/${betaService.id}/forms`, { schema: simpleForm() }).expect(201)).body;
      const betaPrice = (await t.as(beta.owner).get(`/services/${betaService.id}/prices`)).body[0];
      const betaCategory = await categoryId(t, beta);
      const betaWorkflow = await t.sys.workflowDefinition.create({ data: { tenantId: beta.id, key: `wf-${uniq()}`, name: 'Beta flow' } });
      const a = t.as(alpha.owner);
      const own = await createService(t, alpha);

      // Reads
      expect((await a.get('/services?pageSize=100')).body.data.every((s: any) => s.tenantId === alpha.id)).toBe(true);
      expect((await a.get('/services?q=Beta secret')).body.data).toEqual([]);
      for (const path of ['', '/full', '/price', '/prices', '/requirements', '/forms', `/forms/${betaForm.id}`]) await a.get(`/services/${betaService.id}${path}`).expect(404);
      expect((await a.get('/service-categories?includeInactive=true')).body.every((c: any) => c.tenantId === alpha.id)).toBe(true);

      // Writes
      await a.patch(`/services/${betaService.id}`, { name: 'Hijacked' }).expect(404);
      await a.delete(`/services/${betaService.id}`).expect(404);
      await a.post(`/services/${betaService.id}/restore`).expect(404);
      await a.post(`/services/${betaService.id}/prices`, { serviceFee: '1' }).expect(404);
      await a.delete(`/services/${betaService.id}/prices/${betaPrice.id}`).expect(404);
      await a.delete(`/services/${own.id}/prices/${betaPrice.id}`).expect(404);
      await a.post(`/services/${betaService.id}/requirements`, { documentTypeKey: 'passport', label: 'Hijack' }).expect(404);
      await a.patch(`/services/${own.id}/requirements/${betaRequirement.id}`, { label: 'Hijack' }).expect(404);
      await a.delete(`/services/${own.id}/requirements/${betaRequirement.id}`).expect(404);
      await a.post(`/services/${betaService.id}/forms`, {}).expect(404);
      await a.put(`/services/${own.id}/forms/${betaForm.id}`, { schema: simpleForm() }).expect(404);
      await a.post(`/services/${own.id}/forms/${betaForm.id}/publish`).expect(404);
      await a.patch(`/service-categories/${betaCategory}`, { name: 'Hijacked' }).expect(404);
      await a.delete(`/service-categories/${betaCategory}`).expect(404);

      // References to B's rows from A's records
      await a.post('/services', serviceBody(betaCategory)).expect(404);
      await a.post('/services', serviceBody(typing, { workflowDefinitionId: betaWorkflow.id })).expect(404);
      await a.post('/services', serviceBody(typing, { allBranches: false, branchIds: [beta.headOfficeId] })).expect(404);
      await a.patch(`/services/${own.id}`, { categoryId: betaCategory }).expect(404);
      await a.patch(`/services/${own.id}`, { workflowDefinitionId: betaWorkflow.id }).expect(404);
      await a.patch(`/services/${own.id}`, { allBranches: false, branchIds: [beta.headOfficeId] }).expect(404);
      await a.post(`/services/${own.id}/prices`, { branchId: beta.headOfficeId, serviceFee: '1' }).expect(404);
      await a.get(`/services/${own.id}/price?branchId=${beta.headOfficeId}`).expect(404);

      // Nothing of B changed.
      const still = await t.sys.service.findUniqueOrThrow({ where: { id: betaService.id }, include: { servicePrices: true, serviceRequirements: true, serviceFormDefinitions: true } });
      expect(still).toMatchObject({ name: 'Beta secret service', deletedAt: null, categoryId: betaCategory });
      expect(still.servicePrices).toHaveLength(1);
      expect(still.serviceRequirements[0].label).toBe('Beta passport');
      expect(still.serviceFormDefinitions[0].status).toBe('DRAFT');
      expect((await t.sys.serviceCategory.findUniqueOrThrow({ where: { id: betaCategory } })).name).toBe('Typing & Documentation');
    });
  });

  // ------------------------------------------------------------------ portal catalogue (signed-in customers / corporate users)
  describe('GET /catalogue (signed-in customers and corporate users)', () => {
    let gamma: TenantFixture;
    let gammaCustomer: Actor;
    let company: { id: string };
    let corporateUser: Actor;
    let otherCorporateUser: Actor;
    let open: any, staffOnly: any, hidden: any, inactive: any, corporateOnly: any, deleted: any;

    beforeAll(async () => {
      gamma = await t.createTenant({ name: 'Gamma Typing' });
      gammaCustomer = await t.addCustomer(gamma);
      company = await createCorporateAccount(t, gamma, 'Falcon Trading LLC');
      const otherCompany = await createCorporateAccount(t, gamma, 'Oryx Logistics LLC');
      corporateUser = await addCorporateUser(t, gamma, company.id);
      otherCorporateUser = await addCorporateUser(t, gamma, otherCompany.id);
      open = await createService(t, gamma, { name: 'Open service', staffGroupRoleKey: 'operator', price: { serviceFee: '100', governmentFeeEstimate: '20' } });
      staffOnly = await createService(t, gamma, { name: 'Walk-in only', onlineAvailable: false });
      hidden = await createService(t, gamma, { name: 'Not public', isPublic: false });
      inactive = await createService(t, gamma, { name: 'Switched off', isActive: false });
      corporateOnly = await createService(t, gamma, { name: 'Contract-only service', isPublic: false, price: { serviceFee: '200' } });
      deleted = await createService(t, gamma, { name: 'Deleted service' });
      await t.as(gamma.owner).delete(`/services/${deleted.id}`).expect(200);
      await t.sys.corporatePrice.createMany({
        data: [
          { tenantId: gamma.id, corporateAccountId: company.id, serviceId: corporateOnly.id, serviceFee: '150' },
          { tenantId: gamma.id, corporateAccountId: company.id, serviceId: open.id, serviceFee: '80' },
        ],
      });
      await t.as(gamma.owner).post(`/services/${open.id}/requirements`, { documentTypeKey: 'passport', label: 'Passport copy' }).expect(201);
      const draft = (await t.as(gamma.owner).post(`/services/${open.id}/forms`, { schema: simpleForm() }).expect(201)).body;
      await t.as(gamma.owner).post(`/services/${open.id}/forms/${draft.id}/publish`).expect(200);
    });

    it('customers see active, online, public services with the catalogue price and nothing internal', async () => {
      const res = await t.as(gammaCustomer).get('/catalogue').expect(200);
      expect(res.body.services.map((s: any) => s.id)).toEqual([open.id]);
      expect(res.body.categories).toEqual([{ key: 'typing', name: 'Typing & Documentation', nameAr: expect.any(String), icon: 'file-text', serviceCount: 1 }]);
      const item = res.body.services[0];
      expect(item).toMatchObject({ name: 'Open service', category: { key: 'typing' }, complianceCapability: 'DOCUMENT_PREPARATION_ONLY', price: { serviceFee: '100.00', serviceFeeSource: 'CATALOGUE', total: '125.00' } });
      for (const internal of ['code', 'staffGroupRoleKey', 'workflowDefinitionId', 'requiresApproval', 'version', 'tenantId', 'sortOrder', 'isPublic']) expect(item).not.toHaveProperty(internal);

      const detail = (await t.as(gammaCustomer).get(`/catalogue/${open.id}`).expect(200)).body;
      expect(detail).toMatchObject({ id: open.id, requirements: [{ documentTypeKey: 'passport', label: 'Passport copy', isMandatory: true }], form: { version: 1, schema: { steps: [{ key: 'details' }] } } });
      expect(detail).not.toHaveProperty('code');
      for (const s of [staffOnly, hidden, inactive, corporateOnly, deleted]) await t.as(gammaCustomer).get(`/catalogue/${s.id}`).expect(404);
    });

    it('corporate users also see non-public services their company has a contract for, at the contract price', async () => {
      const res = await t.as(corporateUser).get('/catalogue').expect(200);
      expect(res.body.services.map((s: any) => s.name).sort()).toEqual(['Contract-only service', 'Open service']);
      const byName = Object.fromEntries(res.body.services.map((s: any) => [s.name, s]));
      expect(byName['Open service'].price).toMatchObject({ serviceFee: '80.00', listServiceFee: '100.00', serviceFeeSource: 'CORPORATE_CONTRACT', governmentFeeEstimate: '20.00', total: '104.00' });
      expect(byName['Contract-only service'].price).toMatchObject({ serviceFee: '150.00', serviceFeeSource: 'CORPORATE_CONTRACT' });
      expect((await t.as(corporateUser).get(`/catalogue/${corporateOnly.id}`).expect(200)).body.price.serviceFee).toBe('150.00');

      // Another company in the same centre gets neither the hidden service nor the contract price.
      const other = await t.as(otherCorporateUser).get('/catalogue').expect(200);
      expect(other.body.services.map((s: any) => s.id)).toEqual([open.id]);
      expect(other.body.services[0].price).toMatchObject({ serviceFee: '100.00', serviceFeeSource: 'CATALOGUE' });
      await t.as(otherCorporateUser).get(`/catalogue/${corporateOnly.id}`).expect(404);
    });

    it('filters by category, text and branch; services of an inactive category disappear', async () => {
      expect((await t.as(gammaCustomer).get('/catalogue?categoryKey=visa')).body.services).toEqual([]);
      expect((await t.as(gammaCustomer).get('/catalogue?q=open')).body.services).toHaveLength(1);
      expect((await t.as(gammaCustomer).get('/catalogue?q=zzz')).body.services).toEqual([]);
      const second = (await t.as(gamma.owner).post('/branches', { code: 'G2', name: 'Gamma two' }).expect(201)).body;
      await t.as(gamma.owner).patch(`/services/${open.id}`, { allBranches: false, branchIds: [gamma.headOfficeId] }).expect(200);
      expect((await t.as(gammaCustomer).get(`/catalogue?branchId=${gamma.headOfficeId}`)).body.services).toHaveLength(1);
      expect((await t.as(gammaCustomer).get(`/catalogue?branchId=${second.id}`)).body.services).toEqual([]);
      await t.as(gammaCustomer).get(`/catalogue/${open.id}?branchId=${second.id}`).expect(404);
      await t.as(gammaCustomer).get(`/catalogue?branchId=${alpha.headOfficeId}`).expect(404);
      await t.as(gamma.owner).patch(`/services/${open.id}`, { allBranches: true }).expect(200);

      const cat = await categoryId(t, gamma);
      await t.as(gamma.owner).patch(`/service-categories/${cat}`, { isActive: false }).expect(200);
      expect((await t.as(gammaCustomer).get('/catalogue')).body.services).toEqual([]);
      await t.as(gamma.owner).patch(`/service-categories/${cat}`, { isActive: true }).expect(200);
    });

    it('is scoped to the centre of the session and closed to staff', async () => {
      // Alpha's customer sees Alpha's catalogue, never Gamma's services.
      const alphaView = await t.as(customer).get('/catalogue').expect(200);
      expect(alphaView.body.services.some((s: any) => s.id === open.id)).toBe(false);
      await t.as(customer).get(`/catalogue/${open.id}`).expect(404);
      await t.as(gamma.owner).get('/catalogue').expect(403);
    });
  });

  // ------------------------------------------------------------------ public catalogue
  describe('public catalogue (no sign-in)', () => {
    let delta: TenantFixture;
    let shown: any, internal: any;

    beforeAll(async () => {
      delta = await t.createTenant({ name: 'Delta Typing' });
      shown = await createService(t, delta, {
        name: 'Visa application typing (document preparation)', description: 'We prepare the form.', eligibilityGuidance: 'Decided by the authority.', estimatedProcessingHours: 24,
        staffGroupRoleKey: 'operator', requiresApproval: true, price: { serviceFee: '120', governmentFeeEstimate: '350', thirdPartyFeeEstimate: '30' },
      });
      await t.as(delta.owner).post(`/services/${shown.id}/requirements`, { documentTypeKey: 'passport', label: 'Passport copy', description: 'Valid 6 months' }).expect(201);
      await t.as(delta.owner).post(`/services/${shown.id}/requirements`, { documentTypeKey: 'photo', label: 'Photo', isMandatory: false }).expect(201);
      internal = await createService(t, delta, { name: 'Internal only', isPublic: false });
      await createService(t, delta, { name: 'Inactive public', isActive: false });
    });

    it('lists only public + active services with estimates and nothing internal', async () => {
      const res = await t.as(null).get(`/public/services?slug=${delta.slug}`).expect(200);
      expect(res.body.centre).toEqual({ slug: delta.slug, name: 'Delta Typing', currency: 'AED' });
      expect(res.body.services).toHaveLength(1);
      expect(res.body.services[0]).toEqual({
        id: shown.id,
        name: 'Visa application typing (document preparation)',
        nameAr: 'طباعة عقد الإيجار',
        description: 'We prepare the form.',
        descriptionAr: null,
        eligibilityGuidance: 'Decided by the authority.',
        category: { key: 'typing', name: 'Typing & Documentation', nameAr: expect.any(String), icon: 'file-text' },
        complianceCapability: 'DOCUMENT_PREPARATION_ONLY',
        estimatedProcessingHours: 24,
        onlineAvailable: true,
        requiredDocuments: [
          { label: 'Passport copy', labelAr: null, description: 'Valid 6 months', isMandatory: true },
          { label: 'Photo', labelAr: null, description: null, isMandatory: false },
        ],
        feeEstimate: { currency: 'AED', serviceFee: '120.00', governmentFeeEstimate: '350.00', thirdPartyFeeEstimate: '30.00', taxEstimate: '6.00', totalEstimate: '506.00', isEstimate: true },
      });
      const raw = JSON.stringify(res.body);
      for (const secret of [shown.code, 'staffGroupRoleKey', 'workflowDefinitionId', 'requiresApproval', 'operator', delta.id, 'Internal only', 'Inactive public']) expect(raw).not.toContain(secret);

      const one = await t.as(null).get(`/public/services/${shown.id}?slug=${delta.slug}`).expect(200);
      expect(one.body.service).toEqual(res.body.services[0]);
      await t.as(null).get(`/public/services/${internal.id}?slug=${delta.slug}`).expect(404);
      expect((await t.as(null).get(`/public/services?slug=${delta.slug}&q=visa`)).body.services).toHaveLength(1);
      expect((await t.as(null).get(`/public/services?slug=${delta.slug}&categoryKey=printing`)).body.services).toEqual([]);
    });

    it('resolves the centre from the portal host when no slug is given', async () => {
      const res = await t.http.get('/api/v1/public/services').set('x-tenant-host', `${delta.slug}.typease.test`).expect(200);
      expect(res.body.centre.slug).toBe(delta.slug);
      await t.http.get('/api/v1/public/services').expect(404);
      await t.http.get('/api/v1/public/services?slug=no-such-centre').expect(404);
    });

    it('a service of one centre is never served under another centre\'s slug', async () => {
      await t.as(null).get(`/public/services/${shown.id}?slug=${alpha.slug}`).expect(404);
      // A signed-in user of another centre gets the same public view, not their own tenant's data.
      const res = await t.as(alpha.owner).get(`/public/services?slug=${delta.slug}`).expect(200);
      expect(res.body.centre.slug).toBe(delta.slug);
      expect(res.body.services.map((s: any) => s.id)).toEqual([shown.id]);
    });

    it('is switched off by the branding setting and for centres that are not open for business', async () => {
      await t.as(delta.owner).put('/branding', { publicCatalogueEnabled: false }).expect(200);
      await t.as(null).get(`/public/services?slug=${delta.slug}`).expect(404);
      await t.as(null).get(`/public/services/${shown.id}?slug=${delta.slug}`).expect(404);
      await t.as(delta.owner).put('/branding', { publicCatalogueEnabled: true }).expect(200);
      await t.as(null).get(`/public/services?slug=${delta.slug}`).expect(200);

      for (const status of ['ONBOARDING', 'PENDING_APPROVAL', 'SUSPENDED', 'CANCELLED', 'ARCHIVED'] as const) {
        await t.sys.tenant.update({ where: { id: delta.id }, data: { status } });
        await t.as(null).get(`/public/services?slug=${delta.slug}`).expect(404);
      }
      for (const status of ['TRIAL', 'PAST_DUE', 'ACTIVE'] as const) {
        await t.sys.tenant.update({ where: { id: delta.id }, data: { status } });
        await t.as(null).get(`/public/services?slug=${delta.slug}`).expect(200);
      }
    });
  });

  // ------------------------------------------------------------------ starter catalogue
  describe('starter catalogue', () => {
    it('installs once, is idempotent and never overwrites what the centre changed', async () => {
      const epsilon = await t.createTenant({ name: 'Epsilon Typing' });
      expect((await t.as(epsilon.owner).get('/services')).body.meta.total).toBe(0);

      const first = (await t.as(epsilon.owner).post('/services/starter-catalogue').expect(200)).body;
      expect(first).toMatchObject({ createdCount: STARTER_SERVICES.length, skippedCount: 0 });
      const list = (await t.as(epsilon.owner).get('/services?pageSize=100').expect(200)).body;
      expect(list.meta.total).toBe(STARTER_SERVICES.length);
      expect(list.data.map((s: any) => s.name)).toEqual(expect.arrayContaining(['Tenancy contract typing', 'Visa application typing (document preparation)', 'Emirates ID application typing (document preparation)', 'Document translation coordination', 'Photocopy & scanning']));
      expect(list.data.every((s: any) => ['DOCUMENT_PREPARATION_ONLY', 'INFORMATIONAL_ONLY'].includes(s.complianceCapability))).toBe(true);
      expect(list.data.every((s: any) => s.price && s.price.currency === 'AED')).toBe(true);
      expect(new Set(list.data.map((s: any) => s.category.key)).size).toBeGreaterThanOrEqual(10);

      const visa = list.data.find((s: any) => s.code === 'ST-VISA-TYPING');
      const full = (await t.as(epsilon.owner).get(`/services/${visa.id}/full`).expect(200)).body;
      expect(full.requirements.map((r: any) => r.documentTypeKey)).toEqual(['passport', 'photo', 'residence_visa']);
      expect(full.form).toMatchObject({ version: 1 });
      expect(full.price).toMatchObject({ serviceFee: '120.00', governmentFeeEstimate: '350.00', total: '476.00' });
      // Every installed form really is the published one.
      const withForm = STARTER_SERVICES.filter((s) => s.form).length;
      expect(await t.sys.serviceFormDefinition.count({ where: { tenantId: epsilon.id, status: 'PUBLISHED' } })).toBe(withForm);

      // The centre edits one service and deletes another, then runs it again.
      await t.as(epsilon.owner).patch(`/services/${visa.id}`, { name: 'Visa typing (our wording)' }).expect(200);
      await t.as(epsilon.owner).post(`/services/${visa.id}/prices`, { serviceFee: '95' }).expect(201);
      const copy = list.data.find((s: any) => s.code === 'ST-COPY-SCAN');
      await t.as(epsilon.owner).delete(`/services/${copy.id}`).expect(200);
      const second = (await t.as(epsilon.owner).post('/services/starter-catalogue').expect(200)).body;
      expect(second).toMatchObject({ createdCount: 0, skippedCount: STARTER_SERVICES.length });
      expect(await t.sys.service.count({ where: { tenantId: epsilon.id } })).toBe(STARTER_SERVICES.length);
      expect(await t.sys.servicePrice.count({ where: { tenantId: epsilon.id, isActive: true } })).toBe(STARTER_SERVICES.length);
      expect((await t.as(epsilon.owner).get(`/services/${visa.id}/price`)).body).toMatchObject({ serviceFee: '95.00' });
      expect((await t.sys.service.findUniqueOrThrow({ where: { id: visa.id } })).name).toBe('Visa typing (our wording)');
      expect((await t.sys.service.findUniqueOrThrow({ where: { id: copy.id } })).deletedAt).not.toBeNull();
      expect((await audit(epsilon.id, 'service.starter_catalogue_installed')).length).toBe(2);

      // It shows up in the public catalogue with estimates (the non-public corporate service does not).
      const pub = (await t.as(null).get(`/public/services?slug=${epsilon.slug}`).expect(200)).body;
      expect(pub.services.length).toBe(STARTER_SERVICES.filter((s) => s.isPublic !== false).length - 1);
      expect(pub.services.every((s: any) => s.feeEstimate.isEstimate === true)).toBe(true);
    });

    it('is never installed automatically and can run inside any tenant transaction', async () => {
      const zeta = await t.createTenant();
      expect(await t.sys.service.count({ where: { tenantId: zeta.id } })).toBe(0);
      // A removed default category is put back rather than guessed.
      const printing = await t.sys.serviceCategory.findFirstOrThrow({ where: { tenantId: zeta.id, key: 'printing' } });
      await t.sys.serviceCategory.delete({ where: { id: printing.id } });
      const result = await t.inTenant(zeta.id, () => t.db.tx((tx) => installStarterCatalogue(tx, zeta.id)));
      expect(result.created).toHaveLength(STARTER_SERVICES.length);
      expect(await t.sys.serviceCategory.count({ where: { tenantId: zeta.id, key: 'printing' } })).toBe(1);
      // Nothing leaked into another centre.
      expect(await t.sys.service.count({ where: { tenantId: beta.id, code: { startsWith: 'ST-' } } })).toBe(0);
    });
  });
});
