import { Injectable } from '@nestjs/common';
import type { FormSchema } from '@typease/types';
import { formFields, serviceFormSchema } from '@typease/validation';
import { AuditService } from '../../common/audit.service';
import { ctx } from '../../common/context';
import { TenantDb, Tx } from '../../common/db/prisma.service';
import { Errors, found } from '../../common/errors';
import { CatalogueService } from './catalogue.service';

const EMPTY_FORM: FormSchema = { steps: [] };
const summary = (schema: unknown) => {
  const form = (schema ?? EMPTY_FORM) as FormSchema;
  return { steps: form.steps?.length ?? 0, fields: formFields(form).length };
};

/**
 * Versioned dynamic forms: DRAFT -> PUBLISHED -> ARCHIVED.
 *
 * A published version is immutable because requests keep a reference to the
 * exact version the customer filled in. Editing means: create a new draft
 * (copied from the published version), change it, publish it. Publishing
 * archives the previously published version.
 */
@Injectable()
export class FormsService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly catalogue: CatalogueService,
  ) {}

  list(serviceId: string) {
    return this.db.tx(async (tx) => {
      await this.catalogue.requireService(tx, serviceId, { includeDeleted: true });
      const rows = await tx.serviceFormDefinition.findMany({ where: { tenantId: this.db.tenantId, serviceId }, orderBy: { version: 'desc' } });
      return rows.map(({ schema, ...r }) => ({ ...r, ...summary(schema) }));
    });
  }

  private async require(tx: Tx, serviceId: string, formId: string) {
    return found(await tx.serviceFormDefinition.findFirst({ where: { id: formId, serviceId, tenantId: this.db.tenantId } }), 'Form version');
  }

  get(serviceId: string, formId: string) {
    return this.db.tx(async (tx) => {
      await this.catalogue.requireService(tx, serviceId, { includeDeleted: true });
      return this.require(tx, serviceId, formId);
    });
  }

  /** The published form of a service, or null when the service has none. */
  published(tx: Tx, serviceId: string) {
    return tx.serviceFormDefinition.findFirst({
      where: { tenantId: this.db.tenantId, serviceId, status: 'PUBLISHED' },
      select: { id: true, version: true, schema: true, publishedAt: true },
    });
  }

  /** Starts a new draft. Without a schema it is a copy of the published version, so "edit" never touches what is live. */
  createDraft(serviceId: string, schema?: FormSchema) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      await this.catalogue.requireService(tx, serviceId);
      await this.catalogue.lockService(tx, serviceId);
      const versions = await tx.serviceFormDefinition.findMany({ where: { tenantId, serviceId }, select: { id: true, version: true, status: true, schema: true }, orderBy: { version: 'desc' } });
      const draft = versions.find((v) => v.status === 'DRAFT');
      if (draft) {
        throw Errors.conflict('DRAFT_EXISTS', `Version ${draft.version} is already being drafted. Continue editing it, or delete it to start again.`, { formId: draft.id, version: draft.version });
      }
      const publishedVersion = versions.find((v) => v.status === 'PUBLISHED');
      const row = await tx.serviceFormDefinition.create({
        data: {
          tenantId,
          serviceId,
          version: (versions[0]?.version ?? 0) + 1,
          status: 'DRAFT',
          schema: (schema ?? (publishedVersion?.schema as unknown as FormSchema | undefined) ?? EMPTY_FORM) as any,
          createdById: ctx().userId ?? null,
        },
      });
      await this.audit.log(
        { action: 'service_form.draft_created', resourceType: 'Service', resourceId: serviceId, after: { formId: row.id, version: row.version, copiedFromVersion: schema ? null : (publishedVersion?.version ?? null), ...summary(row.schema) } },
        tx,
      );
      return row;
    });
  }

  private assertDraft(form: { status: string; version: number }) {
    if (form.status !== 'DRAFT') {
      throw Errors.conflict(
        'FORM_VERSION_IMMUTABLE',
        `Version ${form.version} is ${form.status === 'PUBLISHED' ? 'published' : 'archived'} and can no longer be changed. Create a new draft to edit the form.`,
      );
    }
  }

  updateDraft(serviceId: string, formId: string, schema: FormSchema) {
    return this.db.tx(async (tx) => {
      await this.catalogue.requireService(tx, serviceId);
      const before = await this.require(tx, serviceId, formId);
      this.assertDraft(before);
      const after = await tx.serviceFormDefinition.update({ where: { id: formId }, data: { schema: schema as any } });
      await this.audit.log({ action: 'service_form.draft_updated', resourceType: 'Service', resourceId: serviceId, before: { formId, ...summary(before.schema) }, after: { formId, version: after.version, ...summary(schema) } }, tx);
      return after;
    });
  }

  deleteDraft(serviceId: string, formId: string) {
    return this.db.tx(async (tx) => {
      await this.catalogue.requireService(tx, serviceId);
      const form = await this.require(tx, serviceId, formId);
      this.assertDraft(form);
      await tx.serviceFormDefinition.delete({ where: { id: formId } });
      await this.audit.log({ action: 'service_form.draft_deleted', resourceType: 'Service', resourceId: serviceId, before: { formId, version: form.version } }, tx);
      return { status: 'DELETED' as const };
    });
  }

  publish(serviceId: string, formId: string) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      await this.catalogue.requireService(tx, serviceId);
      await this.catalogue.lockService(tx, serviceId);
      const form = await this.require(tx, serviceId, formId);
      this.assertDraft(form);
      // The stored JSON is checked again: what goes live must be a valid definition.
      const parsed = serviceFormSchema.safeParse(form.schema);
      if (!parsed.success) {
        throw Errors.unprocessable('FORM_INVALID', 'This draft is not a valid form. Fix the highlighted problems and try again.', parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
      }
      if (!formFields(parsed.data).length) throw Errors.unprocessable('FORM_EMPTY', 'Add at least one field before publishing the form.');
      const previous = await tx.serviceFormDefinition.findFirst({ where: { tenantId, serviceId, status: 'PUBLISHED' }, select: { id: true, version: true } });
      if (previous) await tx.serviceFormDefinition.update({ where: { id: previous.id }, data: { status: 'ARCHIVED' } });
      const published = await tx.serviceFormDefinition.update({ where: { id: formId }, data: { status: 'PUBLISHED', publishedAt: new Date() } });
      await this.audit.log(
        { action: 'service_form.published', resourceType: 'Service', resourceId: serviceId, before: { publishedVersion: previous?.version ?? null }, after: { formId, version: published.version, ...summary(published.schema) } },
        tx,
      );
      return published;
    });
  }

  /** Withdraws the published form: the service then has no form until another version is published. */
  archive(serviceId: string, formId: string) {
    return this.db.tx(async (tx) => {
      await this.catalogue.requireService(tx, serviceId);
      await this.catalogue.lockService(tx, serviceId);
      const form = await this.require(tx, serviceId, formId);
      if (form.status !== 'PUBLISHED') throw Errors.conflict('FORM_NOT_PUBLISHED', 'Only the published version can be withdrawn.');
      const archived = await tx.serviceFormDefinition.update({ where: { id: formId }, data: { status: 'ARCHIVED' } });
      await this.audit.log({ action: 'service_form.archived', resourceType: 'Service', resourceId: serviceId, before: { formId, version: form.version, status: 'PUBLISHED' }, after: { status: 'ARCHIVED' } }, tx);
      return archived;
    });
  }
}
