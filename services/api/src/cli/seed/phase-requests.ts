import { Clock } from '../../modules/workflows/clock';
import type { ManualMethod, RequestScenarioFx } from './fixture-types';
import { buildSample, hasExpiry, uploadDocument } from './documents';
import { Actor, DAY, HOUR, isoDay, need, step } from './runtime';
import { CompanyState, CustomerState, RequestState, SeedContext, ServiceState, TenantState } from './state';

interface Stage {
  name: string;
  /** Relative time this stage takes before the next one starts. */
  weight: number;
  run: () => Promise<void>;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const CLOSED = ['COMPLETED', 'CANCELLED'];

/**
 * One request, driven from draft to wherever its scenario says it rests - with
 * the same calls, by the same kind of user, in the same order as in a centre:
 * the receptionist (or the customer online, or the company administrator)
 * creates and submits, the reviewer checks documents, the receptionist quotes,
 * the customer approves and pays, the manager assigns, the operator prepares,
 * the reviewer approves and completes. The state machine and the workflow
 * engine do the rest; after every stage the seed checks that the request is in
 * the status the scenario expects, and stops if it is not.
 */
class ScenarioRun {
  private readonly rt: SeedContext['rt'];
  private readonly svc: ServiceState;
  private readonly cust: CustomerState;
  private readonly company: CompanyState | null;
  private readonly branch: { id: string; code: string; name: string };
  private readonly desk: Actor;
  private readonly decider: Actor;
  private readonly reviewer: Actor;
  private readonly rng: ReturnType<TenantState['rng']>;
  private readonly via: 'STAFF' | 'PORTAL' | 'CORPORATE';
  private readonly creator: Actor;
  private readonly onAccount: boolean;
  private readonly submits: boolean;
  private vt = new Date();
  private stageName = '';
  private id = '';
  private requestNo = '';
  private trackingCode: string | undefined;
  private quotationId: string | undefined;
  private governmentFee = 0;
  private invoice: { id: string; total: number; paid: number } | undefined;
  private readonly payments: Array<{ id: string; method: string; amount: number }> = [];
  private operatorKey: string | undefined;

  constructor(
    private readonly ctx: SeedContext,
    private readonly t: TenantState,
    private readonly fx: RequestScenarioFx,
  ) {
    this.rt = ctx.rt;
    this.svc = t.service(fx.service);
    this.cust = t.customer(fx.customer);
    this.company = fx.company ? t.company(fx.company) : null;
    this.branch = t.branch(fx.branch);
    this.desk = t.receptionist(this.branch.code);
    this.decider = t.decider(this.branch.code);
    this.reviewer = t.reviewer();
    this.rng = t.rng(`request:${fx.ref}`);
    this.via = fx.via ?? 'STAFF';
    if (this.via === 'PORTAL') this.creator = need(this.cust.portal, `a portal account for customer "${fx.customer}" (scenario ${fx.ref} is created online)`);
    else if (this.via === 'CORPORATE') this.creator = need(this.company?.admin, `a company administrator login for scenario ${fx.ref}`);
    else this.creator = this.desk;
    this.onAccount = !!this.company?.fx.credit && this.company.fx.state !== 'PENDING';
    this.submits = ['PARTNER_COORDINATION', 'DIRECT_AUTHORISED'].includes(this.svc.complianceCapability);
  }

  // ------------------------------------------------------------------ plan
  private plan(): Stage[] {
    const f = this.fx;
    const stages: Stage[] = [];
    const add = (name: string, weight: number, run: () => Promise<void>) => stages.push({ name, weight, run });
    const docs = f.documents ?? 'ALL';
    const approval = this.svc.requiresApproval;

    add('created', 1, () => this.create());
    if (docs !== 'NONE') add('documents uploaded', 1, () => this.uploadInputs(docs));
    if (f.stop === 'DRAFT') return stages;
    add('submitted', 1, () => this.submit());
    if (f.duplicateOf) {
      add('marked as a duplicate', 2, () => this.markDuplicate());
      return stages;
    }
    if (f.stop === 'SUBMITTED' || f.stop === 'UNDER_REVIEW') return stages;

    if (f.rejectDocument) {
      add('documents checked, one rejected', 3, () => this.verifyInputs(f.rejectDocument!.reason));
      if (!f.rejectDocument.fixed) return stages;
      add('customer replaces the document', 5, () => this.replaceRejected());
      add('replacement verified', 2, () => this.verifyInputs());
    } else {
      add('documents verified', 3, () => this.verifyInputs());
    }
    if (f.stop === 'DOCUMENTS_VERIFIED') {
      if (f.quotation?.discount?.decision === 'PENDING') add('quotation drafted, discount waits for approval', 1, () => this.quote(true));
      return stages;
    }

    if (f.quotation?.rejectedFirst) {
      add('quotation sent', 1, () => this.quote(false));
      add('customer rejects the quotation', 3, () => this.rejectQuotation(f.quotation!.rejectedFirst!));
      add('revised quotation sent', 2, () => this.quote(true));
    } else {
      add('quotation sent', 1, () => this.quote(true));
    }
    if (f.stop === 'QUOTED') return stages;
    if (f.cancel && !f.payment) {
      add('cancelled', 3, () => this.cancel());
      return stages;
    }
    add('quotation approved', 4, () => this.approveQuotation());
    if (f.stop === 'AWAITING_PAYMENT') {
      if (f.payment) add('payment attempt', 2, () => this.paymentAttempt());
      return stages;
    }
    add('payment before processing', 2, () => this.payBeforeProcessing());
    if (f.stop === 'READY_FOR_PROCESSING') {
      if (f.operator) add('assigned', 2, () => this.assign());
      return stages;
    }
    if (f.cancel && !f.operator) {
      add('cancelled', 4, () => this.cancel());
      return stages;
    }
    add('assigned and started', 3, () => this.assignAndStart());
    if (f.question) {
      add('question to the customer', 3, () => this.askQuestion());
      if (!f.question.answered) return stages;
      add('customer answers', 4, () => this.answerQuestion());
    }
    if (f.cancel) {
      add('cancelled', 4, () => this.cancel());
      return stages;
    }
    if (f.stop === 'IN_PREPARATION' && !f.reviewRejectedFirst && !f.reopened) return stages;

    add('prepared', 6, () => this.prepare());
    if (approval) {
      if (f.stop === 'PENDING_APPROVAL') return stages;
      if (f.reviewRejectedFirst) {
        add('review: sent back', 3, () => this.review('REJECTED', f.reviewRejectedFirst));
        if (f.stop === 'IN_PREPARATION') return stages;
        add('corrected', 3, () => this.rework());
      }
      add('review: approved', 3, () => this.review('APPROVED'));
    }
    if (this.submits) {
      if (f.stop === 'READY_TO_SUBMIT') return stages;
      add('submitted through the partner', 2, () => this.recordSubmission());
      if (f.stop === 'EXTERNAL_PROCESSING') return stages;
      const outcome = f.external?.outcome ?? 'COMPLETED';
      add(`partner reports: ${outcome.toLowerCase()}`, 10, () => this.externalResult(outcome, f.external?.note));
      if (outcome === 'REJECTED') return stages;
      if (outcome === 'RETURNED') {
        if (!f.external?.resubmitted) return stages;
        if (approval) throw new Error(`${f.ref}: a returned case of a service that requires review needs a second review; the scenario language does not cover that.`);
        add('corrected and submitted again', 4, () => this.resubmitAfterReturn());
        add('partner reports: completed', 8, () => this.externalResult('COMPLETED'));
      }
    }
    if (f.stop === 'FINAL_REVIEW') return stages;
    add('completed', 3, () => this.complete());
    if (f.rating) add('customer feedback', 6, () => this.rate());
    if (f.gatewayRefund) add('part refund through the gateway', 5, () => this.gatewayRefund());
    if (f.reopened) add('reopened', 10, () => this.reopen());
    return stages;
  }

  async run(): Promise<RequestState> {
    const stages = this.plan();
    const times = this.ctx.timeline.plan(this.fx.start, this.fx.end, stages.map((s) => s.weight));
    const clock = this.rt.get(Clock);
    try {
      for (const [k, stage] of stages.entries()) {
        this.vt = times[k];
        this.stageName = stage.name;
        // The requests module stamps its rows with its own clock: move it to the moment the stage happens.
        clock.reset();
        clock.travelHours((this.vt.getTime() - Date.now()) / HOUR);
        if (this.id) this.ctx.timeline.mark(this.id, this.vt);
        await stage.run();
        await this.rt.settle();
      }
    } catch (e: any) {
      e.message = `${this.fx.ref}${this.requestNo ? ` (${this.requestNo})` : ''}, stage "${this.stageName}": ${e.message}`;
      throw e;
    } finally {
      clock.reset();
    }
    const final = await this.view();
    const expected = this.fx.stop === 'DOCUMENTS_VERIFIED' ? 'UNDER_REVIEW' : this.fx.reopened ? 'IN_PREPARATION' : this.fx.stop;
    if (final.status !== expected) throw new Error(`${this.fx.ref} (${this.requestNo}) should rest in ${expected} but is ${final.status}.`);
    const state: RequestState = {
      ref: this.fx.ref,
      fx: this.fx,
      id: this.id,
      requestNo: this.requestNo,
      customerKey: this.cust.key,
      branchCode: this.branch.code,
      trackingCode: this.trackingCode,
      quotationId: this.quotationId,
      invoiceId: this.invoice?.id,
      invoiceTotal: this.invoice ? this.invoice.total.toFixed(2) : undefined,
      paymentIds: this.payments.map((p) => p.id),
      operatorKey: this.operatorKey,
      status: final.status,
    };
    this.t.requests.set(this.fx.ref, state);
    return state;
  }

  // ------------------------------------------------------------------ helpers
  private view(actor: Actor = this.desk): Promise<any> {
    return this.rt.as(actor).get(`/requests/${this.id}`);
  }
  /** Settles, reads the case and insists on the status the scenario expects at this point. */
  private async expect(...statuses: string[]): Promise<any> {
    await this.rt.settle();
    const v = await this.view();
    if (!statuses.includes(v.status)) {
      const blocked = v.nextStep?.step?.blocked ?? v.workflow?.steps?.find((s: any) => s.current)?.blocked;
      throw new Error(`expected ${statuses.join(' or ')}, but the request is ${v.status}${blocked ? ` (workflow waits: ${blocked.code} - ${blocked.message})` : ''}.`);
    }
    return v;
  }
  private get open(): boolean {
    return !CLOSED.includes(this.fx.stop) || !!this.fx.reopened;
  }
  private operator(): Actor {
    return this.t.actor(need(this.operatorKey, 'an operator'));
  }
  private pickOperator(): string {
    if (this.fx.operator && this.fx.operator !== 'AUTO') return this.fx.operator;
    const operators = this.t.fx.staff.filter((s) => s.roleKey === 'operator' && (s.branches === 'ALL' || s.branches.includes(this.branch.code)));
    const skilled = operators.find((s) => s.skills?.includes(this.svc.code));
    return (skilled ?? operators[0])?.key ?? 'owner';
  }

  // ------------------------------------------------------------------ stages
  private async create(): Promise<void> {
    const body: Record<string, unknown> = {
      serviceId: this.svc.id,
      branchId: this.branch.id,
      fields: this.ctx.fixtures.formValues(this.svc.code, this.cust.person, (n) => this.rng.int(0, n - 1)),
      ...(this.fx.instructions ? { instructions: this.fx.instructions } : {}),
    };
    if (this.via === 'STAFF') {
      body.customerId = this.cust.id;
      if (this.company) body.corporateAccountId = this.company.id;
      if (this.fx.priority) body.priority = this.fx.priority;
    } else if (this.via === 'CORPORATE' && this.cust.employeeId) {
      body.corporateEmployeeId = this.cust.employeeId;
    }
    const pin = this.ctx.timeline.begin(this.vt);
    const created = await this.rt.as(this.creator).post('/requests', body);
    this.id = created.id;
    this.requestNo = created.requestNo;
    pin(this.id);
    // "Do not ask for the same document twice": documents already verified on the customer's file are linked.
    // (Not the one this scenario is about to have rejected: there the customer brings a new copy.)
    const fresh = this.fx.rejectDocument ? (/photo/i.test(this.fx.rejectDocument.reason) ? 'photo' : 'passport') : null;
    for (const candidate of created.reuseCandidates ?? []) {
      if (candidate.documentTypeKey === fresh) continue;
      if (!candidate.linked) await this.rt.as(this.creator).put(`/requests/${this.id}/checklist/${candidate.checklistItemId}/document`, { documentId: candidate.documentId });
    }
    this.t.count('requests');
  }

  private async uploadInputs(mode: 'ALL' | 'PARTIAL'): Promise<void> {
    const v = await this.view();
    const missing = (v.checklist as any[]).filter((l) => l.kind === 'INPUT' && l.status === 'MISSING');
    const mandatory = missing.filter((l) => l.isMandatory);
    const optional = missing.filter((l) => !l.isMandatory);
    const chosen = mode === 'PARTIAL' ? mandatory.slice(0, 1) : [...mandatory, ...optional.filter(() => this.rng.chance(0.5))];
    for (const line of chosen) await this.uploadFor(line, this.creator);
  }

  private async uploadFor(line: any, uploader: Actor, replaces?: string): Promise<string> {
    const sample = await buildSample(this.ctx, this.t, line.documentTypeKey, this.cust, { label: line.label, variant: replaces ? `${this.fx.ref}:v2` : this.fx.ref });
    const out = await uploadDocument(
      this.ctx,
      uploader,
      {
        // Customers upload for themselves; staff and company administrators say whose document it is.
        ...(uploader.app === 'customer' ? {} : { customerId: this.cust.id }),
        requestId: this.id,
        checklistItemId: line.id,
        documentTypeKey: line.documentTypeKey,
        title: sample.title,
        ...(sample.expiryDate ? { expiryDate: sample.expiryDate } : {}),
        ...(replaces ? { replacesDocumentId: replaces } : {}),
      },
      sample.file,
    );
    this.t.count('documents');
    return out.documentId;
  }

  private async submit(): Promise<void> {
    const res = await this.rt.as(this.creator).post(`/requests/${this.id}/submit`);
    this.trackingCode = res.trackingCode;
    if (this.open) {
      // Staff give open cases a realistic target date (the default would be the estimated hours after submission).
      const days = this.fx.overdue ? -this.rng.int(1, 3) : this.rng.int(2, 9);
      const patch: Record<string, unknown> = { targetDate: new Date(Date.now() + days * DAY + this.rng.int(0, 8) * HOUR).toISOString() };
      if (this.via !== 'STAFF' && this.fx.priority) patch.priority = this.fx.priority;
      await this.rt.as(this.desk).patch(`/requests/${this.id}`, patch);
    }
    if (this.fx.duplicateOf) return;
    await this.expect(this.fx.stop === 'SUBMITTED' ? 'SUBMITTED' : 'UNDER_REVIEW');
  }

  private async markDuplicate(): Promise<void> {
    const original = this.t.request(this.fx.duplicateOf!);
    await this.rt.as(this.decider).post(`/requests/${this.id}/mark-duplicate`, { duplicateOfId: original.id });
    await this.expect('CANCELLED');
  }

  /** The reviewer checks every uploaded input document; optionally one is rejected (last, like a person would). */
  private async verifyInputs(rejectReason?: string): Promise<void> {
    const v = await this.view(this.reviewer);
    const lines = (v.checklist as any[]).filter((l) => l.kind === 'INPUT' && l.document && l.status === 'UPLOADED');
    let rejected: any = null;
    if (rejectReason) {
      const wanted = /photo/i.test(rejectReason) ? 'photo' : 'passport';
      rejected = lines.find((l) => l.documentTypeKey === wanted) ?? lines[0];
      if (!rejected) throw new Error('the scenario rejects a document, but nothing was uploaded.');
    }
    const api = this.rt.as(this.reviewer);
    for (const line of lines) {
      if (line === rejected) continue;
      const expiry = hasExpiry(line.documentTypeKey) && line.document.expiryDate ? String(line.document.expiryDate).slice(0, 10) : undefined;
      // An expiry date in the past cannot be confirmed as valid: such a document is approved without confirming the date.
      const confirm = expiry && expiry >= isoDay(new Date()) ? { expiryDate: expiry } : {};
      await api.post(`/documents/${line.document.id}/verify`, { decision: 'APPROVED', ...confirm });
      this.cust.vault.set(line.documentTypeKey, line.document.id);
    }
    if (rejected) {
      await api.post(`/documents/${rejected.document.id}/verify`, { decision: 'REJECTED', reason: rejectReason });
      await this.expect('AWAITING_CUSTOMER');
    } else {
      await this.expect('UNDER_REVIEW');
    }
  }

  private async replaceRejected(): Promise<void> {
    const v = await this.view();
    const line = (v.checklist as any[]).find((l) => l.kind === 'INPUT' && l.status === 'REJECTED');
    if (!line?.document) throw new Error('no rejected checklist line was found.');
    const uploader = this.cust.portal && this.via === 'PORTAL' ? this.cust.portal : this.desk;
    // A new version of the same document: the rejected file stays in the history.
    await this.uploadFor(line, uploader, line.document.id);
    await this.rt.settle();
    await this.rt.as(uploader).post(`/requests/${this.id}/resubmit`, { note: 'New copy provided. (demo)' });
    await this.expect('UNDER_REVIEW');
  }

  private async quote(withDiscount: boolean): Promise<void> {
    const discount = withDiscount ? this.fx.quotation?.discount : undefined;
    const desk = this.rt.as(this.desk);
    const q = await desk.post(`/quotations/from-request/${this.id}`, discount ? { serviceFeeDiscount: discount.amount, discountReason: discount.reason } : {});
    this.quotationId = q.id;
    this.governmentFee = Number(q.subtotalGovernmentFee ?? 0);
    this.ctx.timeline.alias(q.id, this.id);
    this.t.count('quotations');
    if (discount) {
      // Segregation of duties: the receptionist asks, the manager / owner decides.
      if (discount.decision === 'PENDING') return;
      if (discount.decision === 'APPROVE') await this.rt.as(this.decider).post(`/quotations/${q.id}/discount/approve`, { note: 'Approved. (demo)' });
      else await this.rt.as(this.decider).post(`/quotations/${q.id}/discount/reject`, { reason: 'Not within the discount policy. (demo)', clearDiscounts: true });
    }
    await desk.post(`/quotations/${q.id}/send`);
    await this.expect('QUOTED');
  }

  private async rejectQuotation(reason: string): Promise<void> {
    const who = this.cust.portal ?? this.desk;
    await this.rt.as(who).post(`/quotations/${this.quotationId}/reject`, { reason });
    await this.expect('UNDER_REVIEW');
  }

  private async approveQuotation(): Promise<void> {
    const by = this.fx.quotation?.approvedBy ?? 'STAFF';
    let res: any;
    if (by === 'CUSTOMER') res = await this.rt.as(need(this.cust.portal, `a portal account for "${this.cust.key}" to approve the quotation`)).post(`/quotations/${this.quotationId}/approve`, {});
    else if (by === 'CORPORATE') res = await this.rt.as(need(this.company?.admin, 'a company administrator to approve the quotation')).post(`/quotations/${this.quotationId}/approve`, {});
    else res = await this.rt.as(this.desk).post(`/quotations/${this.quotationId}/approve`, { note: 'Approved by the customer at the counter. (demo)' });
    this.invoice = { id: res.invoice.id, total: Number(res.invoice.total), paid: 0 };
    this.ctx.timeline.alias(res.invoice.id, this.id);
    this.t.count('invoices');
    await this.expect(this.dueBeforeProcessing() > 0 ? 'AWAITING_PAYMENT' : 'READY_FOR_PROCESSING');
  }

  /** What has to be paid before work starts, according to the service's payment policy. */
  private dueBeforeProcessing(): number {
    const inv = need(this.invoice, 'an invoice');
    if (this.onAccount || inv.total === 0 || this.svc.paymentPolicy === 'AFTER_COMPLETION') return 0;
    const required = this.svc.paymentPolicy === 'DEPOSIT' ? round2((inv.total * (this.svc.depositPercent ?? 100)) / 100) : inv.total;
    return Math.max(0, round2(required - inv.paid));
  }

  private async recordManual(method: ManualMethod, amount: number): Promise<void> {
    const inv = need(this.invoice, 'an invoice');
    const reference = method === 'CASH' ? undefined : method === 'CARD_POS' ? `POS slip ${this.ctx.nextReference('POS')}` : method === 'CHEQUE' ? `Cheque ${this.ctx.nextReference('CHQ')}` : `Transfer ${this.ctx.nextReference('TRF')}`;
    const payment = await this.rt.as(this.desk).post(
      '/payments',
      { method, amount: amount.toFixed(2), branchId: this.branch.id, customerId: this.cust.id, receivedAt: this.vt.toISOString(), ...(reference ? { reference } : {}), allocations: [{ invoiceId: inv.id, amount: amount.toFixed(2) }] },
      { headers: { 'Idempotency-Key': this.t.idempotencyKey('payment') } },
    );
    inv.paid = round2(inv.paid + amount);
    this.payments.push({ id: payment.id, method, amount });
    this.ctx.timeline.alias(payment.id, this.id);
    this.t.count('payments');
  }

  /** Online payment on the portal: checkout at the test gateway, which answers with its signed webhook. */
  private async payOnline(amount: number, outcome: 'PAID' | 'DECLINED' | 'ABANDONED'): Promise<void> {
    const inv = need(this.invoice, 'an invoice');
    const payer = this.cust.portal ?? this.company?.admin;
    if (!payer) throw new Error(`customer "${this.cust.key}" has no portal account to pay online with.`);
    const checkout = await this.rt.as(payer).post(`/invoices/${inv.id}/pay`, { amount: amount.toFixed(2) });
    this.ctx.timeline.alias(checkout.paymentId, this.id);
    this.t.count('payments');
    if (outcome === 'ABANDONED') return;
    const anon = this.rt.anonymous();
    const result = outcome === 'PAID' ? await anon.post(`${checkout.checkoutUrl}/complete`) : await anon.post(`${checkout.checkoutUrl}/fail`, { reason: 'Declined by the test gateway (demo).' });
    if (!result.webhook?.delivered) throw new Error(`the test gateway could not deliver its webhook: ${JSON.stringify(result.webhook)}`);
    if (outcome === 'PAID') {
      inv.paid = round2(inv.paid + amount);
      this.payments.push({ id: checkout.paymentId, method: 'ONLINE', amount });
    }
  }

  private async pay(amount: number): Promise<void> {
    const p = need(this.fx.payment, `a payment method in scenario ${this.fx.ref}`);
    if (p.method === 'ONLINE') {
      if (p.declinedFirst) await this.payOnline(amount, 'DECLINED');
      await this.payOnline(amount, 'PAID');
    } else {
      await this.recordManual(p.method, amount);
    }
  }

  private async payBeforeProcessing(): Promise<void> {
    const due = this.dueBeforeProcessing();
    if (due > 0) await this.pay(due);
    await this.expect('READY_FOR_PROCESSING');
  }

  /** A request that rests in "awaiting payment": part payment, a declined card, or an abandoned checkout. */
  private async paymentAttempt(): Promise<void> {
    const p = this.fx.payment!;
    const due = this.dueBeforeProcessing();
    if (p.method === 'ONLINE') await this.payOnline(due, p.declinedFirst ? 'DECLINED' : 'ABANDONED');
    else if (p.partial && p.partial > 0) await this.recordManual(p.method, round2(due * p.partial));
    await this.expect('AWAITING_PAYMENT');
  }

  private async assign(): Promise<void> {
    const v = await this.view(this.decider);
    const api = this.rt.as(this.decider);
    if (this.fx.operator === 'AUTO' && !v.assignee) {
      const auto = await api.post(`/requests/${this.id}/auto-assign`);
      this.operatorKey = this.keyOfMembership(auto.assignee?.membershipId);
    } else {
      const wanted = this.pickOperator();
      const membershipId = this.t.actor(wanted).membershipId;
      if (v.assignee?.membershipId !== membershipId) {
        await api.post(`/requests/${this.id}/assign`, { assigneeMembershipId: membershipId, role: 'OPERATOR', ...(v.assignee ? { reason: 'Workload balanced between operators. (demo)' } : {}) });
      }
      this.operatorKey = wanted;
    }
    // Cases that need a review get their reviewer straight away (never the operator: segregation of duties).
    if (this.svc.requiresApproval && this.reviewer.membershipId !== this.operator().membershipId && v.reviewer?.membershipId !== this.reviewer.membershipId) {
      await api.post(`/requests/${this.id}/assign`, { assigneeMembershipId: this.reviewer.membershipId, role: 'REVIEWER' });
    }
  }
  private keyOfMembership(membershipId: string | undefined): string {
    const all = [this.t.fx.owner, ...this.t.fx.staff];
    const hit = all.find((s) => this.t.actor(s.key).membershipId === membershipId);
    return need(hit?.key, 'the staff member chosen by automatic assignment');
  }

  private async assignAndStart(): Promise<void> {
    await this.assign();
    await this.rt.as(this.operator()).post(`/requests/${this.id}/transition`, { to: 'IN_PREPARATION' });
    for (const c of this.fx.comments ?? []) await this.rt.as(this.t.actor(c.by)).post(`/requests/${this.id}/comments`, { body: c.body, visibility: c.visibility });
    await this.expect('IN_PREPARATION');
  }

  private async askQuestion(): Promise<void> {
    await this.rt.as(this.operator()).post(`/requests/${this.id}/request-information`, { message: this.fx.question!.message });
    await this.expect('AWAITING_CUSTOMER');
  }
  private async answerQuestion(): Promise<void> {
    const who = this.cust.portal ?? this.desk;
    await this.rt.as(who).post(`/requests/${this.id}/comments`, { body: this.fx.question!.reply ?? 'Here is the information you asked for. (demo)', visibility: 'CUSTOMER' });
    await this.rt.as(who).post(`/requests/${this.id}/resubmit`, { note: 'Information provided. (demo)' });
    await this.expect('IN_PREPARATION');
  }

  private nextAfterPreparation(): string {
    return this.svc.requiresApproval ? 'PENDING_APPROVAL' : this.submits ? 'READY_TO_SUBMIT' : 'FINAL_REVIEW';
  }

  /** The operator files the prepared document and marks the preparation as done; the workflow decides what follows. */
  private async prepare(): Promise<void> {
    const operator = this.operator();
    if (this.fx.deliverable !== false) {
      const v = await this.rt.as(operator).post(`/requests/${this.id}/checklist`, { documentTypeKey: 'completed_document', label: 'Prepared document', labelAr: 'المستند الجاهز', isMandatory: true, kind: 'COMPLETION' });
      const line = (v.checklist as any[]).find((l) => l.kind === 'COMPLETION' && !l.document);
      if (!line) throw new Error('the completion line was not added to the checklist.');
      const sample = await buildSample(this.ctx, this.t, 'completed_document', this.cust, { label: `Prepared: ${this.svc.name}`.slice(0, 80), variant: this.fx.ref });
      await uploadDocument(this.ctx, operator, { customerId: this.cust.id, requestId: this.id, checklistItemId: line.id, documentTypeKey: 'completed_document', title: sample.title.slice(0, 190) }, sample.file);
      this.t.count('documents');
      await this.rt.settle();
    }
    await this.rt.as(operator).post(`/requests/${this.id}/workflow/complete-step`, { note: 'Preparation finished. (demo)' });
    await this.expect(this.nextAfterPreparation());
  }

  private async review(decision: 'APPROVED' | 'REJECTED', comment?: string): Promise<void> {
    const v = await this.view(this.reviewer);
    const pending = (v.approvals as any[] | undefined)?.find((a) => a.status === 'PENDING');
    if (!pending) throw new Error('no pending review was found on the request.');
    await this.rt.as(this.reviewer).post(`/requests/${this.id}/approvals/${pending.id}/decide`, { decision, comment: comment ?? 'Checked against the documents. (demo)' });
    await this.expect(decision === 'REJECTED' ? 'IN_PREPARATION' : this.submits ? 'READY_TO_SUBMIT' : 'FINAL_REVIEW');
  }
  private async rework(): Promise<void> {
    const operator = this.operator();
    await this.rt.as(operator).post(`/requests/${this.id}/comments`, { body: 'Corrected as requested by the reviewer. (demo note)', visibility: 'INTERNAL' });
    await this.rt.as(operator).post(`/requests/${this.id}/workflow/complete-step`, { note: 'Corrected. (demo)' });
    await this.expect('PENDING_APPROVAL');
  }

  /** The partner submitted the file: staff record the channel and the (sample) reference. Nothing is sent anywhere. */
  private async recordSubmission(): Promise<void> {
    const partner = need(this.t.fx.partner, 'a sample partner');
    const operator = this.operator();
    const v = await this.rt.as(operator).post(`/requests/${this.id}/external-references`, {
      channel: 'AUTHORISED_PARTNER',
      authorityName: 'Sample authority (fictional)',
      referenceNo: this.ctx.nextReference('APP'),
      partnerName: partner.name,
      partnerReference: this.ctx.nextReference('PRT'),
      notes: 'Sample reference numbers: they do not exist at any authority or partner.',
    });
    const status = this.fx.external?.statusNote;
    const refs = (v.externalReferences as any[]) ?? [];
    const latest = refs[refs.length - 1] ?? refs[0];
    if (status && latest) await this.rt.as(operator).patch(`/requests/${this.id}/external-references/${latest.id}`, { status });
    await this.expect('EXTERNAL_PROCESSING');
  }
  private async externalResult(outcome: 'COMPLETED' | 'RETURNED' | 'REJECTED', note?: string): Promise<void> {
    await this.rt.as(this.operator()).post(`/requests/${this.id}/external-result`, { outcome, note: note ?? (outcome === 'COMPLETED' ? 'The partner confirmed that the application was processed (sample).' : undefined) });
    await this.expect(outcome === 'COMPLETED' ? 'FINAL_REVIEW' : outcome);
  }
  private async resubmitAfterReturn(): Promise<void> {
    const operator = this.operator();
    await this.rt.as(operator).post(`/requests/${this.id}/transition`, { to: 'IN_PREPARATION' });
    await this.rt.as(operator).post(`/requests/${this.id}/comments`, { body: 'Corrected what the partner asked for. (demo note)', visibility: 'INTERNAL' });
    await this.rt.as(operator).post(`/requests/${this.id}/workflow/complete-step`, { note: 'Corrected after the return. (demo)' });
    await this.expect('READY_TO_SUBMIT');
    await this.recordSubmission();
  }

  private async complete(): Promise<void> {
    const inv = this.invoice;
    if (inv && !this.onAccount && round2(inv.total - inv.paid) > 0) {
      // Deposit / pay-on-completion services: the balance is collected at the counter before hand-over.
      const balance = round2(inv.total - inv.paid);
      const method = this.fx.payment && this.fx.payment.method !== 'ONLINE' && this.fx.payment.method !== 'CHEQUE' ? this.fx.payment.method : 'CASH';
      await this.recordManual(method, balance);
      await this.rt.settle();
    }
    if (this.fx.remitGovernmentFee && this.governmentFee > 0) {
      const expense = await this.rt.as(this.t.accountant()).post('/expenses', {
        branchId: this.branch.id,
        category: 'GOVERNMENT_FEE_REMITTANCE',
        requestId: this.id,
        description: `Government fee paid on behalf of the customer, ${this.requestNo} (demo)`,
        amount: this.governmentFee.toFixed(2),
        paidOn: isoDay(this.vt),
        payee: 'Sample authority (fictional)',
        reference: this.ctx.nextReference('GOV'),
        method: 'E_WALLET',
      });
      this.ctx.timeline.alias(expense.id, this.id);
      this.t.count('expenses');
    }
    await this.rt.as(this.reviewer).post(`/requests/${this.id}/complete`);
    await this.expect('COMPLETED');
  }

  private async rate(): Promise<void> {
    const portal = need(this.cust.portal, `a portal account for "${this.cust.key}" to leave feedback`);
    await this.rt.as(portal).post('/me/feedback', { requestId: this.id, rating: this.fx.rating!.stars, ...(this.fx.rating!.comment ? { comment: this.fx.rating!.comment } : {}) });
    this.t.count('feedback');
  }

  /** Refunds: the accountant asks, the owner decides - never the same person. */
  private async refund(paymentId: string, amount: number, reason: string, outcome: 'COMPLETED' | 'PENDING' | 'REJECTED', manual: boolean): Promise<void> {
    const requester = this.t.accountant();
    const approver = this.t.owner;
    if (requester.userId === approver.userId) throw new Error(`${this.t.slug} has nobody besides the owner who may request refunds; the scenario cannot keep the two roles apart.`);
    const refund = await this.rt.as(requester).post(
      '/refunds',
      { paymentId, invoiceId: this.invoice?.id, amount: amount.toFixed(2), reason, cancelCharge: true },
      { headers: { 'Idempotency-Key': this.t.idempotencyKey('refund') } },
    );
    this.ctx.timeline.alias(refund.id, this.id);
    this.t.count('refunds');
    if (outcome === 'PENDING') return;
    if (outcome === 'REJECTED') {
      await this.rt.as(approver).post(`/refunds/${refund.id}/reject`, { reason: 'Not refundable: the work was already carried out. (demo)' });
      return;
    }
    const done = await this.rt.as(approver).post(`/refunds/${refund.id}/approve`, manual ? { reference: `Returned at the counter, voucher ${this.ctx.nextReference('RFD')}` } : {});
    if (done.status !== 'COMPLETED') throw new Error(`the refund ended as ${done.status}${done.rejectionReason ? `: ${done.rejectionReason}` : ''}.`);
  }

  private async gatewayRefund(): Promise<void> {
    const online = need(this.payments.find((p) => p.method === 'ONLINE'), 'an online payment to refund');
    await this.refund(online.id, Number(this.fx.gatewayRefund!.amount), this.fx.gatewayRefund!.reason, 'COMPLETED', false);
  }

  private async cancel(): Promise<void> {
    const c = this.fx.cancel!;
    const who = c.by === 'CUSTOMER' ? need(this.cust.portal, `a portal account for "${this.cust.key}" to cancel online`) : this.decider;
    await this.rt.as(who).post(`/requests/${this.id}/cancel`, { reason: c.reason });
    await this.expect('CANCELLED');
    if (c.refund) {
      const payment = need(this.payments[0], 'a payment to refund');
      await this.refund(payment.id, payment.amount, c.refundReason ?? 'Request cancelled. (demo)', c.refund, payment.method !== 'ONLINE');
    }
  }

  private async reopen(): Promise<void> {
    await this.rt.as(this.decider).post(`/requests/${this.id}/reopen`, { reason: this.fx.reopened });
    await this.rt.as(this.desk).patch(`/requests/${this.id}`, { targetDate: new Date(Date.now() + this.rng.int(2, 5) * DAY).toISOString() });
    await this.expect('IN_PREPARATION');
  }
}

/** Runs every request scenario of a centre, oldest first, so request numbers grow with time. */
export async function runRequests(ctx: SeedContext, t: TenantState, hooks: { before?: (fx: RequestScenarioFx) => Promise<void> } = {}): Promise<void> {
  const ordered = [...t.fx.requests].sort((a, b) => b.start - a.start);
  // From here on, account messages that name no record (a one-time code, an invitation) are "now" again.
  ctx.timeline.mark(t.id, new Date());
  // Progress in a few lines per centre instead of one per request.
  const chunk = Math.max(8, Math.ceil(ordered.length / 6));
  for (let i = 0; i < ordered.length; i += chunk) {
    const batch = ordered.slice(i, i + chunk);
    await step(`${t.fx.name}: requests ${i + 1}-${i + batch.length} of ${ordered.length}`, async () => {
      const rests: Record<string, number> = {};
      for (const fx of batch) {
        if (hooks.before) await hooks.before(fx);
        const done = await new ScenarioRun(ctx, t, fx).run();
        rests[done.status] = (rests[done.status] ?? 0) + 1;
      }
      return rests;
    }, (rests) => Object.entries(rests).map(([s, n]) => `${n} ${s}`).join(', '));
  }
}
