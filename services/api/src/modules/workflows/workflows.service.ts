import { Injectable, OnModuleInit } from '@nestjs/common';
import { WORKFLOW_FACTS, WORKFLOW_STEP_META } from '@typease/types';
import type { Rule } from '@typease/types';
import type { CreateWorkflowBody, ReplaceWorkflowStepsBody, UpdateWorkflowBody, WorkflowStepBody } from '@typease/validation';
import type { Tenant, WorkflowStep } from '@typease/database';
import { AuditService } from '../../common/audit.service';
import { ctx } from '../../common/context';
import { TenantDb, Tx } from '../../common/db/prisma.service';
import { Errors, found } from '../../common/errors';
import { ProvisioningService } from '../tenancy/provisioning.service';
import { Clock } from './clock';
import { RULE_OPS } from './rule-evaluator';
import { DEFAULT_TEMPLATE_KEY, findTemplate, WORKFLOW_TEMPLATES } from './workflow-templates';
import { TIMEOUT_MAX_HOURS, TIMEOUT_MIN_HOURS, validateWorkflow, WorkflowStepDef } from './workflow-validator';

export const DEFAULT_WORKFLOW_SETTING = 'defaultWorkflowDefinitionId';

/** workflow_steps row -> step definition used by the validator and the engine. */
export function toStepDef(row: WorkflowStep): WorkflowStepDef {
  return {
    key: row.key,
    name: row.name,
    nameAr: row.nameAr,
    type: row.type,
    config: (row.config ?? {}) as Record<string, unknown>,
    conditions: (row.conditions ?? null) as Rule | null,
    branches: (row.branches ?? null) as Array<{ when: Rule; goTo: string }> | null,
    nextStepKey: row.nextStepKey,
    onRejectStepKey: row.onRejectStepKey,
    assigneeRoleKey: row.assigneeRoleKey,
    timeoutHours: row.timeoutHours,
    escalateToRoleKey: row.escalateToRoleKey,
    customerVisible: row.customerVisible,
  };
}

function stepRows(tenantId: string, versionId: string, steps: WorkflowStepDef[]) {
  return steps.map((s, i) => ({
    tenantId,
    versionId,
    key: s.key,
    name: s.name,
    nameAr: s.nameAr ?? null,
    type: s.type,
    position: i + 1,
    config: (s.config ?? {}) as object,
    conditions: (s.conditions ?? undefined) as object | undefined,
    branches: (s.branches?.length ? s.branches : undefined) as object | undefined,
    nextStepKey: s.nextStepKey ?? null,
    onRejectStepKey: s.onRejectStepKey ?? null,
    assigneeRoleKey: s.assigneeRoleKey ?? null,
    timeoutHours: s.timeoutHours ?? null,
    escalateToRoleKey: s.escalateToRoleKey ?? null,
    customerVisible: s.customerVisible ?? true,
  }));
}

/**
 * Workflow definitions and their versions (the builder).
 *
 * A definition has any number of versions; at most one is PUBLISHED (enforced
 * by a partial unique index) and at most one is a DRAFT. Published and archived
 * versions are never edited: changes always go into a new version, and rolling
 * back publishes a copy of an older one. Requests are pinned to a version id, so
 * publishing never changes a case that is already running.
 */
@Injectable()
export class WorkflowsService implements OnModuleInit {
  /** Steps of immutable (non-draft) versions, by version id. */
  private readonly stepCache = new Map<string, WorkflowStepDef[]>();

  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly provisioning: ProvisioningService,
    private readonly clock: Clock,
  ) {}

  onModuleInit() {
    this.provisioning.registerTenantStep('workflows.templates', (tx, tenant) => this.installTemplates(tx, tenant));
  }

  // ------------------------------------------------------------------ provisioning
  /** Idempotent: creates each missing template for the tenant and chooses the default workflow. */
  async installTemplates(tx: Tx, tenant: Tenant): Promise<void> {
    const ids = new Map<string, string>();
    for (const template of WORKFLOW_TEMPLATES) {
      const existing = await tx.workflowDefinition.findFirst({ where: { tenantId: tenant.id, key: template.key } });
      if (existing) {
        ids.set(template.key, existing.id);
        continue;
      }
      const definition = await tx.workflowDefinition.create({
        data: { tenantId: tenant.id, key: template.key, name: template.name, description: template.description, templateKey: template.key },
      });
      const version = await tx.workflowVersion.create({
        data: { tenantId: tenant.id, definitionId: definition.id, version: 1, status: 'PUBLISHED', publishedAt: this.clock.now(), notes: 'Installed from the TypEase template.' },
      });
      await tx.workflowStep.createMany({ data: stepRows(tenant.id, version.id, template.steps) });
      await tx.workflowDefinition.update({ where: { id: definition.id }, data: { publishedVersionId: version.id } });
      ids.set(template.key, definition.id);
    }
    const fresh = await tx.tenant.findUniqueOrThrow({ where: { id: tenant.id }, select: { settings: true } });
    const settings = (fresh.settings ?? {}) as Record<string, unknown>;
    if (!settings[DEFAULT_WORKFLOW_SETTING] && ids.get(DEFAULT_TEMPLATE_KEY)) {
      await tx.tenant.update({ where: { id: tenant.id }, data: { settings: { ...settings, [DEFAULT_WORKFLOW_SETTING]: ids.get(DEFAULT_TEMPLATE_KEY) } as object } });
    }
  }

  // ------------------------------------------------------------------ helpers shared with the request engine
  /** Role keys a step may name (staff roles of the current tenant). */
  async staffRoleKeys(tx: Tx): Promise<string[]> {
    const roles = await tx.role.findMany({ where: { tenantId: this.db.tenantId, kind: 'STAFF' }, select: { key: true } });
    return roles.map((r) => r.key);
  }

  async defaultDefinitionId(tx: Tx): Promise<string | null> {
    const tenant = await tx.tenant.findFirstOrThrow({ where: { id: this.db.tenantId }, select: { settings: true } });
    const id = ((tenant.settings ?? {}) as Record<string, unknown>)[DEFAULT_WORKFLOW_SETTING];
    return typeof id === 'string' ? id : null;
  }

  /**
   * The version a NEW request of this service is pinned to: the published
   * version of the service's own workflow, else of the centre's default one.
   */
  async resolvePublishedVersion(tx: Tx, serviceWorkflowDefinitionId: string | null): Promise<{ versionId: string; definitionId: string }> {
    const candidates = [serviceWorkflowDefinitionId, await this.defaultDefinitionId(tx)].filter((id): id is string => !!id);
    for (const definitionId of candidates) {
      const version = await tx.workflowVersion.findFirst({ where: { tenantId: this.db.tenantId, definitionId, status: 'PUBLISHED' }, select: { id: true } });
      if (version) return { versionId: version.id, definitionId };
    }
    throw Errors.unprocessable('WORKFLOW_NOT_AVAILABLE', 'This service has no published workflow. Publish a workflow for it (Settings > Workflows) or choose a default workflow.');
  }

  /** Ordered steps of a version. Non-draft versions are immutable, so they are cached. */
  async stepsOf(tx: Tx, versionId: string): Promise<WorkflowStepDef[]> {
    const cached = this.stepCache.get(versionId);
    if (cached) return cached;
    const version = found(
      await tx.workflowVersion.findFirst({ where: { id: versionId, tenantId: this.db.tenantId }, include: { workflowSteps: { orderBy: { position: 'asc' } } } }),
      'Workflow version',
    );
    const steps = version.workflowSteps.map(toStepDef);
    if (version.status !== 'DRAFT') {
      if (this.stepCache.size > 500) this.stepCache.clear();
      this.stepCache.set(versionId, steps);
    }
    return steps;
  }

  private async assertValid(tx: Tx, steps: WorkflowStepDef[]): Promise<void> {
    const result = validateWorkflow(steps, { roleKeys: await this.staffRoleKeys(tx) });
    if (!result.valid) {
      throw Errors.unprocessable('WORKFLOW_INVALID', `This workflow cannot be saved yet: ${result.errors[0].message}`, result.errors);
    }
  }

  private async definition(tx: Tx, id: string) {
    return found(await tx.workflowDefinition.findFirst({ where: { id, tenantId: this.db.tenantId } }), 'Workflow');
  }

  private async nextVersionNo(tx: Tx, definitionId: string): Promise<number> {
    const last = await tx.workflowVersion.findFirst({ where: { tenantId: this.db.tenantId, definitionId }, orderBy: { version: 'desc' }, select: { version: true } });
    return (last?.version ?? 0) + 1;
  }

  /** Makes `versionId` the published version: the previous one becomes ARCHIVED (it is kept, never changed). */
  private async publishVersion(tx: Tx, definitionId: string, versionId: string) {
    const tenantId = this.db.tenantId;
    await tx.workflowVersion.updateMany({ where: { tenantId, definitionId, status: 'PUBLISHED' }, data: { status: 'ARCHIVED' } });
    const version = await tx.workflowVersion.update({
      where: { id: versionId },
      data: { status: 'PUBLISHED', publishedAt: this.clock.now(), publishedById: ctx().userId ?? null },
    });
    await tx.workflowDefinition.update({ where: { id: definitionId }, data: { publishedVersionId: versionId } });
    return version;
  }

  // ------------------------------------------------------------------ reading
  templates() {
    return WORKFLOW_TEMPLATES.map((t) => ({ key: t.key, name: t.name, description: t.description, steps: t.steps.map((s, i) => ({ ...s, position: i + 1 })) }));
  }

  /** Everything the builder UI needs to offer valid choices. */
  async builderMeta() {
    return this.db.tx(async (tx) => {
      const roles = await tx.role.findMany({ where: { tenantId: this.db.tenantId, kind: 'STAFF' }, select: { key: true, name: true }, orderBy: { name: 'asc' } });
      return {
        stepTypes: Object.entries(WORKFLOW_STEP_META).map(([type, meta]) => ({ type, ...meta })),
        facts: [...WORKFLOW_FACTS],
        operators: [...RULE_OPS],
        roles,
        timeoutHours: { min: TIMEOUT_MIN_HOURS, max: TIMEOUT_MAX_HOURS },
        defaultDefinitionId: await this.defaultDefinitionId(tx),
      };
    });
  }

  async list(query: { includeArchived?: boolean } = {}) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const [definitions, defaultId, usage] = await Promise.all([
        tx.workflowDefinition.findMany({
          where: { tenantId },
          include: { workflowVersions: { select: { id: true, version: true, status: true, publishedAt: true, updatedAt: true, _count: { select: { workflowSteps: true } } } } },
          orderBy: { name: 'asc' },
        }),
        this.defaultDefinitionId(tx),
        tx.service.groupBy({ by: ['workflowDefinitionId'], where: { tenantId, deletedAt: null, workflowDefinitionId: { not: null } }, _count: { _all: true } }),
      ]);
      const used = new Map(usage.map((u) => [u.workflowDefinitionId, u._count._all]));
      return definitions
        .map(({ workflowVersions, ...d }) => {
          const published = workflowVersions.find((v) => v.status === 'PUBLISHED');
          const draft = workflowVersions.find((v) => v.status === 'DRAFT');
          return {
            ...d,
            isDefault: d.id === defaultId,
            // No published version and no draft: retired (or, with no version at all, never published and its draft discarded).
            archived: !published && !draft,
            servicesUsing: used.get(d.id) ?? 0,
            versionCount: workflowVersions.length,
            publishedVersion: published ? { id: published.id, version: published.version, publishedAt: published.publishedAt, stepCount: published._count.workflowSteps } : null,
            draftVersion: draft ? { id: draft.id, version: draft.version, updatedAt: draft.updatedAt, stepCount: draft._count.workflowSteps } : null,
          };
        })
        .filter((d) => query.includeArchived || !d.archived);
    });
  }

  async get(id: string) {
    return this.db.tx(async (tx) => {
      const definition = await this.definition(tx, id);
      const versions = await tx.workflowVersion.findMany({
        where: { tenantId: this.db.tenantId, definitionId: id, status: { in: ['PUBLISHED', 'DRAFT'] } },
        include: { workflowSteps: { orderBy: { position: 'asc' } } },
      });
      const published = versions.find((v) => v.status === 'PUBLISHED') ?? null;
      const draft = versions.find((v) => v.status === 'DRAFT') ?? null;
      return {
        ...definition,
        isDefault: (await this.defaultDefinitionId(tx)) === id,
        servicesUsing: await tx.service.count({ where: { tenantId: this.db.tenantId, workflowDefinitionId: id, deletedAt: null } }),
        publishedVersion: published ? shapeVersion(published) : null,
        draftVersion: draft ? shapeVersion(draft) : null,
      };
    });
  }

  async listVersions(id: string) {
    return this.db.tx(async (tx) => {
      await this.definition(tx, id);
      const versions = await tx.workflowVersion.findMany({
        where: { tenantId: this.db.tenantId, definitionId: id },
        include: { _count: { select: { workflowSteps: true, workflowExecutions: true } } },
        orderBy: { version: 'desc' },
      });
      return versions.map(({ _count, ...v }) => ({ ...v, stepCount: _count.workflowSteps, casesUsing: _count.workflowExecutions }));
    });
  }

  async getVersion(id: string, versionId: string) {
    return this.db.tx(async (tx) => {
      await this.definition(tx, id);
      const version = found(
        await tx.workflowVersion.findFirst({ where: { id: versionId, definitionId: id, tenantId: this.db.tenantId }, include: { workflowSteps: { orderBy: { position: 'asc' } } } }),
        'Workflow version',
      );
      return shapeVersion(version);
    });
  }

  /** Dry run for the builder: reports every problem without saving anything. */
  async validate(steps: WorkflowStepBody[]) {
    return this.db.tx(async (tx) => validateWorkflow(steps as WorkflowStepDef[], { roleKeys: await this.staffRoleKeys(tx) }));
  }

  // ------------------------------------------------------------------ writing
  async create(input: CreateWorkflowBody) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      if (await tx.workflowDefinition.findFirst({ where: { tenantId, key: input.key } })) {
        throw Errors.conflict('DUPLICATE', `A workflow with the key "${input.key}" already exists. Choose another key.`);
      }
      const template = input.templateKey ? findTemplate(input.templateKey) : undefined;
      const steps = (template?.steps ?? input.steps ?? []) as WorkflowStepDef[];
      await this.assertValid(tx, steps);
      const definition = await tx.workflowDefinition.create({
        data: { tenantId, key: input.key, name: input.name, description: input.description ?? template?.description ?? null, templateKey: template?.key ?? null },
      });
      const version = await tx.workflowVersion.create({
        data: { tenantId, definitionId: definition.id, version: 1, status: 'DRAFT', createdById: ctx().userId ?? null, notes: template ? `Created from the "${template.name}" template.` : null },
      });
      await tx.workflowStep.createMany({ data: stepRows(tenantId, version.id, steps) });
      if (input.publish) await this.publishVersion(tx, definition.id, version.id);
      await this.audit.log(
        { action: 'workflow.created', resourceType: 'WorkflowDefinition', resourceId: definition.id, after: { key: input.key, name: input.name, templateKey: template?.key ?? null, steps: steps.length, published: input.publish } },
        tx,
      );
      return { ...definition, publishedVersionId: input.publish ? version.id : null, versionId: version.id, versionStatus: input.publish ? 'PUBLISHED' : 'DRAFT' };
    });
  }

  async update(id: string, input: UpdateWorkflowBody) {
    return this.db.tx(async (tx) => {
      const before = await this.definition(tx, id);
      const data: { name?: string; description?: string | null } = {};
      if (input.name !== undefined) data.name = input.name;
      if (input.description !== undefined) data.description = input.description ?? null;
      const after = await tx.workflowDefinition.update({ where: { id }, data });
      await this.audit.log({ action: 'workflow.updated', resourceType: 'WorkflowDefinition', resourceId: id, before: { name: before.name, description: before.description }, after: data }, tx);
      return after;
    });
  }

  /** Starts a new DRAFT as a copy of the published version (or of the latest version when nothing is published). */
  async createDraft(id: string, notes?: string | null) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      await this.definition(tx, id);
      const versions = await tx.workflowVersion.findMany({ where: { tenantId, definitionId: id }, orderBy: { version: 'desc' }, include: { workflowSteps: { orderBy: { position: 'asc' } } } });
      const draft = versions.find((v) => v.status === 'DRAFT');
      if (draft) throw Errors.conflict('DRAFT_EXISTS', `Version ${draft.version} is already being edited. Publish or discard it first.`, { versionId: draft.id });
      const source = versions.find((v) => v.status === 'PUBLISHED') ?? versions[0];
      const version = await tx.workflowVersion.create({
        data: { tenantId, definitionId: id, version: (versions[0]?.version ?? 0) + 1, status: 'DRAFT', createdById: ctx().userId ?? null, notes: notes ?? (source ? `Copy of version ${source.version}.` : null) },
      });
      if (source?.workflowSteps.length) await tx.workflowStep.createMany({ data: stepRows(tenantId, version.id, source.workflowSteps.map(toStepDef)) });
      await this.audit.log({ action: 'workflow.draft_created', resourceType: 'WorkflowVersion', resourceId: version.id, after: { definitionId: id, version: version.version, copiedFrom: source?.version ?? null } }, tx);
      return this.getVersion(id, version.id);
    });
  }

  private async draftVersion(tx: Tx, id: string, versionId: string) {
    await this.definition(tx, id);
    const version = found(await tx.workflowVersion.findFirst({ where: { id: versionId, definitionId: id, tenantId: this.db.tenantId } }), 'Workflow version');
    if (version.status !== 'DRAFT') {
      throw Errors.conflict('VERSION_IMMUTABLE', `Version ${version.version} has been published and can no longer be changed. Create a new draft to make changes.`);
    }
    return version;
  }

  async replaceSteps(id: string, versionId: string, input: ReplaceWorkflowStepsBody) {
    return this.db.tx(async (tx) => {
      const version = await this.draftVersion(tx, id, versionId);
      const steps = input.steps as WorkflowStepDef[];
      await this.assertValid(tx, steps);
      await tx.workflowStep.deleteMany({ where: { tenantId: this.db.tenantId, versionId } });
      await tx.workflowStep.createMany({ data: stepRows(this.db.tenantId, versionId, steps) });
      await tx.workflowVersion.update({ where: { id: versionId }, data: { notes: input.notes === undefined ? version.notes : input.notes } });
      await this.audit.log({ action: 'workflow.draft_saved', resourceType: 'WorkflowVersion', resourceId: versionId, after: { definitionId: id, version: version.version, steps: steps.map((s) => `${s.key}:${s.type}`) } }, tx);
      return this.getVersion(id, versionId);
    });
  }

  async discardDraft(id: string, versionId: string) {
    return this.db.tx(async (tx) => {
      const version = await this.draftVersion(tx, id, versionId);
      const others = await tx.workflowVersion.count({ where: { tenantId: this.db.tenantId, definitionId: id, id: { not: versionId } } });
      if (!others) throw Errors.conflict('LAST_VERSION', 'This is the only version of the workflow. Archive the workflow instead of discarding its draft.');
      await tx.workflowVersion.delete({ where: { id: versionId } });
      await this.audit.log({ action: 'workflow.draft_discarded', resourceType: 'WorkflowVersion', resourceId: versionId, before: { definitionId: id, version: version.version } }, tx);
      return { discarded: true };
    });
  }

  async publish(id: string, versionId: string) {
    return this.db.tx(async (tx) => {
      const version = await this.draftVersion(tx, id, versionId);
      const steps = (await tx.workflowStep.findMany({ where: { tenantId: this.db.tenantId, versionId }, orderBy: { position: 'asc' } })).map(toStepDef);
      await this.assertValid(tx, steps);
      const previous = await tx.workflowVersion.findFirst({ where: { tenantId: this.db.tenantId, definitionId: id, status: 'PUBLISHED' }, select: { id: true, version: true } });
      await this.publishVersion(tx, id, versionId);
      await this.audit.log(
        { action: 'workflow.published', resourceType: 'WorkflowVersion', resourceId: versionId, before: { publishedVersion: previous?.version ?? null }, after: { definitionId: id, publishedVersion: version.version } },
        tx,
      );
      return this.getVersion(id, versionId);
    });
  }

  /**
   * Safe rollback: history is never rewritten. A NEW version is created as a
   * copy of the chosen older version and published; running cases stay on the
   * version they started with.
   */
  async rollback(id: string, versionId: string) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      await this.definition(tx, id);
      const source = found(
        await tx.workflowVersion.findFirst({ where: { id: versionId, definitionId: id, tenantId }, include: { workflowSteps: { orderBy: { position: 'asc' } } } }),
        'Workflow version',
      );
      if (source.status === 'DRAFT') throw Errors.conflict('VERSION_NOT_PUBLISHED', 'A draft was never in use, so there is nothing to roll back to. Publish it instead.');
      if (source.status === 'PUBLISHED') throw Errors.conflict('ALREADY_PUBLISHED', `Version ${source.version} is the version currently in use.`);
      const steps = source.workflowSteps.map(toStepDef);
      await this.assertValid(tx, steps);
      const version = await tx.workflowVersion.create({
        data: { tenantId, definitionId: id, version: await this.nextVersionNo(tx, id), status: 'DRAFT', createdById: ctx().userId ?? null, notes: `Rollback to version ${source.version}.` },
      });
      await tx.workflowStep.createMany({ data: stepRows(tenantId, version.id, steps) });
      await this.publishVersion(tx, id, version.id);
      await this.audit.log({ action: 'workflow.rolled_back', resourceType: 'WorkflowVersion', resourceId: version.id, after: { definitionId: id, publishedVersion: version.version, copyOfVersion: source.version } }, tx);
      return this.getVersion(id, version.id);
    });
  }

  /** Retires a workflow for new requests. Cases already running on one of its versions are not affected. */
  async archive(id: string) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const definition = await this.definition(tx, id);
      const services = await tx.service.findMany({ where: { tenantId, workflowDefinitionId: id, deletedAt: null }, select: { name: true }, take: 5 });
      if (services.length) {
        throw Errors.conflict('WORKFLOW_IN_USE', `This workflow is used by: ${services.map((s) => s.name).join(', ')}. Choose another workflow for these services first.`);
      }
      if ((await this.defaultDefinitionId(tx)) === id) {
        throw Errors.conflict('DEFAULT_WORKFLOW', 'This is the default workflow of the centre. Choose another default before archiving it.');
      }
      await tx.workflowVersion.deleteMany({ where: { tenantId, definitionId: id, status: 'DRAFT', workflowExecutions: { none: {} } } });
      await tx.workflowVersion.updateMany({ where: { tenantId, definitionId: id, status: { in: ['PUBLISHED', 'DRAFT'] } }, data: { status: 'ARCHIVED' } });
      await tx.workflowDefinition.update({ where: { id }, data: { publishedVersionId: null } });
      await this.audit.log({ action: 'workflow.archived', resourceType: 'WorkflowDefinition', resourceId: id, before: { key: definition.key, publishedVersionId: definition.publishedVersionId } }, tx);
      return { archived: true };
    });
  }

  /**
   * Deletes a workflow for good - definition, versions and steps. Only possible when nothing depends on it:
   * no published version (archive it first), not the default, no service uses it, and no request ever ran on
   * or is pinned to one of its versions. This is how a workflow that was created and never published (or was
   * archived before anybody used it) is cleaned up; a workflow with history can only be archived.
   */
  async remove(id: string) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      // Row lock: a publish (updates the definition) or a service that is being pointed at it (key-share lock of the
      // foreign key) waits for this transaction instead of slipping in between the checks and the delete.
      await tx.$queryRaw`SELECT "id" FROM "workflow_definitions" WHERE "id" = ${id}::uuid AND "tenantId" = ${tenantId}::uuid FOR UPDATE`;
      const definition = await this.definition(tx, id);
      const versions = await tx.workflowVersion.findMany({ where: { tenantId, definitionId: id }, select: { id: true, version: true, status: true } });
      if (versions.some((v) => v.status === 'PUBLISHED')) {
        throw Errors.conflict('WORKFLOW_PUBLISHED', 'This workflow is published. Archive it first; it can be deleted afterwards if no request ever used it.');
      }
      const services = await tx.service.findMany({ where: { tenantId, workflowDefinitionId: id, deletedAt: null }, select: { name: true }, take: 5 });
      if (services.length) {
        throw Errors.conflict('WORKFLOW_IN_USE', `This workflow is used by: ${services.map((s) => s.name).join(', ')}. Choose another workflow for these services first.`);
      }
      if ((await this.defaultDefinitionId(tx)) === id) {
        throw Errors.conflict('DEFAULT_WORKFLOW', 'This is the default workflow of the centre. Choose another default before deleting it.');
      }
      const versionIds = versions.map((v) => v.id);
      if (versionIds.length) {
        const [requests, executions] = await Promise.all([
          tx.serviceRequest.count({ where: { tenantId, workflowVersionId: { in: versionIds } } }),
          tx.workflowExecution.count({ where: { tenantId, OR: [{ versionId: { in: versionIds } }, { migratedFromVersionId: { in: versionIds } }] } }),
        ]);
        if (requests || executions) {
          throw Errors.conflict('WORKFLOW_HAS_REQUESTS', `${Math.max(requests, executions)} request(s) ran on this workflow. Its history has to stay readable, so it can be archived but not deleted.`, { requests: Math.max(requests, executions) });
        }
      }
      // Versions and steps go with the definition (cascade); deleted services that still pointed at it are detached by the database.
      await tx.workflowDefinition.delete({ where: { id } });
      await this.audit.log(
        { action: 'workflow.deleted', resourceType: 'WorkflowDefinition', resourceId: id, summary: `${definition.name} (${definition.key}) deleted`, before: { key: definition.key, name: definition.name, templateKey: definition.templateKey, versions: versions.map((v) => ({ version: v.version, status: v.status })) } },
        tx,
      );
      return { id, status: 'DELETED' as const };
    });
  }

  async setDefault(id: string) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const definition = await this.definition(tx, id);
      const published = await tx.workflowVersion.findFirst({ where: { tenantId, definitionId: id, status: 'PUBLISHED' }, select: { id: true } });
      if (!published) throw Errors.conflict('WORKFLOW_NOT_PUBLISHED', 'Publish this workflow before making it the default.');
      const tenant = await tx.tenant.findFirstOrThrow({ where: { id: tenantId }, select: { settings: true } });
      const settings = (tenant.settings ?? {}) as Record<string, unknown>;
      const before = settings[DEFAULT_WORKFLOW_SETTING] ?? null;
      await tx.tenant.update({ where: { id: tenantId }, data: { settings: { ...settings, [DEFAULT_WORKFLOW_SETTING]: id } as object } });
      await this.audit.log({ action: 'workflow.default_changed', resourceType: 'WorkflowDefinition', resourceId: id, before: { defaultDefinitionId: before }, after: { defaultDefinitionId: id, key: definition.key } }, tx);
      return { defaultDefinitionId: id };
    });
  }
}

function shapeVersion<V extends { workflowSteps: WorkflowStep[] }>(version: V) {
  const { workflowSteps, ...rest } = version;
  return { ...rest, steps: workflowSteps.map((s) => ({ id: s.id, position: s.position, ...toStepDef(s) })) };
}
