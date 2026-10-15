import { Actor, TestApp } from '../../services/api/test/helpers';
import { api } from './centre';
import { uploadDocument, Uploaded } from './documents';
import { pdf, png } from './files';
import { recordPayment } from './finance';

/** The staff of a centre who take part in a case. */
export interface Crew {
  owner: Actor;
  receptionist: Actor;
  reviewer: Actor;
  operator: Actor;
}

export type Stage = 'DRAFT' | 'SUBMITTED' | 'VERIFIED' | 'QUOTED' | 'AWAITING_PAYMENT' | 'READY_FOR_PROCESSING' | 'IN_PREPARATION' | 'COMPLETED';
const ORDER: Stage[] = ['DRAFT', 'SUBMITTED', 'VERIFIED', 'QUOTED', 'AWAITING_PAYMENT', 'READY_FOR_PROCESSING', 'IN_PREPARATION', 'COMPLETED'];

export interface CaseOptions {
  serviceId: string;
  branchId: string;
  /** A portal customer creates, uploads and approves online ... */
  portalCustomer?: Actor;
  /** ... or the receptionist does it at the counter for this customer record. */
  customerId?: string;
  fields?: Record<string, unknown>;
  /** Where the case should rest. Default: COMPLETED. */
  stopAt?: Stage;
}

export interface CaseFile {
  requestId: string;
  requestNo: string;
  customerId: string;
  status: string;
  trackingCode?: string;
  inputs: Uploaded[];
  quotationId?: string;
  invoiceId?: string;
  invoiceNo?: string;
  /** Invoice total as the API printed it. */
  total?: string;
  paymentId?: string;
  result?: Uploaded;
}

/**
 * Drives one request through the standard workflow with the same calls, by the
 * same kinds of users, in the same order as scenario 6-17 does it step by step
 * (tests/integration/02-request-journey.spec.ts). For a service WITHOUT a review
 * step and WITHOUT submission to an authority, paid in cash before processing.
 * After every stage the case must be in the expected status, otherwise the
 * helper stops with the API's own explanation.
 */
export async function runCase(t: TestApp, crew: Crew, o: CaseOptions): Promise<CaseFile> {
  const stop = ORDER.indexOf(o.stopAt ?? 'COMPLETED');
  const front = o.portalCustomer ?? crew.receptionist;
  const view = async (actor: Actor = crew.receptionist) => api(t, actor).get(`/requests/${file.requestId}`);
  const expectStatus = async (...wanted: string[]) => {
    await t.settle();
    const v = await view();
    if (!wanted.includes(v.status)) {
      const blocked = v.nextStep?.step?.blocked;
      throw new Error(`${v.requestNo}: expected ${wanted.join(' or ')}, but the request is ${v.status}${blocked ? ` (workflow waits: ${blocked.code} - ${blocked.message})` : ''}.`);
    }
    file.status = v.status;
    return v;
  };

  // --- created
  const draft = await api(t, front).post('/requests', { serviceId: o.serviceId, ...(o.portalCustomer ? {} : { customerId: o.customerId, branchId: o.branchId }), ...(o.fields ? { fields: o.fields } : {}) }, 201);
  const file: CaseFile = { requestId: draft.id, requestNo: draft.requestNo, customerId: draft.customer.id, status: draft.status, inputs: [] };
  if (stop === 0) return file;

  // --- documents uploaded, submitted
  for (const line of (draft.checklist as any[]).filter((l) => l.kind === 'INPUT' && l.status === 'MISSING')) {
    const sample = line.documentTypeKey === 'photo' ? png() : pdf(`${line.documentTypeKey} of ${draft.requestNo}`, `${line.documentTypeKey}.pdf`);
    file.inputs.push(await uploadDocument(t, front, { ...(o.portalCustomer ? {} : { customerId: file.customerId }), requestId: file.requestId, checklistItemId: line.id, documentTypeKey: line.documentTypeKey }, sample, { settle: false }));
  }
  const submitted = await api(t, front).post(`/requests/${file.requestId}/submit`, {}, 200);
  file.trackingCode = submitted.trackingCode;
  await expectStatus('UNDER_REVIEW');
  if (stop === 1) return file;

  // --- documents verified
  for (const doc of file.inputs) await api(t, crew.reviewer).post(`/documents/${doc.documentId}/verify`, { decision: 'APPROVED' });
  await expectStatus('UNDER_REVIEW');
  if (stop === 2) return file;

  // --- quotation sent
  const quotation = await api(t, crew.receptionist).post(`/quotations/from-request/${file.requestId}`, {}, 201);
  file.quotationId = quotation.id;
  await api(t, crew.receptionist).post(`/quotations/${quotation.id}/send`);
  await expectStatus('QUOTED');
  if (stop === 3) return file;

  // --- approved by the customer (online) or at the counter on the customer's behalf
  const approved = o.portalCustomer
    ? await api(t, o.portalCustomer).post(`/quotations/${quotation.id}/approve`, {}, [200, 201])
    : await api(t, crew.receptionist).post(`/quotations/${quotation.id}/approve`, { note: 'Approved by the customer at the counter.' }, [200, 201]);
  file.invoiceId = approved.invoice.id;
  file.invoiceNo = approved.invoice.invoiceNo;
  file.total = approved.invoice.total;
  await expectStatus('AWAITING_PAYMENT');
  if (stop === 4) return file;

  // --- paid in cash
  const payment = await recordPayment(t, crew.receptionist, { invoiceId: file.invoiceId!, amount: file.total!, branchId: o.branchId, customerId: file.customerId });
  file.paymentId = payment.id;
  await expectStatus('READY_FOR_PROCESSING');
  if (stop === 5) return file;

  // --- assigned and started
  await api(t, crew.owner).post(`/requests/${file.requestId}/assign`, { assigneeMembershipId: crew.operator.membershipId, role: 'OPERATOR' }, [200, 201]);
  await api(t, crew.operator).post(`/requests/${file.requestId}/transition`, { to: 'IN_PREPARATION' }, [200, 201]);
  await expectStatus('IN_PREPARATION');
  if (stop === 6) return file;

  // --- prepared, result filed, completed
  const withLine = await api(t, crew.operator).post(`/requests/${file.requestId}/checklist`, { documentTypeKey: 'completed_document', label: 'Prepared document', isMandatory: true, kind: 'COMPLETION' }, [200, 201]);
  const completion = (withLine.checklist as any[]).find((l) => l.kind === 'COMPLETION' && !l.document);
  file.result = await uploadDocument(t, crew.operator, { customerId: file.customerId, requestId: file.requestId, checklistItemId: completion.id, documentTypeKey: 'completed_document', title: `Prepared document ${file.requestNo}` }, pdf(`result of ${file.requestNo}`, 'prepared.pdf', 900));
  await api(t, crew.operator).post(`/requests/${file.requestId}/workflow/complete-step`, { note: 'Preparation finished.' }, [200, 201]);
  await expectStatus('FINAL_REVIEW');
  await api(t, crew.reviewer).post(`/requests/${file.requestId}/complete`, {}, [200, 201]);
  await expectStatus('COMPLETED');
  return file;
}
