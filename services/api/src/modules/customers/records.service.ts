import { Injectable } from '@nestjs/common';
import type { CustomerContactInput, CustomerNoteInput, CustomerTagInput, PageQueryInput, UpdateCustomerContactInput, UpdateCustomerNoteInput } from '@typease/validation';
import { normaliseContactValue } from '@typease/validation';
import type { ContactType } from '@typease/validation';
import { AuditService } from '../../common/audit.service';
import { can, ctx } from '../../common/context';
import { TenantDb, Tx } from '../../common/db/prisma.service';
import { Errors, found } from '../../common/errors';
import { pageArgs, pageResult } from '../../common/pagination';
import { CustomersService } from './customers.service';

const NOTE_SORT = ['createdAt'] as const;

/** What hangs directly off a customer profile: internal notes, tags and extra contact details. */
@Injectable()
export class CustomerRecordsService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly customers: CustomersService,
  ) {}

  // ------------------------------------------------------------------ notes (internal, staff only)
  listNotes(customerId: string, query: PageQueryInput) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      await this.customers.require(tx, customerId);
      const where = { tenantId, customerId, ...(query.q ? { body: { contains: query.q, mode: 'insensitive' as const } } : {}) };
      const { skip, take, orderBy } = pageArgs(query, NOTE_SORT, 'createdAt:desc');
      const [rows, total] = await Promise.all([
        // Pinned notes always come first.
        tx.customerNote.findMany({ where, skip, take, orderBy: [{ isPinned: 'desc' }, ...orderBy] }),
        tx.customerNote.count({ where }),
      ]);
      const authors = await this.customers.authorNames(tx, rows.map((n) => n.authorId));
      return pageResult(rows.map((n) => ({ ...n, authorName: authors.get(n.authorId) ?? null })), total, query);
    });
  }

  addNote(customerId: string, input: CustomerNoteInput) {
    return this.db.tx(async (tx) => {
      const c = ctx();
      await this.customers.requireActive(tx, customerId);
      const note = await tx.customerNote.create({ data: { tenantId: this.db.tenantId, customerId, authorId: c.userId!, body: input.body, isPinned: input.isPinned } });
      // The text of a note is not copied into the audit trail: the trail says that it happened, the note says what.
      await this.audit.log({ action: 'customer.note_added', resourceType: 'Customer', resourceId: customerId, after: { noteId: note.id, isPinned: note.isPinned, length: note.body.length } }, tx);
      return { ...note, authorName: c.actorLabel ?? null };
    });
  }

  private async requireNote(tx: Tx, customerId: string, noteId: string) {
    return found(await tx.customerNote.findFirst({ where: { id: noteId, customerId, tenantId: this.db.tenantId } }), 'Note');
  }

  updateNote(customerId: string, noteId: string, input: UpdateCustomerNoteInput) {
    return this.db.tx(async (tx) => {
      const c = ctx();
      await this.customers.requireActive(tx, customerId);
      const before = await this.requireNote(tx, customerId, noteId);
      if (input.body !== undefined && input.body !== before.body && before.authorId !== c.userId) {
        throw Errors.forbidden('NOTE_NOT_YOURS', 'Only the person who wrote a note can change its text. You can pin or unpin it, or add your own note.');
      }
      const after = await tx.customerNote.update({ where: { id: noteId }, data: { body: input.body, isPinned: input.isPinned } });
      await this.audit.log(
        { action: 'customer.note_updated', resourceType: 'Customer', resourceId: customerId, before: { noteId, isPinned: before.isPinned }, after: { noteId, isPinned: after.isPinned, textChanged: after.body !== before.body } },
        tx,
      );
      const authors = await this.customers.authorNames(tx, [after.authorId]);
      return { ...after, authorName: authors.get(after.authorId) ?? null };
    });
  }

  removeNote(customerId: string, noteId: string) {
    return this.db.tx(async (tx) => {
      const c = ctx();
      await this.customers.requireActive(tx, customerId);
      const note = await this.requireNote(tx, customerId, noteId);
      // Colleagues' notes can only be removed by someone trusted with archiving customers.
      if (note.authorId !== c.userId && !can('customer.archive')) {
        throw Errors.forbidden('NOTE_NOT_YOURS', 'You can only delete your own notes.');
      }
      await tx.customerNote.delete({ where: { id: noteId } });
      await this.audit.log({ action: 'customer.note_deleted', resourceType: 'Customer', resourceId: customerId, before: { noteId, authorId: note.authorId, isPinned: note.isPinned } }, tx);
      return { status: 'DELETED' as const };
    });
  }

  // ------------------------------------------------------------------ tags
  listTags() {
    return this.db.tx(async (tx) => {
      const rows = await tx.customerTag.findMany({ where: { tenantId: this.db.tenantId }, include: { _count: { select: { customerTagAssignments: true } } }, orderBy: { name: 'asc' } });
      return rows.map(({ _count, ...t }) => ({ ...t, customerCount: _count.customerTagAssignments }));
    });
  }

  private async assertTagNameFree(tx: Tx, name: string, exceptId?: string) {
    const clash = await tx.customerTag.findFirst({ where: { tenantId: this.db.tenantId, name: { equals: name, mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true } });
    if (clash) throw Errors.conflict('DUPLICATE_TAG', `There is already a tag called "${name}".`);
  }

  createTag(input: CustomerTagInput) {
    return this.db.tx(async (tx) => {
      await this.assertTagNameFree(tx, input.name);
      const tag = await tx.customerTag.create({ data: { tenantId: this.db.tenantId, name: input.name, color: input.color ?? null } });
      await this.audit.log({ action: 'customer_tag.created', resourceType: 'CustomerTag', resourceId: tag.id, after: { name: tag.name, color: tag.color } }, tx);
      return { ...tag, customerCount: 0 };
    });
  }

  updateTag(id: string, input: Partial<CustomerTagInput>) {
    return this.db.tx(async (tx) => {
      const before = found(await tx.customerTag.findFirst({ where: { id, tenantId: this.db.tenantId } }), 'Tag');
      if (input.name && input.name.toLowerCase() !== before.name.toLowerCase()) await this.assertTagNameFree(tx, input.name, id);
      const after = await tx.customerTag.update({ where: { id }, data: { name: input.name, color: input.color } });
      await this.audit.log({ action: 'customer_tag.updated', resourceType: 'CustomerTag', resourceId: id, before: { name: before.name, color: before.color }, after: { name: after.name, color: after.color } }, tx);
      return after;
    });
  }

  deleteTag(id: string) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const tag = found(await tx.customerTag.findFirst({ where: { id, tenantId } }), 'Tag');
      const used = await tx.customerTagAssignment.count({ where: { tenantId, tagId: id } });
      await tx.customerTag.delete({ where: { id } });
      await this.audit.log({ action: 'customer_tag.deleted', resourceType: 'CustomerTag', resourceId: id, before: { name: tag.name, removedFromCustomers: used } }, tx);
      return { status: 'DELETED' as const, removedFromCustomers: used };
    });
  }

  private tagsOf(tx: Tx, customerId: string) {
    return tx.customerTagAssignment
      .findMany({ where: { tenantId: this.db.tenantId, customerId }, select: { tag: { select: { id: true, name: true, color: true } } }, orderBy: { tag: { name: 'asc' } } })
      .then((rows) => rows.map((r) => r.tag));
  }

  /** Replaces the whole tag set of a customer. */
  setTags(customerId: string, tagIds: string[]) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      await this.customers.requireActive(tx, customerId);
      const next = [...new Set(tagIds)];
      if (next.length && (await tx.customerTag.count({ where: { tenantId, id: { in: next } } })) !== next.length) throw Errors.notFound('Tag');
      const before = (await tx.customerTagAssignment.findMany({ where: { tenantId, customerId }, select: { tagId: true } })).map((a) => a.tagId);
      await tx.customerTagAssignment.deleteMany({ where: { tenantId, customerId, tagId: { notIn: next } } });
      const add = next.filter((t) => !before.includes(t));
      if (add.length) await tx.customerTagAssignment.createMany({ data: add.map((tagId) => ({ tenantId, customerId, tagId })) });
      await this.audit.log({ action: 'customer.tags_changed', resourceType: 'Customer', resourceId: customerId, before: { tagIds: before }, after: { tagIds: next } }, tx);
      return this.tagsOf(tx, customerId);
    });
  }

  assignTag(customerId: string, tagId: string) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      await this.customers.requireActive(tx, customerId);
      const tag = found(await tx.customerTag.findFirst({ where: { id: tagId, tenantId } }), 'Tag');
      const existing = await tx.customerTagAssignment.findFirst({ where: { tenantId, customerId, tagId }, select: { id: true } });
      if (!existing) {
        await tx.customerTagAssignment.create({ data: { tenantId, customerId, tagId } });
        await this.audit.log({ action: 'customer.tag_assigned', resourceType: 'Customer', resourceId: customerId, after: { tagId, name: tag.name } }, tx);
      }
      return this.tagsOf(tx, customerId);
    });
  }

  unassignTag(customerId: string, tagId: string) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      await this.customers.requireActive(tx, customerId);
      const removed = await tx.customerTagAssignment.deleteMany({ where: { tenantId, customerId, tagId } });
      if (!removed.count) throw Errors.notFound('Tag assignment');
      await this.audit.log({ action: 'customer.tag_removed', resourceType: 'Customer', resourceId: customerId, before: { tagId } }, tx);
      return this.tagsOf(tx, customerId);
    });
  }

  // ------------------------------------------------------------------ contacts (one primary per type)
  listContacts(customerId: string) {
    return this.db.tx(async (tx) => {
      await this.customers.require(tx, customerId);
      return tx.customerContact.findMany({ where: { tenantId: this.db.tenantId, customerId }, orderBy: [{ type: 'asc' }, { isPrimary: 'desc' }, { createdAt: 'asc' }] });
    });
  }

  private async assertContactFree(tx: Tx, customerId: string, type: string, value: string, exceptId?: string) {
    const clash = await tx.customerContact.findFirst({ where: { tenantId: this.db.tenantId, customerId, type, value, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true } });
    if (clash) throw Errors.conflict('DUPLICATE_CONTACT', 'This contact detail is already on the customer.');
  }
  private clearPrimary(tx: Tx, customerId: string, type: string, exceptId?: string) {
    return tx.customerContact.updateMany({ where: { tenantId: this.db.tenantId, customerId, type, isPrimary: true, ...(exceptId ? { id: { not: exceptId } } : {}) }, data: { isPrimary: false } });
  }

  addContact(customerId: string, input: CustomerContactInput) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      await this.customers.requireActive(tx, customerId);
      await this.assertContactFree(tx, customerId, input.type, input.value);
      // The first contact of a type is the primary one.
      const first = !(await tx.customerContact.count({ where: { tenantId, customerId, type: input.type } }));
      const isPrimary = input.isPrimary || first;
      if (isPrimary) await this.clearPrimary(tx, customerId, input.type);
      const contact = await tx.customerContact.create({ data: { tenantId, customerId, type: input.type, value: input.value, label: input.label ?? null, isPrimary } });
      await this.audit.log({ action: 'customer.contact_added', resourceType: 'Customer', resourceId: customerId, after: { contactId: contact.id, type: contact.type, value: contact.value, isPrimary } }, tx);
      return contact;
    });
  }

  updateContact(customerId: string, contactId: string, input: UpdateCustomerContactInput) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      await this.customers.requireActive(tx, customerId);
      const before = found(await tx.customerContact.findFirst({ where: { id: contactId, customerId, tenantId } }), 'Contact');
      let value: string | undefined;
      if (input.value !== undefined) {
        const checked = normaliseContactValue(before.type as ContactType, input.value);
        if (!checked.ok) throw Errors.badRequest('VALIDATION_FAILED', checked.message, [{ path: 'value', message: checked.message }]);
        value = checked.value;
        if (value !== before.value) await this.assertContactFree(tx, customerId, before.type, value, contactId);
      }
      if (input.isPrimary === false && before.isPrimary) {
        throw Errors.unprocessable('PRIMARY_CONTACT_REQUIRED', 'Make another contact of this type the primary one instead.');
      }
      if (input.isPrimary === true) await this.clearPrimary(tx, customerId, before.type, contactId);
      const after = await tx.customerContact.update({ where: { id: contactId }, data: { value, label: input.label, isPrimary: input.isPrimary } });
      await this.audit.log(
        { action: 'customer.contact_updated', resourceType: 'Customer', resourceId: customerId, before: { contactId, value: before.value, label: before.label, isPrimary: before.isPrimary }, after: { contactId, value: after.value, label: after.label, isPrimary: after.isPrimary } },
        tx,
      );
      return after;
    });
  }

  removeContact(customerId: string, contactId: string) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      await this.customers.requireActive(tx, customerId);
      const contact = found(await tx.customerContact.findFirst({ where: { id: contactId, customerId, tenantId } }), 'Contact');
      await tx.customerContact.delete({ where: { id: contactId } });
      // If the primary contact went away, the oldest remaining one of that type takes over.
      if (contact.isPrimary) {
        const next = await tx.customerContact.findFirst({ where: { tenantId, customerId, type: contact.type }, orderBy: { createdAt: 'asc' } });
        if (next) await tx.customerContact.update({ where: { id: next.id }, data: { isPrimary: true } });
      }
      await this.audit.log({ action: 'customer.contact_removed', resourceType: 'Customer', resourceId: customerId, before: { contactId, type: contact.type, value: contact.value } }, tx);
      return { status: 'DELETED' as const };
    });
  }
}
