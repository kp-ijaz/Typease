import { Actor, PASSWORD, TenantFixture, TestApp, uniq } from '../../../test/helpers';
import { ErasureRegistry } from '../../common/erasure';
import { activeAccount, addCorporateAdmin, employeeBody } from '../corporate/fixtures';
import { uploadDocument } from '../documents/fixtures';
import { issueInvoice, line, recordPayment } from '../finance/fixtures';
import { emit } from '../notifications/fixtures';
import { LogProvider } from '../notifications/providers/log';
import { createService } from '../requests/fixtures';
import { StorageService } from '../storage/storage.service';
import { ERASURE_FINALISE_JOB } from './dsr.service';

/**
 * Erasure across modules: after a deletion request is carried out, nothing in
 * the centre's data says who the person was - while the records the centre has
 * to keep (invoices, payments, credit notes, the audit trail) are still there,
 * with unchanged figures, pointing at an anonymous customer record.
 */
describe('Privacy: erasure across modules', () => {
  let t: TestApp;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let accountant: Actor;
  let receptionist: Actor;
  let reviewer: Actor;

  beforeAll(async () => {
    t = await TestApp.create();
    alpha = await t.createTenant({ name: 'Alpha Typing' });
    beta = await t.createTenant({ name: 'Beta Typing' });
    accountant = await t.addStaff(alpha, 'accountant');
    receptionist = await t.addStaff(alpha, 'receptionist');
    reviewer = await t.addStaff(alpha, 'reviewer');
    await t.settle();
  });
  afterAll(() => t.close());

  /**
   * Counts, per table, the rows that still contain one of the given values (raw SQL over the whole row as text).
   * `scope`: only rows of that centre, or those rows plus everything that belongs to no centre (the platform-wide
   * tables: users, sessions, tokens, sign-in history).
   */
  async function findValues(needles: string[], scope: { tenantId: string; global: boolean }): Promise<Record<string, number>> {
    const tables = await t.sys.$queryRaw<Array<{ name: string; tenant: boolean }>>`
      SELECT c.table_name AS name, bool_or(c.column_name = 'tenantId') AS tenant
      FROM information_schema.columns c JOIN information_schema.tables tb ON tb.table_name = c.table_name AND tb.table_schema = c.table_schema
      WHERE c.table_schema = 'public' AND tb.table_type = 'BASE TABLE' GROUP BY c.table_name ORDER BY c.table_name`;
    expect(tables.length).toBeGreaterThan(100);
    const patterns = needles.map((n) => `%${n.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
    const hits: Record<string, number> = {};
    for (const table of tables) {
      if (!table.tenant && !scope.global) continue;
      const where = table.tenant ? (scope.global ? `("tenantId" = $2::uuid OR "tenantId" IS NULL) AND` : `"tenantId" = $2::uuid AND`) : '';
      const rows = await t.sys.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT count(*)::int AS n FROM "${table.name}" x WHERE ${where} to_jsonb(x)::text ILIKE ANY($1::text[])`,
        ...[patterns, ...(table.tenant ? [scope.tenantId] : [])],
      );
      if (rows[0].n) hits[table.name] = rows[0].n;
    }
    return hits;
  }
  const approve = (id: string) => t.as(alpha.owner).post(`/privacy/requests/${id}/decision`, { decision: 'APPROVED', decisionNote: 'Identity confirmed at the counter.' }).expect(200);
  const complete = (id: string, by: Actor = alpha.owner) => t.as(by).post(`/privacy/requests/${id}/complete`, {});
  const login = (email: string, tenant: TenantFixture) => t.http.post('/api/v1/auth/login').send({ email, password: PASSWORD, app: 'customer', tenantSlug: tenant.slug });

  // ============================================================================================
  describe('a customer with data in every module, who is also a customer of another centre', () => {
    const id = uniq();
    const person = {
      name: 'Zainab Al Farouqi', nameAr: 'زينب الفاروقي', email: `zainab.${id}@example.test`, altEmail: `z.farouqi.${id}@example.test`,
      phone: `+9715${String(Date.now()).slice(-8)}`, altPhone: `+9714${String(Date.now()).slice(-7)}`,
      emiratesId: `784${String(Date.now()).slice(-12)}`, passport: `ZF${String(Date.now()).slice(-7)}`, oldPassport: `ZG${String(Date.now()).slice(-7)}`,
    };
    const needles = () => [person.name, 'ZAINAB AL FAROUQI', person.nameAr, person.email, person.altEmail, person.phone.slice(1), person.altPhone.slice(1), person.emiratesId, person.passport, person.oldPassport, 'zainab-passport'];
    let customer: Actor;
    let customerId: string;
    let duplicateId: string;
    let requestId: string;
    let dsrId: string;
    const keep: Record<string, any> = {};
    let betaCustomerId: string;

    const report = async (key: string) => {
      const res = await t.as(accountant).get(`/reports/${key}?range=month_to_date`).expect(200);
      return { totals: res.body.totals, rows: res.body.rows.length };
    };

    beforeAll(async () => {
      // ---- the person registers on the portal; staff complete the profile (all through the API: the audit trail fills up)
      customer = await t.addCustomer(alpha, { fullName: person.name, email: person.email });
      customerId = customer.customerId!;
      await t.as(alpha.owner).patch(`/customers/${customerId}`, {
        fullNameAr: person.nameAr, phone: person.phone, nationality: 'PK', dateOfBirth: '1990-04-12', address: { line1: 'Villa 12, Al Wasl Road', city: 'Dubai' },
        emiratesId: person.emiratesId, passportNo: person.passport, passportCountry: 'PK',
      }).expect(200);
      await t.as(alpha.owner).post(`/customers/${customerId}/contacts`, { type: 'EMAIL', value: person.altEmail, label: 'Work' }).expect(201);
      await t.as(alpha.owner).post(`/customers/${customerId}/contacts`, { type: 'PHONE', value: person.altPhone, label: 'Home' }).expect(201);
      await t.as(alpha.owner).post(`/customers/${customerId}/notes`, { body: `${person.name} prefers to be called after 5 pm on ${person.altPhone}.` }).expect(201);

      // ---- an older duplicate record with an invoice and a payment, merged into the main record (they stay on the retired id)
      const duplicate = (await t.as(alpha.owner).post('/customers', { fullName: person.name, passportNo: person.oldPassport, passportCountry: 'PK', confirmNotDuplicate: true }).expect(201)).body;
      duplicateId = duplicate.id;
      keep.oldInvoice = (await issueInvoice(t, accountant, duplicateId)).id;
      keep.oldPayment = (await recordPayment(t, receptionist, { method: 'CASH', amount: '305.00', branchId: alpha.headOfficeId, allocations: [{ invoiceId: keep.oldInvoice, amount: '305.00' }] }).expect(201)).body.id;
      await t.as(alpha.owner).post('/customers/merge', { targetId: customerId, sourceId: duplicateId, confirmSourceCustomerNo: duplicate.customerNo, reason: `Same person: ${person.name}` }).expect(200);

      // ---- a request with form data, instructions and comments
      const service = await createService(t, alpha);
      const request = (await t.as(customer).post('/requests', { serviceId: service.id, fields: { purpose: 'work', sponsor: `${person.name} Trading` }, instructions: `Please call me on ${person.phone}.` }).expect(201)).body;
      requestId = request.id;
      await t.as(customer).post(`/requests/${requestId}/comments`, { body: `This is ${person.name}; my passport number is ${person.passport}.` }).expect(201);
      await t.as(alpha.owner).post(`/requests/${requestId}/comments`, { body: `Called ${person.name} on ${person.phone}.`, visibility: 'INTERNAL' }).expect(201);
      await t.as(alpha.owner).post('/tasks', { title: `Call ${person.name}`, description: `Phone ${person.phone} about the visa.`, requestId, branchId: alpha.headOfficeId }).expect(201);

      // ---- documents: an upload by the person (file name, share link, extraction, verified expiry -> reminder) and one under legal hold
      const passport = await uploadDocument(t, customer, { title: `Passport of ${person.name}` }, { filename: 'zainab-passport.pdf' });
      keep.passportDoc = passport.documentId;
      keep.passportKey = (await t.sys.documentVersion.findUniqueOrThrow({ where: { id: passport.versionId } })).storageKey;
      await t.as(alpha.owner).post(`/documents/${passport.documentId}/shares`, { recipient: person.altEmail }).expect(201);
      await t.as(reviewer).post(`/documents/${passport.documentId}/verify`, { decision: 'APPROVED', expiryDate: new Date(Date.now() + 400 * 86400_000).toISOString().slice(0, 10) }).expect(200);
      await t.sys.ocrExtractionResult.create({ data: { tenantId: alpha.id, documentId: passport.documentId, versionId: passport.versionId, provider: 'test', profile: 'PASSPORT', status: 'COMPLETED', fields: [{ key: 'fullName', value: 'ZAINAB AL FAROUQI', confidence: 0.9, source: 'MRZ' }, { key: 'passportNumber', value: person.passport, confidence: 0.9, source: 'MRZ' }] } });
      const held = await uploadDocument(t, alpha.owner, { customerId, title: 'Disputed contract' }, { filename: 'contract.pdf' });
      keep.heldDoc = held.documentId;
      keep.heldKey = (await t.sys.documentVersion.findUniqueOrThrow({ where: { id: held.versionId } })).storageKey;
      await t.as(alpha.owner).put(`/documents/${held.documentId}/legal-hold`, { legalHold: true, reason: 'Open dispute' }).expect(200);
      await t.sys.ocrExtractionResult.create({ data: { tenantId: alpha.id, documentId: held.documentId, versionId: held.versionId, provider: 'test', profile: 'AUTO', status: 'COMPLETED', fields: [{ key: 'fullName', value: person.name, confidence: 0.7, source: 'TEXT' }] } });

      // ---- finance: quotation, paid invoice, part-credited invoice - with the person's name in the free text
      keep.quotation = (await t.as(receptionist).post('/quotations', { customerId, requestId, notes: `Quoted to ${person.name} by phone`, items: [line('SERVICE_FEE', '80.00')] }).expect(201)).body.id;
      const draft = (await t.as(accountant).post('/invoices', { customerId, requestId, notes: `Invoice for ${person.name}`, items: [line('SERVICE_FEE', '100.00'), line('GOVERNMENT_FEE', '200.00')] }).expect(201)).body;
      keep.invoice = (await t.as(accountant).post(`/invoices/${draft.id}/issue`).expect(200)).body.id;
      keep.payment = (await recordPayment(t, receptionist, { method: 'CASH', amount: '200.00', branchId: alpha.headOfficeId, notes: `Cash from ${person.name}`, allocations: [{ invoiceId: keep.invoice, amount: '200.00' }] }).expect(201)).body.id;
      keep.creditNote = (await t.as(accountant).post('/credit-notes', { invoiceId: keep.invoice, amount: '50.00', reason: `Goodwill for ${person.name}` }).expect(201)).body.id;

      // ---- the case is closed; notifications went out on the way
      await t.sys.serviceRequest.update({ where: { id: requestId }, data: { status: 'COMPLETED', completedAt: new Date() } });
      await t.sys.requestStatusHistory.create({ data: { tenantId: alpha.id, requestId, fromStatus: 'IN_PREPARATION', toStatus: 'COMPLETED', actorType: 'STAFF', reason: `${person.name} collected the documents`, customerMessage: `Dear ${person.name}, your visa is ready.` } });
      await emit(t, alpha.id, 'request.completed', { requestId, customerId });
      // A message to staff that names the person, about the person's request.
      await t.sys.notification.create({ data: { tenantId: alpha.id, recipientUserId: alpha.owner.userId, eventKey: 'request.assigned_to_you', channel: 'IN_APP', subject: 'Request assigned', body: `The request of ${person.name} was assigned to you.`, status: 'SENT', relatedType: 'ServiceRequest', relatedId: requestId } });

      // ---- appointments, support, feedback
      keep.pastAppointment = (await t.sys.appointment.create({ data: { tenantId: alpha.id, branchId: alpha.headOfficeId, customerId, startsAt: new Date(Date.now() - 3 * 86400_000), endsAt: new Date(Date.now() - 3 * 86400_000 + 1800_000), status: 'COMPLETED', notes: `${person.name} came with her brother.` } })).id;
      keep.nextAppointment = (await t.sys.appointment.create({ data: { tenantId: alpha.id, branchId: alpha.headOfficeId, customerId, startsAt: new Date(Date.now() + 5 * 86400_000), endsAt: new Date(Date.now() + 5 * 86400_000 + 1800_000), status: 'BOOKED', notes: `Call ${person.phone} if late.` } })).id;
      keep.ticket = (await t.as(customer).post('/me/tickets', { subject: `Question from ${person.name}`, message: `My Emirates ID is ${person.emiratesId}. When is my visa ready?` }).expect(201)).body.id;
      await t.as(alpha.owner).post(`/support/tickets/${keep.ticket}/messages`, { body: `Dear ${person.name}, it is ready.`, visibility: 'CUSTOMER' }).expect(201);
      await t.sys.customerFeedback.create({ data: { tenantId: alpha.id, customerId, requestId, rating: 5, comment: `Thank you - ${person.name}` } });
      await t.settle();

      // ---- the same login is also a customer of another centre (invited there by that centre's staff)
      const there = (await t.as(beta.owner).post('/customers', { fullName: person.name, email: person.email }).expect(201)).body;
      betaCustomerId = there.id;
      const invitation = await t.as(beta.owner).post(`/customers/${there.id}/portal-invitation`, {}).expect(201);
      await t.http.post('/api/v1/auth/invitations/accept').send({ token: invitation.body.dev.invitationToken, app: 'customer' }).expect(200);

      dsrId = (await t.as(customer).post('/privacy/my/requests', { type: 'DELETION', details: `I, ${person.name}, ask you to delete my data.` }).expect(201)).body.id;
      await t.settle();
    });

    it('the starting point: the person is all over the centre\'s data', async () => {
      const before = await findValues(needles(), { tenantId: alpha.id, global: false });
      for (const table of [
        'customers', 'customer_contacts', 'customer_notes', 'request_fields', 'request_comments', 'request_status_history', 'service_requests', 'tasks', 'documents', 'document_versions',
        'document_shares', 'ocr_extraction_results', 'reminder_schedules', 'quotations', 'invoices', 'payments', 'credit_notes', 'notifications', 'appointments', 'support_tickets',
        'support_messages', 'customer_feedback', 'data_subject_requests', 'audit_logs',
      ]) {
        expect([table, (before[table] ?? 0) > 0]).toEqual([table, true]);
      }
      // Every module that holds something about a person takes part in an erasure.
      expect(t.get(ErasureRegistry).names().sort()).toEqual(['appointments', 'corporate', 'customers', 'documents', 'finance', 'leads', 'notifications', 'ocr', 'paperwork', 'privacy', 'reminders', 'requests', 'support', 'tasks', 'whatsapp']);
      // The centre sent the person messages by email.
      expect(LogProvider.outbox.some((m) => m.message.to === person.email)).toBe(true);
    });

    it('is carried out by the privacy officer only, and leaves nothing that says who the person was', async () => {
      await approve(dsrId);
      await complete(dsrId, receptionist).expect(403);
      await complete(dsrId, beta.owner).expect(404);
      const figures = { sales: await report('daily-sales'), revenue: await report('monthly-service-revenue'), liabilities: await report('liabilities') };
      const money = async () => ({
        invoices: (await t.sys.invoice.findMany({ where: { tenantId: alpha.id }, orderBy: { id: 'asc' } })).map((i) => [i.id, i.invoiceNo, i.customerId, i.status, i.total.toFixed(2), i.amountPaid.toFixed(2), i.amountCredited.toFixed(2), i.balanceDue.toFixed(2)]),
        payments: (await t.sys.payment.findMany({ where: { tenantId: alpha.id }, orderBy: { id: 'asc' } })).map((p) => [p.id, p.paymentNo, p.receiptNo, p.customerId, p.status, p.amount.toFixed(2), p.method]),
        creditNotes: (await t.sys.creditNote.findMany({ where: { tenantId: alpha.id }, orderBy: { id: 'asc' } })).map((c) => [c.id, c.creditNoteNo, c.invoiceId, c.amount.toFixed(2)]),
        ledger: (await t.sys.liabilityEntry.findMany({ where: { tenantId: alpha.id }, orderBy: { id: 'asc' } })).map((l) => [l.id, l.component, l.direction, l.amount.toFixed(2)]),
      });
      const moneyBefore = await money();
      const auditCount = await t.sys.auditLog.count({ where: { tenantId: alpha.id } });

      // One invoice still has a balance: the one rule (open requests, unpaid invoices) applies, with the invoice named.
      const blocked = await complete(dsrId).expect(409);
      expect(blocked.body.code).toBe('ERASURE_BLOCKED');
      expect(blocked.body.details).toMatchObject({ openRequests: 0, unpaidInvoices: 1, blocking: { requests: [], invoices: [{ id: keep.invoice, invoiceNo: expect.stringMatching(/^INV-\d+$/), balanceDue: '55.00', currency: 'AED' }] } });
      expect(blocked.body.message).toMatch(/1 invoice\(s\) are unpaid \(INV-\d+\)/);
      // A blocked erasure changes nothing: not the record, not the trail, not the figures.
      expect((await t.sys.customer.findUniqueOrThrow({ where: { id: customerId } })).fullName).toBe(person.name);
      expect((await t.sys.auditLog.findFirstOrThrow({ where: { tenantId: alpha.id, action: 'customer.contact_added', resourceId: customerId } })).after).toMatchObject({ value: expect.stringMatching(/example\.test|^\+971/) });
      expect(await money()).toEqual(moneyBefore);
      expect({ sales: await report('daily-sales'), revenue: await report('monthly-service-revenue'), liabilities: await report('liabilities') }).toEqual(figures);
      expect(await t.sys.auditLog.count({ where: { tenantId: alpha.id } })).toBe(auditCount + 1); // privacy.erasure_blocked
      // The customer settles the balance.
      await recordPayment(t, receptionist, { method: 'CASH', amount: '55.00', branchId: alpha.headOfficeId, allocations: [{ invoiceId: keep.invoice, amount: '55.00' }] }).expect(201);
      const moneySettled = await money();
      const figuresSettled = { sales: await report('daily-sales'), revenue: await report('monthly-service-revenue'), liabilities: await report('liabilities') };

      const erasedAt = new Date();
      const done = await complete(dsrId).expect(200);
      expect(done.body.status).toBe('COMPLETED');
      expect(done.body.retentionException).toBe(
        'Retained: 2 issued invoice(s) and 3 payment record(s) are kept unchanged because financial records are immutable; they remain linked to the anonymised customer record; ' +
          '1 closed service request(s) are kept as business records, without the submitted form data, instructions, comments and messages; ' +
          '1 document(s) are kept because they are under legal hold, a fixed retention date or used by another open request; ' +
          'the login account itself is kept because it is also used for another centre or another role; only the access to this centre was removed.',
      );
      await t.settle(); // the finalise job: files are removed from storage

      // ---- raw SQL: no row of this centre contains the name, the addresses, the numbers or the file name any more
      const left = await findValues(needles(), { tenantId: alpha.id, global: false });
      expect(left).toEqual({});

      // ---- the API says the same
      const profile = (await t.as(alpha.owner).get(`/customers/${customerId}`).expect((res) => expect([200, 404]).toContain(res.status))).body;
      expect(JSON.stringify(profile)).not.toMatch(new RegExp(`Zainab|${person.email}|${person.phone.slice(1)}`, 'i'));
      for (const path of [`/customers?q=Zainab&status=ALL`, `/customers?q=${encodeURIComponent(person.email)}&status=ALL`, `/requests/${requestId}`, `/requests/${requestId}/comments`, `/support/tickets/${keep.ticket}`, `/invoices/${keep.invoice}`, `/payments/${keep.payment}`, `/quotations/${keep.quotation}`, `/audit-logs?pageSize=100`, `/documents?customerId=${customerId}&includeDeleted=true`, `/reminders?customerId=${customerId}`, `/tasks?pageSize=100`, `/notifications/log?pageSize=100`]) {
        const res = await t.as(alpha.owner).get(path);
        expect([path, res.status < 500]).toEqual([path, true]);
        expect([path, /Zainab|زينب|zainab\.|z\.farouqi|ZF\d{7}|ZG\d{7}/i.test(JSON.stringify(res.body))]).toEqual([path, false]);
        expect([path, JSON.stringify(res.body).includes(person.phone.slice(1)) || JSON.stringify(res.body).includes(person.emiratesId)]).toEqual([path, false]);
      }

      // ---- what each module did
      const c = await t.sys.customer.findUniqueOrThrow({ where: { id: customerId } });
      expect(c).toMatchObject({ status: 'ANONYMISED', fullName: 'Erased customer', fullNameAr: null, email: null, phone: null, emiratesIdEnc: null, emiratesIdHash: null, passportNoEnc: null, passportNoHash: null, passportNoLast4: null });
      // The merged-away record lost its copy of the name and passport number, and still points at the kept record.
      expect(await t.sys.customer.findUniqueOrThrow({ where: { id: duplicateId } })).toMatchObject({ status: 'MERGED', mergedIntoId: customerId, fullName: 'Erased customer', passportNoEnc: null, passportNoHash: null, passportNoLast4: null });
      expect(await t.sys.customerContact.count({ where: { customerId } })).toBe(0);
      expect(await t.sys.customerNote.count({ where: { customerId } })).toBe(0);
      // Requests: kept as a business record, without what the person told the centre.
      expect(await t.sys.serviceRequest.findUniqueOrThrow({ where: { id: requestId } })).toMatchObject({ status: 'COMPLETED', customerId, customerInstructions: null, trackingCodeHash: null });
      expect(await t.sys.requestField.count({ where: { requestId } })).toBe(0);
      expect((await t.sys.requestComment.findMany({ where: { requestId } })).map((m) => m.body)).toEqual(['[erased]', '[erased]']);
      expect((await t.sys.requestStatusHistory.findMany({ where: { requestId, reason: { not: null } } })).every((h) => h.reason === '[erased]')).toBe(true);
      expect((await t.sys.task.findFirstOrThrow({ where: { tenantId: alpha.id, requestId, source: 'MANUAL' } }))).toMatchObject({ title: 'Call [erased]', description: null });
      // Documents: deleted and purged, except the one under legal hold (kept as it is, without share links and extractions).
      expect(await t.sys.document.findUniqueOrThrow({ where: { id: keep.passportDoc } })).toMatchObject({ status: 'DELETED', title: 'Erased document' });
      expect((await t.sys.documentVersion.findMany({ where: { documentId: keep.passportDoc } })).map((v) => [v.uploadStatus, v.originalFilename])).toEqual([['PURGED', 'purged']]);
      const storage = t.get(StorageService);
      expect(await storage.head(keep.passportKey)).toBeNull();
      expect(await storage.head(keep.heldKey)).not.toBeNull();
      expect(await t.sys.document.findUniqueOrThrow({ where: { id: keep.heldDoc } })).toMatchObject({ status: 'AVAILABLE', legalHold: true, title: 'Disputed contract' });
      expect(await t.sys.ocrExtractionResult.count({ where: { documentId: { in: [keep.passportDoc, keep.heldDoc] } } })).toBe(0);
      expect((await t.sys.documentShare.findMany({ where: { documentId: keep.passportDoc } })).map((s) => [s.recipient, !!s.revokedAt])).toEqual([[null, true]]);
      await t.as(alpha.owner).post(`/documents/${keep.passportDoc}/download-link`).expect(404);
      // Reminders gone, upcoming appointment cancelled, past one kept without its note.
      expect(await t.sys.reminderSchedule.count({ where: { customerId } })).toBe(0);
      expect(await t.sys.appointment.findUniqueOrThrow({ where: { id: keep.nextAppointment } })).toMatchObject({ status: 'CANCELLED', notes: null });
      expect(await t.sys.appointment.findUniqueOrThrow({ where: { id: keep.pastAppointment } })).toMatchObject({ status: 'COMPLETED', notes: null });
      // Support: the ticket exists, closed, without its text.
      expect(await t.sys.supportTicket.findUniqueOrThrow({ where: { id: keep.ticket } })).toMatchObject({ subject: 'Erased ticket', status: 'CLOSED' });
      expect((await t.sys.supportMessage.findMany({ where: { ticketId: keep.ticket } })).every((m) => m.body === '[erased]' && m.attachments.length === 0)).toBe(true);
      expect(await t.sys.customerFeedback.findFirstOrThrow({ where: { customerId } })).toMatchObject({ rating: 5, comment: null });
      // Notifications: the history is there as statistics, without content or address.
      const sent = await t.sys.notification.findMany({ where: { tenantId: alpha.id, recipientCustomerId: customerId, createdAt: { lt: erasedAt } } });
      expect(sent.length).toBeGreaterThan(3);
      expect(sent.every((n) => n.body === '[erased]' && n.subject === null && n.recipientAddress === null && JSON.stringify(n.data) === '{}' && n.dedupeKey === `erased:${n.id}`)).toBe(true);
      expect(new Set(sent.map((n) => n.channel)).size).toBeGreaterThan(1);
      // An event that was still on its way when the person was erased (the last payment) reaches nobody: there is no address and no name left.
      const late = await t.sys.notification.findMany({ where: { tenantId: alpha.id, recipientCustomerId: customerId, createdAt: { gte: erasedAt } } });
      expect(late.every((n) => n.status === 'SUPPRESSED' && n.suppressedReason === 'CUSTOMER_INACTIVE' && n.recipientAddress === null)).toBe(true);
      expect(LogProvider.outbox.filter((m) => m.at >= erasedAt && m.message.to === person.email)).toEqual([]);
      expect((await t.sys.notification.findFirstOrThrow({ where: { tenantId: alpha.id, eventKey: 'request.assigned_to_you', relatedId: requestId } })).body).toBe('The request of [erased] was assigned to you.');
      expect((await t.sys.dataSubjectRequest.findUniqueOrThrow({ where: { id: dsrId } })).details).toBeNull();

      // ---- what must be kept is kept, unchanged: every invoice, payment, credit note and ledger entry, and every report figure
      expect(await money()).toEqual(moneySettled);
      expect({ sales: await report('daily-sales'), revenue: await report('monthly-service-revenue'), liabilities: await report('liabilities') }).toEqual(figuresSettled);
      expect(await t.sys.invoice.findUniqueOrThrow({ where: { id: keep.invoice } })).toMatchObject({ customerId, notes: null, status: 'PAID' });
      expect(await t.sys.invoice.findUniqueOrThrow({ where: { id: keep.oldInvoice } })).toMatchObject({ customerId: duplicateId, status: 'PAID' });
      expect((await t.sys.creditNote.findUniqueOrThrow({ where: { id: keep.creditNote } })).reason).toBe('Goodwill for [erased]');
      // Finance still finds everything through the anonymous record, including what stayed on the merged one.
      const listed = (await t.as(accountant).get(`/invoices?customerId=${customerId}&pageSize=100`).expect(200)).body.data;
      expect(listed.map((i: any) => i.id).sort()).toEqual([keep.invoice, keep.oldInvoice].sort());
      expect(listed.every((i: any) => i.customer.fullName === 'Erased customer')).toBe(true);

      // ---- the audit trail is kept (no entry was removed) and says what was done, in numbers
      expect(await t.sys.auditLog.count({ where: { tenantId: alpha.id } })).toBeGreaterThan(auditCount);
      const created = await t.sys.auditLog.findFirstOrThrow({ where: { tenantId: alpha.id, action: 'customer.contact_added', resourceId: customerId } });
      expect(created.after).toMatchObject({ type: expect.any(String), value: '[erased]' });
      const erased = await t.sys.auditLog.findFirstOrThrow({ where: { tenantId: alpha.id, action: 'privacy.customer_anonymised', resourceId: customerId } });
      expect(erased.actorUserId).toBe(alpha.owner.userId);
      expect(erased.after).toMatchObject({
        records: 2, deletedDocuments: 1, keptDocuments: 1, invoices: 2, payments: 3, loginsKept: 1, loginsToAnonymise: 0,
        steps: {
          customers: { records: 1, mergedRecords: 1, contacts: 2, notes: 1 }, requests: { requests: 1, comments: 2 }, documents: { deletedDocuments: 1, keptDocuments: 1 }, ocr: { extractions: 2 },
          reminders: { schedules: 1 }, appointments: { appointments: 2, cancelledUpcoming: 1 }, support: { tickets: 1, messages: 2, feedbackComments: 1 }, tasks: expect.any(Object),
          finance: { retainedInvoices: 2, retainedPayments: 3, retainedCreditNotes: 1 }, notifications: expect.objectContaining({ staffNotifications: 1 }), privacy: { privacyRequests: 1 }, corporate: { employeeRecords: 0 },
        },
        trails: expect.objectContaining({ auditEntries: expect.any(Number), statusHistory: expect.any(Number) }),
      });
      expect((erased.after as any).trails.auditEntries).toBeGreaterThan(3);
      expect(await t.sys.auditLog.count({ where: { tenantId: alpha.id, action: 'document.erased', resourceId: keep.passportDoc } })).toBe(1);
      expect(await t.sys.auditLog.count({ where: { tenantId: alpha.id, action: 'privacy.request_completed', resourceId: dsrId } })).toBe(1);
    });

    it('the person can no longer sign in to this centre, but keeps the login for the other centre - whose data is untouched', async () => {
      await t.as(customer).get('/documents').expect(401);
      expect((await login(person.email, alpha)).status).toBe(403);
      expect(await t.sys.tenantMembership.count({ where: { tenantId: alpha.id, userId: customer.userId } })).toBe(0);
      expect(await t.sys.session.count({ where: { tenantId: alpha.id, userId: customer.userId } })).toBe(0);
      // The global account is intact: same address, same name, still active.
      expect(await t.sys.user.findUniqueOrThrow({ where: { id: customer.userId } })).toMatchObject({ email: person.email, fullName: person.name, status: 'ACTIVE', deletedAt: null });
      const there = await t.login(person.email, PASSWORD, 'customer', beta.slug);
      expect(there.customerId).toBe(betaCustomerId);
      expect((await t.as(there).get('/me/customer').expect(200)).body).toMatchObject({ fullName: person.name, email: person.email });
      expect(await t.sys.customer.findUniqueOrThrow({ where: { id: betaCustomerId } })).toMatchObject({ status: 'ACTIVE', fullName: person.name, email: person.email });
      // Nothing was redacted in the other centre's trail either.
      expect((await findValues([person.email], { tenantId: beta.id, global: false })).customers).toBe(1);
      expect(await t.sys.auditLog.count({ where: { tenantId: beta.id, action: { startsWith: 'privacy.' } } })).toBe(0);
    });

    it('a document that had to be kept is deleted as soon as the legal hold is released', async () => {
      const storage = t.get(StorageService);
      await t.jobs.runScheduled('documents.purge');
      expect(await storage.head(keep.heldKey)).not.toBeNull(); // still on hold
      await t.as(alpha.owner).put(`/documents/${keep.heldDoc}/legal-hold`, { legalHold: false, reason: 'Dispute settled' }).expect(200);
      await t.jobs.runScheduled('documents.purge');
      expect(await t.sys.document.findUniqueOrThrow({ where: { id: keep.heldDoc } })).toMatchObject({ status: 'DELETED', title: 'Erased document', legalHold: false });
      expect((await t.sys.documentVersion.findMany({ where: { documentId: keep.heldDoc } })).map((v) => [v.uploadStatus, v.originalFilename])).toEqual([['PURGED', 'purged']]);
      expect(await storage.head(keep.heldKey)).toBeNull();
      expect(await t.sys.auditLog.count({ where: { tenantId: alpha.id, action: 'document.erased', resourceId: keep.heldDoc } })).toBe(1);
      // Documents of customers who were not erased are not touched by this.
      expect(await t.sys.document.count({ where: { tenantId: beta.id, status: 'DELETED' } })).toBe(0);
    });

    it('staff still reach the erased customer - as a stub that cannot be changed and is marked as erased wherever it is mentioned', async () => {
      // ---- the stub: found, with nothing personal on it
      const stub = (await t.as(receptionist).get(`/customers/${customerId}`).expect(200)).body;
      expect(stub).toMatchObject({
        id: customerId, status: 'ANONYMISED', erased: true, erasedAt: expect.any(String), fullName: 'Erased customer', fullNameAr: null, email: null, phone: null, nationality: null, dateOfBirth: null, address: null,
        emiratesIdMasked: null, hasEmiratesId: false, passportNoMasked: null, hasPassport: false, passportCountry: null, marketingOptIn: false,
        contacts: [], pinnedNotes: [], tags: [], portalAccess: { status: 'NONE', email: null },
        mergedFrom: [{ id: duplicateId, fullName: 'Erased customer', erased: true }],
        counters: { openRequests: 0, totalRequests: 1, unpaidInvoices: 0 },
      });
      for (const needle of needles()) expect(JSON.stringify(stub)).not.toContain(needle);
      // The record that was merged into it says the same.
      const merged = (await t.as(receptionist).get(`/customers/${duplicateId}`).expect(200)).body;
      expect(merged).toMatchObject({ status: 'MERGED', erased: true, fullName: 'Erased customer', mergedInto: { id: customerId, fullName: 'Erased customer', erased: true } });
      expect(merged.mergedInto).not.toHaveProperty('status');
      // The read-only sub-resources answer, empty.
      expect((await t.as(receptionist).get(`/customers/${customerId}/notes`).expect(200)).body.data ?? []).toEqual([]);
      await t.as(alpha.owner).get(`/customers/${customerId}/activity`).expect(200);
      // Another centre has no such record.
      await t.as(beta.owner).get(`/customers/${customerId}`).expect(404);

      // ---- lists, search and pickers leave it out; only the explicit filter shows it
      const ids = async (query: string) => (await t.as(receptionist).get(`/customers?pageSize=100${query}`).expect(200)).body.data.map((c: any) => c.id);
      for (const query of ['', '&status=ALL', '&q=Erased', '&status=ALL&q=Erased%20customer', '&status=ARCHIVED']) expect([query, (await ids(query)).includes(customerId)]).toEqual([query, false]);
      const explicit = (await t.as(receptionist).get('/customers?status=ANONYMISED&pageSize=100').expect(200)).body.data;
      expect(explicit.find((c: any) => c.id === customerId)).toMatchObject({ status: 'ANONYMISED', erased: true, fullName: 'Erased customer', email: null, phone: null });
      expect(explicit.every((c: any) => c.status === 'ANONYMISED')).toBe(true);
      expect((await t.as(receptionist).get('/customers?status=MERGED&pageSize=100').expect(200)).body.data.find((c: any) => c.id === duplicateId)).toMatchObject({ status: 'MERGED', erased: true });
      expect((await t.as(receptionist).post('/customers/duplicates/check', { fullName: 'Erased customer' }).expect(200)).body.candidates ?? []).toEqual([]);

      // ---- nothing can be changed, and nothing new can be attached to it: 409 CUSTOMER_ERASED
      const service = await createService(t, alpha);
      const other = (await t.as(alpha.owner).post('/customers', { fullName: `Somebody Else ${uniq()}` }).expect(201)).body;
      const tag = (await t.as(alpha.owner).post('/customer-tags', { name: `VIP ${uniq()}` }).expect(201)).body;
      const inDays = (n: number) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);
      const refused: Array<[string, () => any]> = [
        ['update', () => t.as(alpha.owner).patch(`/customers/${customerId}`, { fullName: 'Zainab Again' })],
        ['archive', () => t.as(alpha.owner).post(`/customers/${customerId}/archive`, {})],
        ['restore', () => t.as(alpha.owner).post(`/customers/${customerId}/restore`, {})],
        ['identity', () => t.as(alpha.owner).get(`/customers/${customerId}/identity`)],
        ['note', () => t.as(alpha.owner).post(`/customers/${customerId}/notes`, { body: 'She called again.' })],
        ['contact', () => t.as(alpha.owner).post(`/customers/${customerId}/contacts`, { type: 'EMAIL', value: `new-${uniq()}@example.test` })],
        ['tags', () => t.as(alpha.owner).put(`/customers/${customerId}/tags`, { tagIds: [tag.id] })],
        ['tag', () => t.as(alpha.owner).post(`/customers/${customerId}/tags/${tag.id}`, {})],
        ['consent', () => t.as(alpha.owner).put(`/customers/${customerId}/consents`, { purpose: 'MARKETING', granted: true })],
        ['portal invitation', () => t.as(alpha.owner).post(`/customers/${customerId}/portal-invitation`, { email: `back-${uniq()}@example.test` })],
        ['merge as target', () => t.as(alpha.owner).post('/customers/merge', { targetId: customerId, sourceId: other.id, confirmSourceCustomerNo: other.customerNo, reason: 'Same person' })],
        ['merge as source', () => t.as(alpha.owner).post('/customers/merge', { targetId: other.id, sourceId: customerId, confirmSourceCustomerNo: stub.customerNo, reason: 'Same person' })],
        ['request', () => t.as(alpha.owner).post('/requests', { serviceId: service.id, customerId, fields: { purpose: 'family' } })],
        ['quotation', () => t.as(receptionist).post('/quotations', { customerId, items: [line('SERVICE_FEE', '80.00')] })],
        ['invoice', () => t.as(accountant).post('/invoices', { customerId, items: [line('SERVICE_FEE', '80.00')] })],
        ['reminder', () => t.as(alpha.owner).post('/reminders', { customerId, documentTypeKey: 'passport', expiryDate: inDays(90) })],
        ['task', () => t.as(alpha.owner).post('/tasks', { title: 'Call the customer', customerId, branchId: alpha.headOfficeId })],
        ['privacy request', () => t.as(alpha.owner).post('/privacy/requests', { customerId, type: 'ACCESS' })],
      ];
      for (const [what, call] of refused) {
        const res = await call();
        expect([what, res.status, res.body.code]).toEqual([what, 409, 'CUSTOMER_ERASED']);
      }
      expect(await t.sys.customer.findUniqueOrThrow({ where: { id: customerId } })).toMatchObject({ status: 'ANONYMISED', fullName: 'Erased customer', email: null });
      expect(await t.sys.auditLog.count({ where: { tenantId: alpha.id, action: 'customer.identity_revealed', resourceId: customerId, createdAt: { gt: new Date(stub.erasedAt) } } })).toBe(0);
      expect(await t.sys.serviceRequest.count({ where: { tenantId: alpha.id, customerId } })).toBe(1);

      // ---- wherever the customer is mentioned, the reference says so (and never carries the record status)
      const invoice = (await t.as(accountant).get(`/invoices/${keep.invoice}`).expect(200)).body;
      expect(invoice.customer).toEqual({ id: customerId, customerNo: stub.customerNo, fullName: 'Erased customer', email: null, phone: null, erased: true });
      const listed = (await t.as(accountant).get(`/invoices?customerId=${customerId}&pageSize=100`).expect(200)).body.data;
      expect(listed.map((i: any) => [i.customer.id, i.customer.erased]).sort()).toEqual([[customerId, true], [duplicateId, true]].sort());
      expect((await t.as(accountant).get(`/payments/${keep.payment}`).expect(200)).body.customer).toEqual({ id: customerId, customerNo: stub.customerNo, fullName: 'Erased customer', erased: true });
      expect((await t.as(accountant).get(`/payments/${keep.oldPayment}`).expect(200)).body.customer).toMatchObject({ id: duplicateId, erased: true });
      expect((await t.as(receptionist).get(`/quotations/${keep.quotation}`).expect(200)).body.customer).toMatchObject({ id: customerId, erased: true });
      expect((await t.as(alpha.owner).get(`/requests/${requestId}`).expect(200)).body.customer).toMatchObject({ id: customerId, fullName: 'Erased customer', erased: true, email: null, phone: null });
      const requestRow = (await t.as(alpha.owner).get(`/requests?customerId=${customerId}`).expect(200)).body.data[0];
      expect(requestRow.customer).toEqual({ id: customerId, customerNo: stub.customerNo, fullName: 'Erased customer', erased: true });
      // A customer who was not erased is marked as such, in the same places.
      expect((await t.as(receptionist).get(`/customers/${other.id}`).expect(200)).body).toMatchObject({ erased: false, erasedAt: null, status: 'ACTIVE' });
      const fresh = (await t.as(alpha.owner).post('/requests', { serviceId: service.id, customerId: other.id, fields: { purpose: 'family' } }).expect(201)).body;
      expect((await t.as(alpha.owner).get(`/requests/${fresh.id}`).expect(200)).body.customer.erased).toBe(false);
    });

    it('is safe to repeat', async () => {
      await complete(dsrId).expect(200);
      await t.jobs.execute(ERASURE_FINALISE_JOB, { tenantId: alpha.id, privacyRequestId: dsrId, userIds: [customer.userId] }, { attempt: 1, maxAttempts: 1 });
      expect(await t.sys.user.findUniqueOrThrow({ where: { id: customer.userId } })).toMatchObject({ email: person.email, status: 'ACTIVE' });
      expect(await findValues(needles(), { tenantId: alpha.id, global: false })).toEqual({});
      expect(await t.sys.auditLog.count({ where: { tenantId: alpha.id, action: 'privacy.customer_anonymised', resourceId: customerId } })).toBe(1);
    });
  });

  // ============================================================================================
  describe('a customer who uses the login for nothing else', () => {
    it('the global account is anonymised and disabled; the same address can register again as a new person', async () => {
      const email = `only-here-${uniq()}@example.test`;
      const lone = await t.addCustomer(alpha, { fullName: 'Hamdan Solo Visitor', email });
      await t.as(lone).get('/auth/me').expect(200);
      // A failed sign-in leaves the address in the sign-in history.
      await t.http.post('/api/v1/auth/login').send({ email, password: 'Wrong-Password-1', app: 'customer', tenantSlug: alpha.slug }).expect(401);
      expect(await t.sys.loginActivity.count({ where: { email } })).toBeGreaterThan(0);
      const id = (await t.as(lone).post('/privacy/my/requests', { type: 'DELETION' }).expect(201)).body.id;
      await approve(id);
      const done = await complete(id).expect(200);
      expect(done.body).toMatchObject({ status: 'COMPLETED', retentionException: null });

      const user = await t.sys.user.findUniqueOrThrow({ where: { id: lone.userId } });
      expect(user).toMatchObject({ email: `erased-${lone.userId}@erased.invalid`, fullName: 'Erased user', phone: null, passwordHash: null, status: 'DISABLED', mfaEnabled: false, mfaSecretEnc: null, emailVerifiedAt: null });
      expect(user.deletedAt).not.toBeNull();
      expect(await t.sys.session.count({ where: { userId: lone.userId } })).toBe(0);
      expect(await t.sys.authToken.count({ where: { OR: [{ userId: lone.userId }, { target: email }] } })).toBe(0);
      await t.as(lone).get('/auth/me').expect(401);
      // Nothing anywhere - this centre or the platform-wide tables (users, tokens, sign-in history) - still holds the name or the address.
      expect(await findValues(['Hamdan Solo Visitor', email], { tenantId: alpha.id, global: true })).toEqual({});
      // Signing in or resetting the password with the old address leads nowhere: the account it belonged to is gone.
      expect((await login(email, alpha)).status).toBe(401);
      await t.http.post('/api/v1/auth/forgot-password').send({ email, app: 'customer', tenantSlug: alpha.slug });
      await t.settle();
      expect(LogProvider.outbox.filter((m) => m.message.to === email && /reset/i.test(m.message.subject ?? '')).length).toBe(0);
      const audit = await t.sys.auditLog.findFirstOrThrow({ where: { tenantId: alpha.id, action: 'privacy.login_anonymised', resourceId: lone.userId } });
      expect(JSON.stringify(audit)).not.toContain(email);
      expect((await t.sys.auditLog.findFirstOrThrow({ where: { tenantId: alpha.id, action: 'privacy.customer_anonymised', resourceId: lone.customerId! } })).after).toMatchObject({ loginsToAnonymise: 1, loginsKept: 0 });

      // The address is free again: a new registration is a new person with a new account.
      const again = await t.addCustomer(alpha, { fullName: 'Somebody New', email });
      expect(again.userId).not.toBe(lone.userId);
      expect(again.customerId).not.toBe(lone.customerId);
    });

    it('a staff member who is also a customer of the same centre keeps the staff login', async () => {
      const staff = await t.addStaff(alpha, 'receptionist');
      const record = (await t.as(alpha.owner).post('/customers', { fullName: 'Staff And Customer', email: staff.email }).expect(201)).body;
      const invitation = await t.as(alpha.owner).post(`/customers/${record.id}/portal-invitation`, {}).expect(201);
      await t.http.post('/api/v1/auth/invitations/accept').send({ token: invitation.body.dev.invitationToken, app: 'customer' }).expect(200);
      const id = (await t.as(alpha.owner).post('/privacy/requests', { customerId: record.id, type: 'DELETION' }).expect(201)).body.id;
      await approve(id);
      expect((await complete(id).expect(200)).body.retentionException).toMatch(/the login account itself is kept because it is also used for another centre or another role/);
      expect(await t.sys.user.findUniqueOrThrow({ where: { id: staff.userId } })).toMatchObject({ email: staff.email, status: 'ACTIVE', deletedAt: null });
      expect(await t.sys.tenantMembership.findMany({ where: { tenantId: alpha.id, userId: staff.userId }, select: { kind: true, status: true } })).toEqual([{ kind: 'STAFF', status: 'ACTIVE' }]);
      // Staff work goes on with a fresh sign-in (the sessions of this centre were ended).
      const back = await t.login(staff.email);
      await t.as(back).get('/customers').expect(200);
    });
  });

  // ============================================================================================
  describe('a document that an erasure had to keep', () => {
    it('is erased at once when staff delete it by hand: no restore window, no title, no file name', async () => {
      const storage = t.get(StorageService);
      const person = await t.addCustomer(alpha, { fullName: 'Hamdan Al Qasimi' });
      const held = await uploadDocument(t, alpha.owner, { customerId: person.customerId, title: 'Hamdan Al Qasimi - court order' }, { filename: 'hamdan-court-order.pdf' });
      const key = (await t.sys.documentVersion.findUniqueOrThrow({ where: { id: held.versionId } })).storageKey;
      await t.as(alpha.owner).put(`/documents/${held.documentId}/legal-hold`, { legalHold: true, reason: 'Court case' }).expect(200);
      // For comparison: a document of somebody who was not erased keeps its restore window.
      const ordinary = await uploadDocument(t, alpha.owner, { customerId: (await t.addCustomer(alpha)).customerId, title: 'Ordinary letter' }, { filename: 'letter.pdf' });

      const id = (await t.as(person).post('/privacy/my/requests', { type: 'DELETION' }).expect(201)).body.id;
      await approve(id);
      await complete(id).expect(200);
      await t.settle();
      // Kept because of the hold: still there, and listed for staff with the owner marked as erased.
      expect(await t.sys.document.findUniqueOrThrow({ where: { id: held.documentId } })).toMatchObject({ status: 'AVAILABLE', legalHold: true, title: 'Hamdan Al Qasimi - court order' });
      expect((await t.as(alpha.owner).get(`/documents/${held.documentId}`).expect(200)).body).toMatchObject({ customerName: 'Erased customer', customerErased: true });
      expect((await t.as(alpha.owner).delete(`/documents/${held.documentId}`).expect(409)).body.code).toBe('LEGAL_HOLD');

      await t.as(alpha.owner).put(`/documents/${held.documentId}/legal-hold`, { legalHold: false, reason: 'Case closed' }).expect(200);
      const before = Date.now();
      const removed = (await t.as(alpha.owner).delete(`/documents/${held.documentId}`).expect(200)).body;
      expect(removed).toMatchObject({ id: held.documentId, status: 'DELETED' });
      expect(new Date(removed.purgeAfter).getTime()).toBeLessThanOrEqual(Date.now());
      expect(new Date(removed.purgeAfter).getTime()).toBeGreaterThanOrEqual(before - 1000);
      // Scrubbed in the same transaction - not at the next run of the nightly job.
      expect(await t.sys.document.findUniqueOrThrow({ where: { id: held.documentId } })).toMatchObject({ status: 'DELETED', title: 'Erased document', category: null });
      expect((await t.sys.documentVersion.findMany({ where: { documentId: held.documentId } })).map((v) => v.originalFilename)).toEqual(['erased']);
      expect(await findValues(['Hamdan Al Qasimi', 'hamdan-court-order'], { tenantId: alpha.id, global: false })).toEqual({});
      expect(await t.sys.auditLog.count({ where: { tenantId: alpha.id, action: 'document.erased', resourceId: held.documentId, actorUserId: alpha.owner.userId } })).toBe(1);
      expect(await t.sys.auditLog.count({ where: { tenantId: alpha.id, action: 'document.deleted', resourceId: held.documentId } })).toBe(0);
      // No way back, even before the file is physically gone.
      expect(await storage.head(key)).not.toBeNull();
      expect((await t.as(alpha.owner).post(`/documents/${held.documentId}/restore`).expect(409)).body.code).toBe('DOCUMENT_ERASED');
      await t.jobs.runScheduled('documents.purge');
      expect(await storage.head(key)).toBeNull();
      expect((await t.sys.documentVersion.findMany({ where: { documentId: held.documentId } })).map((v) => [v.uploadStatus, v.originalFilename])).toEqual([['PURGED', 'purged']]);

      // The ordinary document: deleted with the usual window, title intact, restorable.
      const usual = (await t.as(alpha.owner).delete(`/documents/${ordinary.documentId}`).expect(200)).body;
      expect(new Date(usual.purgeAfter).getTime()).toBeGreaterThan(Date.now() + 86400_000);
      expect(await t.sys.document.findUniqueOrThrow({ where: { id: ordinary.documentId } })).toMatchObject({ status: 'DELETED', title: 'Ordinary letter' });
      await t.as(alpha.owner).post(`/documents/${ordinary.documentId}/restore`).expect(200);
    });
  });

  // ============================================================================================
  describe('a corporate employee with a portal login', () => {
    it('loses the login and the employment details; the company keeps an anonymous, inactive row', async () => {
      const account = await activeAccount(t, alpha, { companyName: 'Falcon Trading LLC' });
      const admin = await addCorporateAdmin(t, alpha, account.id);
      const body = employeeBody({ fullName: 'Ravi Kumar Employee', employeeNo: 'E-7781', designation: 'Senior Electrician' });
      const employee = (await t.as(alpha.owner).post(`/corporate-accounts/${account.id}/employees`, body).expect(201)).body;
      const invite = await t.as(admin).post(`/corporate/employees/${employee.id}/login`).expect(201);
      await t.http.post('/api/v1/auth/invitations/accept').send({ token: invite.body.dev.invitationToken, password: PASSWORD, app: 'corporate' }).expect(200);
      const employeeUser = await t.login(body.email as string, PASSWORD, 'corporate', alpha.slug);

      // The employee asks for deletion themselves (self.privacy).
      const id = (await t.as(employeeUser).post('/privacy/my/requests', { type: 'DELETION' }).expect(201)).body.id;
      await approve(id);
      await complete(id).expect(200);
      await t.settle();

      await t.as(employeeUser).get('/requests').expect(401);
      expect(await t.sys.corporateEmployee.findUniqueOrThrow({ where: { id: employee.id } })).toMatchObject({ status: 'INACTIVE', employeeNo: null, designation: null, customerId: employee.customerId });
      expect(await t.sys.tenantMembership.findUniqueOrThrow({ where: { id: employeeUser.membershipId! } })).toMatchObject({ status: 'REMOVED', customerId: null, corporateEmployeeId: null });
      expect(await t.sys.user.findUniqueOrThrow({ where: { id: employeeUser.userId } })).toMatchObject({ status: 'DISABLED', fullName: 'Erased user' });
      // The company no longer sees the person at all: not in the list, not by id, and it cannot invite or change the entry.
      await t.as(admin).get(`/corporate/employees/${employee.id}`).expect(404);
      expect(JSON.stringify((await t.as(admin).get('/corporate/employees?status=ALL&pageSize=100').expect(200)).body)).not.toContain(employee.id);
      await t.as(admin).post(`/corporate/employees/${employee.id}/login`, { email: `x-${uniq()}@example.test` }).expect(404);
      await t.as(admin).patch(`/corporate/employees/${employee.id}`, { status: 'ACTIVE' }).expect(404);
      // Staff see an inactive, nameless row that is marked as erased, and are told why nothing can be done with it.
      const view = (await t.as(alpha.owner).get(`/corporate-accounts/${account.id}/employees/${employee.id}`).expect(200)).body;
      expect(view).toMatchObject({ status: 'INACTIVE', erased: true, customerStatus: 'ANONYMISED', fullName: 'Erased customer', email: null, employeeNo: null, designation: null, login: { status: 'NONE' } });
      const rows = (await t.as(alpha.owner).get(`/corporate-accounts/${account.id}/employees?status=ALL`).expect(200)).body.data;
      expect(rows.find((e: any) => e.id === employee.id)).toMatchObject({ erased: true });
      expect((await t.as(alpha.owner).post(`/corporate-accounts/${account.id}/employees/${employee.id}/login`, { email: `x-${uniq()}@example.test` }).expect(409)).body.code).toBe('CUSTOMER_ERASED');
      expect((await t.as(alpha.owner).patch(`/corporate-accounts/${account.id}/employees/${employee.id}`, { status: 'ACTIVE' }).expect(409)).body.code).toBe('CUSTOMER_ERASED');
      expect((await t.as(alpha.owner).get(`/customers/${employee.customerId}`).expect(200)).body).toMatchObject({ status: 'ANONYMISED', erased: true });
      expect(await findValues(['Ravi Kumar Employee', body.email as string, 'E-7781', 'Senior Electrician', body.passportNo as string], { tenantId: alpha.id, global: true })).toEqual({});
      // The administrator's own login and the company are untouched.
      await t.as(admin).get('/corporate/account').expect(200);
    });
  });
});
