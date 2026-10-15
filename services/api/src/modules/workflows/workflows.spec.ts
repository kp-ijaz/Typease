import { WORKFLOW_FACTS } from '@typease/types';
import { Actor, TenantFixture, TestApp, uniq } from '../../../test/helpers';
import { WorkflowsService } from './workflows.service';

describe('Workflows: definitions, versions and the builder', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let manager: Actor;
  let receptionist: Actor;

  beforeAll(async () => {
    t = await TestApp.create();
    alpha = await t.createTenant({ name: 'Alpha Typing' });
    beta = await t.createTenant({ name: 'Beta Typing' });
    manager = await t.addStaff(alpha, 'manager');
    receptionist = await t.addStaff(alpha, 'receptionist');
  });
  afterAll(() => t.close());

  const step = (key: string, type: string, extra: object = {}) => ({ key, name: `Step ${key}`, type, ...extra });
  const minimal = () => [step('task', 'STAFF_TASK'), step('done', 'COMPLETION')];
  const strip = (steps: any[]) => steps.map(({ id: _id, position: _position, ...s }) => s);
  const create = (actor: Actor, body: object) => t.as(actor).post('/workflows', { key: `wf-${uniq()}`, name: 'Test workflow', ...body });

  it('every centre starts with the three templates, each published as version 1, and "standard" as the default', async () => {
    const list = (await t.as(alpha.owner).get('/workflows').expect(200)).body;
    expect(list.map((d: any) => [d.key, d.templateKey, d.isDefault, d.archived, d.publishedVersion.version, d.draftVersion])).toEqual([
      ['pay-on-completion', 'pay-on-completion', false, false, 1, null],
      ['standard', 'standard', true, false, 1, null],
      ['walk-in-express', 'walk-in-express', false, false, 1, null],
    ]);
    expect(list.find((d: any) => d.key === 'standard').publishedVersion.stepCount).toBe(10);
    const standard = (await t.as(alpha.owner).get(`/workflows/${list.find((d: any) => d.key === 'standard').id}`).expect(200)).body;
    expect(standard.publishedVersion.steps.map((s: any) => [s.position, s.key, s.type])).toEqual([
      [1, 'form', 'CUSTOMER_FORM'], [2, 'documents', 'DOCUMENT_UPLOAD'], [3, 'verification', 'STAFF_VERIFICATION'], [4, 'quotation', 'QUOTATION'], [5, 'customer-approval', 'CUSTOMER_APPROVAL'],
      [6, 'payment', 'PAYMENT'], [7, 'prepare', 'STAFF_TASK'], [8, 'review', 'INTERNAL_APPROVAL'], [9, 'submission', 'EXTERNAL_PROCESSING'], [10, 'completion', 'COMPLETION'],
    ]);
    const review = standard.publishedVersion.steps.find((s: any) => s.key === 'review');
    expect(review).toMatchObject({ conditions: { all: [{ fact: 'service.requiresApproval', op: 'truthy' }] }, onRejectStepKey: 'prepare', assigneeRoleKey: 'reviewer', customerVisible: false });
    expect(standard.publishedVersion.steps.find((s: any) => s.key === 'prepare').name).toBe('Prepare application');
    const settings = (await t.sys.tenant.findUniqueOrThrow({ where: { id: alpha.id } })).settings as any;
    expect(settings.defaultWorkflowDefinitionId).toBe(standard.id);
  });

  it('provisioning can run again without duplicating or overwriting anything', async () => {
    const standard = await t.sys.workflowDefinition.findFirstOrThrow({ where: { tenantId: alpha.id, key: 'standard' } });
    // The centre customised its copy and chose another default.
    await t.as(alpha.owner).patch(`/workflows/${standard.id}`, { name: 'Our standard process' }).expect(200);
    const express = await t.sys.workflowDefinition.findFirstOrThrow({ where: { tenantId: alpha.id, key: 'walk-in-express' } });
    await t.as(alpha.owner).post(`/workflows/${express.id}/set-default`).expect(200);
    const before = { definitions: await t.sys.workflowDefinition.count({ where: { tenantId: alpha.id } }), versions: await t.sys.workflowVersion.count({ where: { tenantId: alpha.id } }), steps: await t.sys.workflowStep.count({ where: { tenantId: alpha.id } }) };
    const tenant = await t.sys.tenant.findUniqueOrThrow({ where: { id: alpha.id } });
    await t.sys.$transaction((tx) => t.get(WorkflowsService).installTemplates(tx, tenant));
    await t.sys.$transaction((tx) => t.get(WorkflowsService).installTemplates(tx, tenant));
    expect({ definitions: await t.sys.workflowDefinition.count({ where: { tenantId: alpha.id } }), versions: await t.sys.workflowVersion.count({ where: { tenantId: alpha.id } }), steps: await t.sys.workflowStep.count({ where: { tenantId: alpha.id } }) }).toEqual(before);
    expect((await t.sys.workflowDefinition.findUniqueOrThrow({ where: { id: standard.id } })).name).toBe('Our standard process');
    expect(((await t.sys.tenant.findUniqueOrThrow({ where: { id: alpha.id } })).settings as any).defaultWorkflowDefinitionId).toBe(express.id);
    await t.as(alpha.owner).post(`/workflows/${standard.id}/set-default`).expect(200);
    // A deleted template is restored by the next run.
    const gone = await t.sys.workflowDefinition.findFirstOrThrow({ where: { tenantId: alpha.id, key: 'pay-on-completion' } });
    await t.sys.workflowDefinition.delete({ where: { id: gone.id } });
    await t.sys.$transaction((tx) => t.get(WorkflowsService).installTemplates(tx, tenant));
    expect(await t.sys.workflowDefinition.count({ where: { tenantId: alpha.id, key: 'pay-on-completion' } })).toBe(1);
  });

  it('offers templates and builder metadata', async () => {
    const templates = (await t.as(manager).get('/workflows/templates').expect(200)).body;
    expect(templates.map((x: any) => x.key)).toEqual(['standard', 'walk-in-express', 'pay-on-completion']);
    const meta = (await t.as(manager).get('/workflows/builder-meta').expect(200)).body;
    expect(meta.facts).toEqual([...WORKFLOW_FACTS]);
    expect(meta.stepTypes.map((s: any) => s.type)).toEqual(expect.arrayContaining(['CUSTOMER_FORM', 'CONDITIONAL_BRANCH', 'COMPLETION']));
    expect(meta.stepTypes).toHaveLength(13);
    expect(meta.operators).toEqual(expect.arrayContaining(['eq', 'in', 'truthy']));
    expect(meta.roles.map((r: any) => r.key)).toEqual(expect.arrayContaining(['owner', 'manager', 'receptionist', 'operator', 'reviewer', 'accountant']));
    expect(meta.roles.map((r: any) => r.key)).not.toContain('customer');
    expect(meta.timeoutHours).toEqual({ min: 1, max: 2160 });
  });

  it('creates a workflow from a template or from scratch, as a draft unless published', async () => {
    const fromTemplate = (await create(manager, { templateKey: 'walk-in-express' }).expect(201)).body;
    expect(fromTemplate).toMatchObject({ templateKey: 'walk-in-express', versionStatus: 'DRAFT', publishedVersionId: null });
    const detail = (await t.as(manager).get(`/workflows/${fromTemplate.id}`).expect(200)).body;
    expect(detail.publishedVersion).toBeNull();
    expect(detail.draftVersion).toMatchObject({ version: 1, status: 'DRAFT' });
    expect(detail.draftVersion.steps).toHaveLength(7);

    const scratch = (await create(manager, { steps: minimal(), publish: true }).expect(201)).body;
    expect(scratch).toMatchObject({ templateKey: null, versionStatus: 'PUBLISHED' });
    expect(scratch.publishedVersionId).toBe(scratch.versionId);
    expect((await t.as(manager).get(`/workflows/${scratch.id}`).expect(200)).body.publishedVersion.steps.map((s: any) => [s.key, s.position])).toEqual([['task', 1], ['done', 2]]);

    // Shape errors are caught by validation, structural errors by the workflow validator - all at once.
    await create(manager, {}).expect(400);
    await create(manager, { templateKey: 'standard', steps: minimal() }).expect(400);
    await create(manager, { templateKey: 'no-such-template' }).expect(400);
    await create(manager, { steps: [{ key: 'Bad Key', name: 'x', type: 'STAFF_TASK' }] }).expect(400);
    await create(manager, { steps: [step('a', 'TELEPORT')] }).expect(400);
    const invalid = await create(manager, { steps: [step('pay', 'PAYMENT', { timeoutHours: 5000, assigneeRoleKey: 'wizard' }), step('done', 'COMPLETION')] }).expect(422);
    expect(invalid.body.code).toBe('WORKFLOW_INVALID');
    expect(invalid.body.message).toContain('This workflow cannot be saved yet:');
    expect(invalid.body.details.map((e: any) => e.code).sort()).toEqual(['COMPLETION_REQUIRES_STAFF_TASK', 'INVALID_TIMEOUT', 'PAYMENT_REQUIRES_QUOTATION', 'UNKNOWN_ROLE']);
    expect(invalid.body.details.find((e: any) => e.code === 'UNKNOWN_ROLE')).toMatchObject({ stepKey: 'pay', message: 'Step pay: the assignee role "wizard" is not a role of this centre.'.replace('Step pay', '"Step pay"') });
    const taken = await t.as(manager).post('/workflows', { key: 'standard', name: 'Another standard', steps: minimal() }).expect(409);
    expect(taken.body.code).toBe('DUPLICATE');
    // Nothing invalid was stored.
    expect(await t.sys.workflowDefinition.count({ where: { tenantId: alpha.id, name: 'Another standard' } })).toBe(0);
  });

  it('checks a list of steps without saving it', async () => {
    const ok = (await t.as(manager).post('/workflows/validate', { steps: minimal() }).expect(200)).body;
    expect(ok).toEqual({ valid: true, errors: [] });
    const bad = (await t.as(manager).post('/workflows/validate', { steps: [step('task', 'STAFF_TASK', { conditions: { all: [{ fact: 'customer.shoeSize', op: 'gt', value: 44 }] } })] }).expect(200)).body;
    expect(bad.valid).toBe(false);
    expect(bad.errors.map((e: any) => e.code).sort()).toEqual(['COMPLETION_COUNT', 'UNKNOWN_FACT']);
    expect((await t.as(manager).post('/workflows/validate', { steps: [] }).expect(200)).body.errors[0].code).toBe('NO_STEPS');
  });

  it('roles created by the centre can be used in steps; roles of other kinds or centres cannot', async () => {
    const roleKey = `senior_${uniq().slice(-6)}`;
    await t.as(alpha.owner).post('/roles', { key: roleKey, name: 'Senior typist', permissions: ['request.process', 'request.read.assigned'] }).expect(201);
    await create(manager, { steps: [step('task', 'STAFF_TASK', { assigneeRoleKey: roleKey, escalateToRoleKey: 'manager', timeoutHours: 8 }), step('done', 'COMPLETION')] }).expect(201);
    expect((await create(manager, { steps: [step('task', 'STAFF_TASK', { assigneeRoleKey: 'customer' }), step('done', 'COMPLETION')] }).expect(422)).body.details[0].code).toBe('UNKNOWN_ROLE');
    // The same custom role key does not exist in the other centre.
    expect((await create(beta.owner, { steps: [step('task', 'STAFF_TASK', { assigneeRoleKey: roleKey }), step('done', 'COMPLETION')] }).expect(422)).body.details[0].code).toBe('UNKNOWN_ROLE');
  });

  it('draft -> publish -> new draft: published versions are immutable and exactly one is published', async () => {
    const workflow = (await create(manager, { steps: minimal() }).expect(201)).body;
    const id = workflow.id;
    const v1 = workflow.versionId;
    // A draft can be edited as often as needed, but only with a valid result.
    const edited = (await t.as(manager).put(`/workflows/${id}/versions/${v1}/steps`, { steps: [step('task', 'STAFF_TASK', { timeoutHours: 24 }), step('note', 'NOTIFICATION', { config: { message: 'Almost there' } }), step('done', 'COMPLETION')], notes: 'Added a note' }).expect(200)).body;
    expect(edited).toMatchObject({ status: 'DRAFT', notes: 'Added a note' });
    expect(edited.steps.map((s: any) => [s.key, s.position, s.timeoutHours, s.customerVisible])).toEqual([['task', 1, 24, true], ['note', 2, null, true], ['done', 3, null, true]]);
    const broken = await t.as(manager).put(`/workflows/${id}/versions/${v1}/steps`, { steps: [step('note', 'NOTIFICATION'), step('done', 'COMPLETION')] }).expect(422);
    expect(broken.body.details.map((e: any) => e.code)).toEqual(['COMPLETION_REQUIRES_STAFF_TASK']);
    await t.as(manager).put(`/workflows/${id}/versions/${v1}/steps`, { steps: [] }).expect(400);
    expect((await t.as(manager).get(`/workflows/${id}/versions/${v1}`).expect(200)).body.steps).toHaveLength(3); // the refused edit changed nothing

    const published = (await t.as(manager).post(`/workflows/${id}/versions/${v1}/publish`).expect(200)).body;
    expect(published).toMatchObject({ status: 'PUBLISHED', publishedById: manager.userId });
    expect(published.publishedAt).toBeTruthy();
    // Published: no more edits, no second publish, no discard.
    for (const res of [
      await t.as(manager).put(`/workflows/${id}/versions/${v1}/steps`, { steps: minimal() }),
      await t.as(manager).post(`/workflows/${id}/versions/${v1}/publish`),
      await t.as(manager).delete(`/workflows/${id}/versions/${v1}`),
    ]) {
      expect([res.status, res.body.code]).toEqual([409, 'VERSION_IMMUTABLE']);
    }
    expect(res409Message(await t.as(manager).put(`/workflows/${id}/versions/${v1}/steps`, { steps: minimal() }))).toBe('Version 1 has been published and can no longer be changed. Create a new draft to make changes.');

    // Changes go into a new draft, which starts as a copy of the published version.
    const draft = (await t.as(manager).post(`/workflows/${id}/versions`, { notes: 'Trying something' }).expect(201)).body;
    expect(draft).toMatchObject({ version: 2, status: 'DRAFT', notes: 'Trying something' });
    expect(strip(draft.steps)).toEqual(strip(published.steps));
    const second = await t.as(manager).post(`/workflows/${id}/versions`, {}).expect(409);
    expect(second.body).toMatchObject({ code: 'DRAFT_EXISTS', details: { versionId: draft.id } });
    await t.as(manager).put(`/workflows/${id}/versions/${draft.id}/steps`, { steps: minimal() }).expect(200);
    // The published version is exactly what it was.
    expect((await t.as(manager).get(`/workflows/${id}/versions/${v1}`).expect(200)).body.steps.map((s: any) => s.key)).toEqual(['task', 'note', 'done']);
    const list = (await t.as(manager).get('/workflows').expect(200)).body.find((d: any) => d.id === id);
    expect(list).toMatchObject({ versionCount: 2, publishedVersion: { id: v1, version: 1, stepCount: 3 }, draftVersion: { id: draft.id, version: 2, stepCount: 2 } });

    await t.as(manager).post(`/workflows/${id}/versions/${draft.id}/publish`).expect(200);
    const versions = (await t.as(manager).get(`/workflows/${id}/versions`).expect(200)).body;
    expect(versions.map((v: any) => [v.version, v.status, v.stepCount])).toEqual([[2, 'PUBLISHED', 2], [1, 'ARCHIVED', 3]]);
    expect((await t.sys.workflowDefinition.findUniqueOrThrow({ where: { id } })).publishedVersionId).toBe(draft.id);
    // The database itself refuses a second published version.
    await expect(t.sys.workflowVersion.update({ where: { id: v1 }, data: { status: 'PUBLISHED' } })).rejects.toThrow();

    // A draft can be discarded; the only version of a workflow cannot.
    const third = (await t.as(manager).post(`/workflows/${id}/versions`, {}).expect(201)).body;
    expect((await t.as(manager).delete(`/workflows/${id}/versions/${third.id}`).expect(200)).body).toEqual({ discarded: true });
    await t.as(manager).get(`/workflows/${id}/versions/${third.id}`).expect(404);
    const single = (await create(manager, { steps: minimal() }).expect(201)).body;
    expect((await t.as(manager).delete(`/workflows/${single.id}/versions/${single.versionId}`).expect(409)).body.code).toBe('LAST_VERSION');

    // Everything is audited.
    const actions = (await t.sys.auditLog.findMany({ where: { tenantId: alpha.id, action: { startsWith: 'workflow.' }, OR: [{ resourceId: id }, { resourceId: v1 }, { resourceId: draft.id }, { resourceId: third.id }] }, orderBy: { createdAt: 'asc' } })).map((a) => a.action);
    expect(actions).toEqual(['workflow.created', 'workflow.draft_saved', 'workflow.published', 'workflow.draft_created', 'workflow.draft_saved', 'workflow.published', 'workflow.draft_created', 'workflow.draft_discarded']);
  });

  it('rollback creates and publishes a copy; a draft cannot be rolled back to', async () => {
    const workflow = (await create(manager, { steps: minimal(), publish: true }).expect(201)).body;
    const id = workflow.id;
    const draft = (await t.as(manager).post(`/workflows/${id}/versions`, {}).expect(201)).body;
    expect((await t.as(manager).post(`/workflows/${id}/versions/${draft.id}/rollback`).expect(409)).body.code).toBe('VERSION_NOT_PUBLISHED');
    await t.as(manager).put(`/workflows/${id}/versions/${draft.id}/steps`, { steps: [step('task', 'STAFF_TASK'), step('check', 'INTERNAL_APPROVAL'), step('done', 'COMPLETION')] }).expect(200);
    await t.as(manager).post(`/workflows/${id}/versions/${draft.id}/publish`).expect(200);
    expect((await t.as(manager).post(`/workflows/${id}/versions/${draft.id}/rollback`).expect(409)).body.code).toBe('ALREADY_PUBLISHED');

    const rolled = (await t.as(manager).post(`/workflows/${id}/versions/${workflow.versionId}/rollback`).expect(200)).body;
    expect(rolled).toMatchObject({ version: 3, status: 'PUBLISHED', notes: 'Rollback to version 1.' });
    expect(rolled.steps.map((s: any) => s.key)).toEqual(['task', 'done']);
    const versions = (await t.as(manager).get(`/workflows/${id}/versions`).expect(200)).body;
    expect(versions.map((v: any) => [v.version, v.status])).toEqual([[3, 'PUBLISHED'], [2, 'ARCHIVED'], [1, 'ARCHIVED']]);
    expect(await t.sys.workflowStep.count({ where: { versionId: workflow.versionId } })).toBe(2); // version 1 untouched
    await t.as(manager).post(`/workflows/${id}/versions/00000000-0000-4000-8000-00000000dead/rollback`).expect(404);
  });

  it('archives a workflow only when no service uses it and it is not the default', async () => {
    const workflow = (await create(manager, { steps: minimal(), publish: true }).expect(201)).body;
    const category = await t.sys.serviceCategory.findFirstOrThrow({ where: { tenantId: alpha.id } });
    const service = await t.sys.service.create({ data: { tenantId: alpha.id, categoryId: category.id, code: `S-${uniq()}`.toUpperCase(), name: 'Attestation', workflowDefinitionId: workflow.id } });
    expect((await t.as(manager).get('/workflows').expect(200)).body.find((d: any) => d.id === workflow.id).servicesUsing).toBe(1);
    const inUse = await t.as(manager).post(`/workflows/${workflow.id}/archive`).expect(409);
    expect(inUse.body).toMatchObject({ code: 'WORKFLOW_IN_USE', message: 'This workflow is used by: Attestation. Choose another workflow for these services first.' });
    const standard = await t.sys.workflowDefinition.findFirstOrThrow({ where: { tenantId: alpha.id, key: 'standard' } });
    expect((await t.as(manager).post(`/workflows/${standard.id}/archive`).expect(409)).body.code).toBe('DEFAULT_WORKFLOW');

    await t.sys.service.update({ where: { id: service.id }, data: { workflowDefinitionId: null } });
    await t.as(manager).post(`/workflows/${workflow.id}/versions`, {}).expect(201); // an open draft goes away with the workflow
    expect((await t.as(manager).post(`/workflows/${workflow.id}/archive`).expect(200)).body).toEqual({ archived: true });
    expect((await t.as(manager).get('/workflows').expect(200)).body.map((d: any) => d.id)).not.toContain(workflow.id);
    const archived = (await t.as(manager).get('/workflows?includeArchived=true').expect(200)).body.find((d: any) => d.id === workflow.id);
    expect(archived).toMatchObject({ archived: true, publishedVersion: null, draftVersion: null, versionCount: 1 });
    // An archived workflow cannot become the default; its history is still readable.
    expect((await t.as(manager).post(`/workflows/${workflow.id}/set-default`).expect(409)).body.code).toBe('WORKFLOW_NOT_PUBLISHED');
    expect((await t.as(manager).get(`/workflows/${workflow.id}/versions`).expect(200)).body.map((v: any) => v.status)).toEqual(['ARCHIVED']);
  });

  it('deletes a workflow that has no published version and was never used; one with history can only be archived', async () => {
    const audit = (id: string) => t.sys.auditLog.findMany({ where: { tenantId: alpha.id, action: 'workflow.deleted', resourceId: id } });
    const listed = async (id: string) => (await t.as(manager).get('/workflows?includeArchived=true').expect(200)).body.find((d: any) => d.id === id);

    // The gap: archiving a workflow that was never published discards its draft - and used to leave a definition nobody could remove.
    const neverPublished = (await create(manager, { steps: minimal() }).expect(201)).body;
    await t.as(manager).post(`/workflows/${neverPublished.id}/archive`).expect(200);
    expect(await listed(neverPublished.id)).toMatchObject({ archived: true, versionCount: 0, publishedVersion: null, draftVersion: null, servicesUsing: 0 });
    expect((await t.as(manager).get('/workflows').expect(200)).body.map((d: any) => d.id)).not.toContain(neverPublished.id);
    // Who may not delete it: staff without workflow.manage, another centre, nobody.
    await t.as(receptionist).delete(`/workflows/${neverPublished.id}`).expect(403);
    await t.as(beta.owner).delete(`/workflows/${neverPublished.id}`).expect(404);
    await t.as(null).delete(`/workflows/${neverPublished.id}`).expect(401);
    expect(await t.sys.workflowDefinition.count({ where: { id: neverPublished.id } })).toBe(1);
    expect((await t.as(manager).delete(`/workflows/${neverPublished.id}`).expect(200)).body).toEqual({ id: neverPublished.id, status: 'DELETED' });
    expect(await t.sys.workflowDefinition.count({ where: { id: neverPublished.id } })).toBe(0);
    await t.as(manager).get(`/workflows/${neverPublished.id}`).expect(404);
    await t.as(manager).delete(`/workflows/${neverPublished.id}`).expect(404);
    expect(await audit(neverPublished.id)).toEqual([expect.objectContaining({ actorUserId: manager.userId, resourceType: 'WorkflowDefinition', before: expect.objectContaining({ key: neverPublished.key, versions: [] }) })]);
    // The key is free again.
    await t.as(manager).post('/workflows', { key: neverPublished.key, name: 'Second attempt', steps: minimal() }).expect(201);

    // A draft that is still open goes directly, with its steps.
    const draftOnly = (await create(manager, { steps: minimal() }).expect(201)).body;
    expect(await t.sys.workflowStep.count({ where: { versionId: draftOnly.versionId } })).toBe(2);
    await t.as(manager).delete(`/workflows/${draftOnly.id}`).expect(200);
    expect(await t.sys.workflowVersion.count({ where: { definitionId: draftOnly.id } })).toBe(0);
    expect(await t.sys.workflowStep.count({ where: { versionId: draftOnly.versionId } })).toBe(0);
    expect((await audit(draftOnly.id))[0].before).toMatchObject({ versions: [{ version: 1, status: 'DRAFT' }] });

    // Published: archive first. The default workflow is published, so it is refused the same way.
    const published = (await create(manager, { steps: minimal(), publish: true }).expect(201)).body;
    expect((await t.as(manager).delete(`/workflows/${published.id}`).expect(409)).body.code).toBe('WORKFLOW_PUBLISHED');
    const standard = await t.sys.workflowDefinition.findFirstOrThrow({ where: { tenantId: alpha.id, key: 'standard' } });
    expect((await t.as(manager).delete(`/workflows/${standard.id}`).expect(409)).body.code).toBe('WORKFLOW_PUBLISHED');

    // Used by a service: refused, also when it is only a draft. A deleted service does not count.
    const category = await t.sys.serviceCategory.findFirstOrThrow({ where: { tenantId: alpha.id } });
    const wanted = (await create(manager, { steps: minimal() }).expect(201)).body;
    const service = await t.sys.service.create({ data: { tenantId: alpha.id, categoryId: category.id, code: `S-${uniq()}`.toUpperCase(), name: 'Translation', workflowDefinitionId: wanted.id } });
    expect((await t.as(manager).delete(`/workflows/${wanted.id}`).expect(409)).body).toMatchObject({ code: 'WORKFLOW_IN_USE', message: 'This workflow is used by: Translation. Choose another workflow for these services first.' });
    await t.sys.service.update({ where: { id: service.id }, data: { deletedAt: new Date() } });
    await t.as(manager).delete(`/workflows/${wanted.id}`).expect(200);
    expect((await t.sys.service.findUniqueOrThrow({ where: { id: service.id } })).workflowDefinitionId).toBeNull();

    // A request ran on it: the history has to stay readable, so it can be archived but never deleted.
    const customer = await t.sys.customer.create({ data: { tenantId: alpha.id, customerNo: `CUS-${uniq()}`, fullName: 'Workflow Customer' } });
    const plain = await t.sys.service.create({ data: { tenantId: alpha.id, categoryId: category.id, code: `S-${uniq()}`.toUpperCase(), name: 'Plain service' } });
    const request = await t.sys.serviceRequest.create({ data: { tenantId: alpha.id, branchId: alpha.headOfficeId, requestNo: `TE-${uniq()}`, customerId: customer.id, serviceId: plain.id, status: 'COMPLETED', workflowVersionId: published.versionId } });
    await t.sys.workflowExecution.create({ data: { tenantId: alpha.id, requestId: request.id, versionId: published.versionId, status: 'COMPLETED' } });
    await t.as(manager).post(`/workflows/${published.id}/archive`).expect(200);
    const refused = await t.as(manager).delete(`/workflows/${published.id}`).expect(409);
    expect(refused.body).toMatchObject({ code: 'WORKFLOW_HAS_REQUESTS', details: { requests: 1 } });
    expect(await t.sys.workflowVersion.count({ where: { definitionId: published.id } })).toBe(1);
    expect(await audit(published.id)).toEqual([]);

    // Archived and never used by any request: deletable.
    const unused = (await create(manager, { steps: minimal(), publish: true }).expect(201)).body;
    await t.as(manager).post(`/workflows/${unused.id}/archive`).expect(200);
    await t.as(manager).delete(`/workflows/${unused.id}`).expect(200);
    // Another centre's workflow with the same shape is untouched.
    const theirs = (await create(beta.owner, { steps: minimal() }).expect(201)).body;
    await t.as(manager).delete(`/workflows/${theirs.id}`).expect(404);
    expect(await t.sys.workflowDefinition.count({ where: { id: theirs.id } })).toBe(1);
  });

  it('the default workflow can be changed to any published workflow', async () => {
    const draftOnly = (await create(manager, { steps: minimal() }).expect(201)).body;
    expect((await t.as(manager).post(`/workflows/${draftOnly.id}/set-default`).expect(409)).body.code).toBe('WORKFLOW_NOT_PUBLISHED');
    const published = (await create(manager, { steps: minimal(), publish: true }).expect(201)).body;
    const standard = await t.sys.workflowDefinition.findFirstOrThrow({ where: { tenantId: alpha.id, key: 'standard' } });
    expect((await t.as(manager).post(`/workflows/${published.id}/set-default`).expect(200)).body).toEqual({ defaultDefinitionId: published.id });
    const list = (await t.as(manager).get('/workflows').expect(200)).body;
    expect(list.filter((d: any) => d.isDefault).map((d: any) => d.id)).toEqual([published.id]);
    // Other centre settings are kept.
    await t.as(alpha.owner).patch('/tenant/settings', { defaultTargetHours: 36 }).expect(200);
    await t.as(manager).post(`/workflows/${standard.id}/set-default`).expect(200);
    expect((await t.sys.tenant.findUniqueOrThrow({ where: { id: alpha.id } })).settings).toMatchObject({ defaultTargetHours: 36, defaultWorkflowDefinitionId: standard.id });
    const audit = await t.sys.auditLog.findFirstOrThrow({ where: { tenantId: alpha.id, action: 'workflow.default_changed', resourceId: standard.id }, orderBy: { createdAt: 'desc' } });
    expect(audit).toMatchObject({ actorUserId: manager.userId, before: { defaultDefinitionId: published.id }, after: { defaultDefinitionId: standard.id, key: 'standard' } });
  });

  it('only staff with workflow.manage can use the builder', async () => {
    const standard = await t.sys.workflowDefinition.findFirstOrThrow({ where: { tenantId: alpha.id, key: 'standard' } });
    const customer = await t.addCustomer(alpha);
    for (const actor of [receptionist, customer]) {
      const results = [
        await t.as(actor).get('/workflows'),
        await t.as(actor).get('/workflows/templates'),
        await t.as(actor).get('/workflows/builder-meta'),
        await t.as(actor).get(`/workflows/${standard.id}`),
        await t.as(actor).get(`/workflows/${standard.id}/versions`),
        await t.as(actor).get(`/workflows/${standard.id}/versions/${standard.publishedVersionId}`),
        await t.as(actor).post('/workflows/validate', { steps: minimal() }),
        await create(actor, { steps: minimal() }),
        await t.as(actor).patch(`/workflows/${standard.id}`, { name: 'Mine' }),
        await t.as(actor).post(`/workflows/${standard.id}/versions`, {}),
        await t.as(actor).put(`/workflows/${standard.id}/versions/${standard.publishedVersionId}/steps`, { steps: minimal() }),
        await t.as(actor).post(`/workflows/${standard.id}/versions/${standard.publishedVersionId}/publish`),
        await t.as(actor).post(`/workflows/${standard.id}/versions/${standard.publishedVersionId}/rollback`),
        await t.as(actor).delete(`/workflows/${standard.id}/versions/${standard.publishedVersionId}`),
        await t.as(actor).post(`/workflows/${standard.id}/archive`),
        await t.as(actor).delete(`/workflows/${standard.id}`),
        await t.as(actor).post(`/workflows/${standard.id}/set-default`),
      ];
      expect(results.map((r) => r.status)).toEqual(results.map(() => 403));
    }
    await t.as(null).get('/workflows').expect(401);
  });

  it('never lets one centre read, change or publish the workflows of another', async () => {
    const mine = (await create(manager, { steps: minimal(), publish: true }).expect(201)).body;
    const draft = (await t.as(manager).post(`/workflows/${mine.id}/versions`, {}).expect(201)).body;
    const betaOwn = (await create(beta.owner, { steps: minimal(), publish: true }).expect(201)).body;
    const attempts: Array<[string, string, object?]> = [
      ['get', `/workflows/${mine.id}`],
      ['patch', `/workflows/${mine.id}`, { name: 'Hijacked' }],
      ['get', `/workflows/${mine.id}/versions`],
      ['post', `/workflows/${mine.id}/versions`, {}],
      ['get', `/workflows/${mine.id}/versions/${draft.id}`],
      ['put', `/workflows/${mine.id}/versions/${draft.id}/steps`, { steps: minimal() }],
      ['post', `/workflows/${mine.id}/versions/${draft.id}/publish`],
      ['post', `/workflows/${mine.id}/versions/${mine.versionId}/rollback`],
      ['delete', `/workflows/${mine.id}/versions/${draft.id}`],
      ['post', `/workflows/${mine.id}/archive`],
      ['delete', `/workflows/${mine.id}`],
      ['post', `/workflows/${mine.id}/set-default`],
      // A version of alpha addressed through a definition of beta.
      ['get', `/workflows/${betaOwn.id}/versions/${draft.id}`],
      ['put', `/workflows/${betaOwn.id}/versions/${draft.id}/steps`, { steps: minimal() }],
      ['post', `/workflows/${betaOwn.id}/versions/${draft.id}/publish`],
      ['post', `/workflows/${betaOwn.id}/versions/${mine.versionId}/rollback`],
    ];
    const leaks: string[] = [];
    for (const [method, path, body] of attempts) {
      const res = await (t.as(beta.owner) as any)[method](path, body);
      if (res.status !== 404) leaks.push(`${method.toUpperCase()} ${path}: ${res.status}`);
    }
    expect(leaks).toEqual([]);
    const betaList = (await t.as(beta.owner).get('/workflows?includeArchived=true').expect(200)).body;
    expect(betaList.every((d: any) => d.tenantId === beta.id)).toBe(true);
    expect(betaList.map((d: any) => d.id)).not.toContain(mine.id);
    // The same key can exist in both centres.
    await t.as(beta.owner).post('/workflows', { key: mine.key, name: 'Same key, other centre', steps: minimal() }).expect(201);
    expect(await t.sys.workflowDefinition.findUniqueOrThrow({ where: { id: mine.id } })).toMatchObject({ name: 'Test workflow', publishedVersionId: mine.versionId });
    expect((await t.sys.workflowVersion.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe('DRAFT');
    expect(((await t.sys.tenant.findUniqueOrThrow({ where: { id: beta.id } })).settings as any).defaultWorkflowDefinitionId).not.toBe(mine.id);
  });
});

function res409Message(res: { status: number; body: { message: string } }) {
  expect(res.status).toBe(409);
  return res.body.message;
}
