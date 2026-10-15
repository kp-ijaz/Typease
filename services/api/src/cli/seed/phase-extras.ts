import { buildSample, hasExpiry, uploadDocument } from './documents';
import { DAY, daysAgo, isoDay, step } from './runtime';
import { eicarSample } from './sample-documents';
import { SeedContext, TenantState } from './state';

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Built-in roles tailored by the owner, notification throughput for the seed, customers' own channel choices. */
export async function tuneCentre(ctx: SeedContext, t: TenantState): Promise<void> {
  const owner = ctx.rt.as(t.owner);
  await step(`${t.fx.name}: role permissions, notification settings`, async () => {
    if (t.fx.roleAdjustments?.length) {
      const roles: any[] = await owner.get('/roles');
      for (const adj of t.fx.roleAdjustments) {
        const role = roles.find((r) => r.key === adj.roleKey);
        if (!role) throw new Error(`${t.slug}: role "${adj.roleKey}" does not exist.`);
        await owner.patch(`/roles/${role.id}`, { permissions: [...new Set([...role.permissions, ...adj.add])] });
      }
    }
    // The seed produces weeks of messages within minutes. Without this the per-recipient hourly limit
    // would suppress most of them; the centre's normal limit is restored at the end (restoreNotificationLimit).
    await owner.put('/notifications/settings', { rateLimitPerHour: 200 });
  });
}

/** Customers who switched a notification channel off in their portal settings. */
export async function recordOptOuts(ctx: SeedContext, t: TenantState): Promise<void> {
  for (const o of t.fx.optOuts ?? []) {
    const portal = t.customer(o.customer).portal;
    if (!portal) throw new Error(`${t.slug}: customer ${o.customer} has no portal account to change notification preferences with.`);
    await ctx.rt.as(portal).put('/me/notification-preferences', { preferences: [{ channel: o.channel, eventGroup: o.group, enabled: false }] });
  }
}

export async function restoreNotificationLimit(ctx: SeedContext, t: TenantState): Promise<void> {
  await ctx.rt.as(t.owner).put('/notifications/settings', { rateLimitPerHour: 20 });
}

/** Documents filed directly in the vault (not under a request): the states a vault screen has to show. */
export async function fileVaultDocuments(ctx: SeedContext, t: TenantState): Promise<void> {
  const items = t.fx.vault ?? [];
  if (!items.length) return;
  const { rt } = ctx;
  await step(`${t.fx.name}: ${items.length} vault documents (versions, expiry, share link, legal hold, quarantine)`, async () => {
    for (const v of items) {
      const uploader = t.actor(v.by);
      const subject = v.customer ? t.customer(v.customer) : t.customer(t.company(v.company!).profileCustomerKey ?? t.fx.customers[0].key);
      const owner = v.company ? { corporateAccountId: t.company(v.company).id } : { customerId: subject.id };
      const pin = ctx.timeline.begin(ctx.timeline.office(daysAgo(v.daysAgo)));
      const built = await buildSample(ctx, t, v.documentTypeKey, subject, { label: v.label, variant: `vault:${v.outcome}` });
      const title = v.label ?? built.title;

      if (v.outcome === 'QUARANTINED') {
        // The standard antivirus TEST file. The vault's scan detects it, deletes the file and quarantines the document.
        const doc = await uploadDocument(ctx, uploader, { ...owner, documentTypeKey: v.documentTypeKey, title }, eicarSample());
        pin(doc.documentId);
        await rt.settle();
        const row = await rt.as(uploader).get(`/documents/${doc.documentId}`);
        if (row.status !== 'QUARANTINED') throw new Error(`The antivirus test file was expected to be quarantined, but the document is ${row.status}.`);
        t.count('documents');
        continue;
      }

      const expired = v.outcome === 'EXPIRED';
      const expiryDate = expired ? isoDay(daysAgo(20)) : built.expiryDate;
      const doc = await uploadDocument(ctx, uploader, { ...owner, documentTypeKey: v.documentTypeKey, title, ...(expiryDate ? { expiryDate } : {}) }, built.file);
      pin(doc.documentId);
      t.count('documents');
      await rt.settle();
      const reviewer = rt.as(t.reviewer());

      switch (v.outcome) {
        case 'VERIFIED':
          await reviewer.post(`/documents/${doc.documentId}/verify`, { decision: 'APPROVED', ...(hasExpiry(v.documentTypeKey) && expiryDate ? { expiryDate } : {}) });
          break;
        case 'NEW_VERSION': {
          await reviewer.post(`/documents/${doc.documentId}/verify`, { decision: 'CORRECTION_REQUESTED', reason: 'The scan is too dark to read the dates. Please provide a clearer copy. (demo)' });
          ctx.timeline.mark(doc.documentId, ctx.timeline.office(daysAgo(Math.max(0.5, v.daysAgo - 3))));
          const second = await buildSample(ctx, t, v.documentTypeKey, subject, { label: v.label, variant: 'vault:v2' });
          await uploadDocument(ctx, uploader, { replacesDocumentId: doc.documentId, documentTypeKey: v.documentTypeKey }, second.file);
          await rt.settle();
          await reviewer.post(`/documents/${doc.documentId}/verify`, { decision: 'APPROVED', ...(second.expiryDate ? { expiryDate: second.expiryDate } : {}) });
          break;
        }
        case 'SHARED':
          await reviewer.post(`/documents/${doc.documentId}/verify`, { decision: 'APPROVED' });
          await rt.as(t.decider()).post(`/documents/${doc.documentId}/shares`, { expiresInHours: 72, maxDownloads: 3, recipient: v.note ?? 'Demo share link' });
          break;
        case 'LEGAL_HOLD':
          await reviewer.post(`/documents/${doc.documentId}/verify`, { decision: 'APPROVED', ...(expiryDate ? { expiryDate } : {}) });
          await rt.as(t.owner).put(`/documents/${doc.documentId}/legal-hold`, { legalHold: true, reason: v.note ?? 'Legal hold (demo).' });
          break;
        case 'DELETED':
          await rt.as(t.owner).delete(`/documents/${doc.documentId}`);
          break;
        default:
          break;
      }
    }
  });
}

/** Invoices raised directly (not from a quotation), a company paying its statement, running costs, reconciliation. */
export async function financeExtras(ctx: SeedContext, t: TenantState): Promise<void> {
  const { rt } = ctx;
  const accountant = t.accountant();
  const acc = rt.as(accountant);

  const invoices = t.fx.directInvoices ?? [];
  if (invoices.length) {
    await step(`${t.fx.name}: ${invoices.length} direct invoices (draft, issued, paid, part-paid, void, credited)`, async () => {
      for (const d of invoices) {
        const customer = t.customer(d.customer);
        const branch = t.branch(d.branch);
        const at = ctx.timeline.office(daysAgo(d.daysAgo));
        const pin = ctx.timeline.begin(at);
        const draft = await acc.post('/invoices', {
          customerId: customer.id,
          branchId: branch.id,
          ...(d.company ? { corporateAccountId: t.company(d.company).id } : {}),
          notes: d.notes ?? null,
          items: d.lines.map((l) => ({ description: l.description, component: l.component, quantity: l.quantity ?? 1, unitAmount: l.unitAmount })),
        });
        pin(draft.id);
        t.count('invoices');
        if (d.outcome === 'DRAFT') continue;
        const issued = await acc.post(`/invoices/${draft.id}/issue`);
        const total = Number(issued.total);
        if (d.outcome === 'VOID') {
          await acc.post(`/invoices/${draft.id}/void`, { reason: d.reason ?? 'Raised by mistake. (demo)' });
        } else if (d.outcome === 'CREDITED' || d.outcome === 'PARTIALLY_CREDITED') {
          const amount = d.outcome === 'CREDITED' ? total : round2(total * 0.2);
          await acc.post('/credit-notes', { invoiceId: draft.id, amount: amount.toFixed(2), reason: d.reason ?? 'Credit (demo).' });
          t.count('creditNotes');
        } else if (d.payment) {
          const amount = round2(total * (d.outcome === 'PARTIALLY_PAID' ? (d.payment.share ?? 0.5) : 1));
          const payment = await rt.as(t.receptionist(branch.code)).post(
            '/payments',
            { method: d.payment.method, amount: amount.toFixed(2), branchId: branch.id, customerId: customer.id, receivedAt: ctx.timeline.clamp(new Date(at.getTime() + 3_600_000)).toISOString(), ...(d.payment.method === 'CASH' ? {} : { reference: `Slip ${ctx.nextReference('POS')}` }), allocations: [{ invoiceId: draft.id, amount: amount.toFixed(2) }] },
            { headers: { 'Idempotency-Key': t.idempotencyKey('payment') } },
          );
          ctx.timeline.alias(payment.id, draft.id);
          t.count('payments');
        }
      }
    });
  }

  const statements = t.fx.statementPayments ?? [];
  if (statements.length) {
    await step(`${t.fx.name}: ${statements.length} company statement payment(s) covering several invoices`, async () => {
      for (const sp of statements) {
        const allocations: Array<{ invoiceId: string; amount: string }> = [];
        for (const ref of sp.requests) {
          const request = t.request(ref);
          if (!request.invoiceId) throw new Error(`${t.slug}: request ${ref} has no invoice to pay.`);
          const invoice = await acc.get(`/invoices/${request.invoiceId}`);
          if (Number(invoice.balanceDue) > 0) allocations.push({ invoiceId: invoice.id, amount: invoice.balanceDue });
        }
        if (!allocations.length) throw new Error(`${t.slug}: the statement payment of ${sp.company} found nothing left to pay.`);
        const amount = allocations.reduce((a, b) => a + Number(b.amount), 0);
        const pin = ctx.timeline.begin(ctx.timeline.office(daysAgo(sp.daysAgo)));
        const payment = await acc.post(
          '/payments',
          { method: sp.method, amount: amount.toFixed(2), branchId: t.branch().id, receivedAt: ctx.timeline.office(daysAgo(sp.daysAgo)).toISOString(), reference: `Statement transfer ${ctx.nextReference('TRF')}`, notes: `Payment of the monthly statement by ${t.company(sp.company).fx.companyName} (demo).`, allocations },
          { headers: { 'Idempotency-Key': t.idempotencyKey('payment') } },
        );
        pin(payment.id);
        t.count('payments');
      }
    });
  }

  const expenses = t.fx.expenses ?? [];
  if (expenses.length) {
    await step(`${t.fx.name}: ${expenses.length} expenses`, async () => {
      for (const e of expenses) {
        const pin = ctx.timeline.begin(ctx.timeline.office(daysAgo(e.paidDaysAgo)));
        const row = await acc.post('/expenses', { branchId: t.branch(e.branch).id, category: e.category, description: e.description, amount: e.amount, paidOn: isoDay(daysAgo(e.paidDaysAgo)), payee: e.payee ?? null, reference: ctx.nextReference('EXP'), method: e.method ?? null });
        pin(row.id);
        t.count('expenses');
      }
    });
  }
}

/** Reconciliation runs last: it looks at every payment of the period, whatever recorded it. */
export async function reconcile(ctx: SeedContext, t: TenantState): Promise<void> {
  const list = t.fx.reconciliations ?? [];
  if (!list.length) return;
  const acc = ctx.rt.as(t.accountant());
  await step(`${t.fx.name}: ${list.length} reconciliation record(s)`, async () => {
    const out: string[] = [];
    for (const r of list) {
      const body = {
        method: r.method,
        ...(r.method === 'ONLINE_GATEWAY' ? { gateway: 'sandbox' } : {}),
        ...(r.branch ? { branchId: t.branch(r.branch).id } : {}),
        periodStart: daysAgo(r.fromDaysAgo).toISOString(),
        periodEnd: new Date(Date.now() - r.toDaysAgo * DAY + (r.toDaysAgo === 0 ? DAY : 0)).toISOString(),
        statementReference: r.statementReference,
        settledAmount: '0.00',
        feeAmount: r.feeAmount ?? '0',
        notes: r.notes ?? null,
        attachAll: r.outcome !== 'OPEN',
      };
      const record = await acc.post('/reconciliations', body);
      const expected = Number(r.outcome === 'OPEN' ? record.candidates.total : record.attached.total);
      const settled = round2(expected - Number(r.feeAmount ?? 0) - (r.outcome === 'DISCREPANCY' ? Number(r.shortBy ?? '10') : 0));
      const updated = await acc.patch(`/reconciliations/${record.id}`, { settledAmount: Math.max(0, settled).toFixed(2) });
      if (r.outcome === 'MATCHED_CLOSED') {
        if (updated.status !== 'MATCHED') throw new Error(`Reconciliation "${r.statementReference}" should match but is ${updated.status} (difference ${updated.difference}).`);
        await acc.post(`/reconciliations/${record.id}/close`, { notes: r.notes ?? null });
      }
      out.push(`${r.method} ${r.outcome === 'MATCHED_CLOSED' ? 'closed' : updated.status.toLowerCase()}`);
      t.count('reconciliations');
    }
    return out;
  }, (o) => o.join(', '));
}
