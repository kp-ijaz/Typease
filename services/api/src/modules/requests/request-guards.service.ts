import { Injectable } from '@nestjs/common';
import type { RequestStatus } from '@typease/types';
import type { ServiceRequest } from '@typease/database';
import { TenantDb, Tx } from '../../common/db/prisma.service';
import { AppError } from '../../common/errors';
import { validateFormValues } from './form-validator';
import { externalResultOf, permittedChannels, RequestReader } from './request-reader.service';

export interface GuardFailure {
  status: number;
  code: string;
  message: string;
  details?: unknown;
}
const fail = (code: string, message: string, details?: unknown, status = 422): GuardFailure => ({ status, code, message, details });
export const guardError = (f: GuardFailure) => new AppError(f.status, f.code, f.message, f.details);

const names = (lines: Array<{ label: string }>) => lines.map((l) => l.label).join(', ');

/**
 * Business guards of the request state machine. A guard answers one question:
 * "may this request enter status X from status Y right now?" It never looks
 * at who is asking (permissions are checked separately) and it applies to
 * everybody, including the workflow engine. That is what makes compliance
 * independent of how a centre configured its workflow.
 */
@Injectable()
export class RequestGuards {
  constructor(
    private readonly db: TenantDb,
    private readonly reader: RequestReader,
  ) {}

  async check(tx: Tx, request: ServiceRequest, to: RequestStatus): Promise<GuardFailure | null> {
    const from = request.status;
    switch (to) {
      case 'SUBMITTED':
        return this.formValid(tx, request);
      case 'UNDER_REVIEW':
      case 'IN_PREPARATION': {
        if (from === 'AWAITING_CUSTOMER') return (await this.resumesWhereItWasAsked(tx, request, to)) ?? (await this.noRejectedDocuments(tx, request));
        if (from === 'READY_FOR_PROCESSING') return this.operatorAssigned(request);
        if (from === 'QUOTED') return this.quotationWithdrawn(tx, request);
        return null;
      }
      case 'QUOTED': {
        if (from === 'UNDER_REVIEW') return this.quotationSent(tx, request);
        if (from === 'AWAITING_PAYMENT') return this.quotationNoLongerApproved(tx, request);
        return null;
      }
      case 'AWAITING_PAYMENT':
        return from === 'QUOTED' ? this.quotationApproved(tx, request) : null;
      case 'READY_FOR_PROCESSING':
        return (from === 'QUOTED' ? await this.quotationApproved(tx, request) : null) ?? (await this.documentsVerified(tx, request)) ?? (await this.paymentSatisfied(tx, request, 'PROCESSING'));
      case 'READY_TO_SUBMIT': {
        if (from === 'IN_PREPARATION') return this.noApprovalNeeded(tx, request);
        if (from === 'PENDING_APPROVAL') return this.reviewApproved(tx, request, true);
        return null;
      }
      case 'EXTERNAL_PROCESSING':
        return (await this.submissionPermitted(tx, request)) ?? (await this.reviewApprovedIfRequired(tx, request));
      case 'FINAL_REVIEW': {
        if (from === 'EXTERNAL_PROCESSING') return this.externalResultRecorded(tx, request);
        return (from === 'IN_PREPARATION' ? await this.noApprovalNeeded(tx, request) : null) ?? (await this.noSubmissionPending(tx, request));
      }
      case 'COMPLETED':
        return (await this.completionDocuments(tx, request)) ?? (await this.reviewApprovedIfRequired(tx, request)) ?? (await this.paymentSatisfied(tx, request, 'COMPLETION'));
      default:
        return null;
    }
  }

  // ------------------------------------------------------------------ individual guards
  async formValid(tx: Tx, request: ServiceRequest): Promise<GuardFailure | null> {
    const schema = await this.reader.formSchema(tx, request.formDefinitionId);
    const result = validateFormValues(schema, await this.reader.fieldValues(tx, request.id));
    // Stored values of fields that no longer exist are ignored; they cannot be fixed by the customer.
    const errors = result.errors.filter((e) => e.code !== 'UNKNOWN_FIELD');
    if (!errors.length) return null;
    return fail('FORM_INVALID', `The application form is not complete: ${errors[0].message}`, errors);
  }

  private operatorAssigned(request: ServiceRequest): GuardFailure | null {
    return request.assignedToId ? null : fail('OPERATOR_REQUIRED', 'Assign an operator before preparation starts.');
  }

  private async noRejectedDocuments(tx: Tx, request: ServiceRequest): Promise<GuardFailure | null> {
    const checklist = await this.reader.checklist(tx, request.id);
    if (!checklist.rejected.length) return null;
    return fail('REJECTED_DOCUMENTS_PENDING', `These documents were not accepted and must be replaced first: ${names(checklist.rejected)}.`, { checklistItemIds: checklist.rejected.map((l) => l.id) });
  }

  private async documentsVerified(tx: Tx, request: ServiceRequest): Promise<GuardFailure | null> {
    const checklist = await this.reader.checklist(tx, request.id);
    if (checklist.rejected.length) {
      return fail('DOCUMENTS_REJECTED', `These documents were rejected and must be replaced or waived: ${names(checklist.rejected)}.`, { checklistItemIds: checklist.rejected.map((l) => l.id) });
    }
    if (checklist.unverified.length) {
      return fail('DOCUMENTS_NOT_VERIFIED', `These required documents are not verified yet: ${names(checklist.unverified)}.`, { checklistItemIds: checklist.unverified.map((l) => l.id) });
    }
    return null;
  }

  async paymentSatisfied(tx: Tx, request: ServiceRequest, stage: 'PROCESSING' | 'COMPLETION'): Promise<GuardFailure | null> {
    const payment = await this.reader.payment(tx, request, stage);
    if (payment.satisfied) return null;
    const details = { basis: payment.basis, required: payment.required.toFixed(2), outstanding: payment.outstanding.toFixed(2) };
    if (payment.basis === 'NO_INVOICE') {
      return fail(
        stage === 'PROCESSING' ? 'PAYMENT_REQUIRED' : 'PAYMENT_INCOMPLETE',
        stage === 'PROCESSING'
          ? 'This service is paid before processing, but no invoice has been issued for the request yet. Issue the invoice and collect the payment first.'
          : 'The approved quotation has not been invoiced yet. Issue the invoice and collect the payment before completing the request.',
        details,
      );
    }
    if (stage === 'PROCESSING') {
      return fail(
        'PAYMENT_REQUIRED',
        payment.basis === 'DEPOSIT_DUE'
          ? `A deposit of ${payment.required.toFixed(2)} must be paid before processing can start (${payment.outstanding.toFixed(2)} still missing).`
          : `The invoice must be paid before processing can start (${payment.outstanding.toFixed(2)} outstanding).`,
        details,
      );
    }
    return fail('PAYMENT_INCOMPLETE', `The request cannot be completed while ${payment.outstanding.toFixed(2)} is still unpaid.`, details);
  }

  /**
   * A request that waits for the customer goes back to where the question was
   * asked. Without this, "resume preparation" would be a way around the
   * document and payment checks of a request that was never released.
   */
  private async resumesWhereItWasAsked(tx: Tx, request: ServiceRequest, to: RequestStatus): Promise<GuardFailure | null> {
    const resume = await this.reader.resumeTarget(tx, request.id);
    if (resume.to === to) return null;
    return to === 'IN_PREPARATION'
      ? fail('NOT_RELEASED_FOR_PROCESSING', 'This request was not in preparation when the customer was asked. It returns to document review first.')
      : fail('RESUME_PREPARATION', 'The customer was asked during preparation, so the request returns to preparation, not to document review.');
  }

  /** "Revise quotation" from QUOTED: only when no quotation is with the customer any more. */
  private async quotationWithdrawn(tx: Tx, request: ServiceRequest): Promise<GuardFailure | null> {
    const quotation = await this.reader.currentQuotation(tx, request.id);
    return quotation && ['SENT', 'APPROVED'].includes(quotation.status)
      ? fail('QUOTATION_PENDING', 'The quotation is still valid. Withdraw it or replace it with a revised quotation first; the request then follows automatically.')
      : null;
  }

  /** "Revise quotation" from AWAITING_PAYMENT: only once the approved quotation has been replaced. */
  private async quotationNoLongerApproved(tx: Tx, request: ServiceRequest): Promise<GuardFailure | null> {
    const quotation = await this.reader.currentQuotation(tx, request.id);
    return quotation?.status === 'APPROVED'
      ? fail('QUOTATION_STILL_APPROVED', 'The approved quotation still stands. Send the revised quotation first; the request then returns to the customer automatically.')
      : null;
  }

  private async quotationSent(tx: Tx, request: ServiceRequest): Promise<GuardFailure | null> {
    const quotation = await this.reader.currentQuotation(tx, request.id);
    return quotation && ['SENT', 'APPROVED'].includes(quotation.status) ? null : fail('QUOTATION_REQUIRED', 'Send the quotation to the customer first.');
  }

  private async quotationApproved(tx: Tx, request: ServiceRequest): Promise<GuardFailure | null> {
    const quotation = await this.reader.currentQuotation(tx, request.id);
    return quotation?.status === 'APPROVED' ? null : fail('QUOTATION_NOT_APPROVED', 'The customer has not approved the quotation yet.');
  }

  /** A case that requires review can only leave preparation through "Send for review". */
  private async noApprovalNeeded(tx: Tx, request: ServiceRequest): Promise<GuardFailure | null> {
    return (await this.reader.reviewRequired(tx, request)) ? fail('APPROVAL_REQUIRED', 'This case requires review approval. Send it for review instead.') : null;
  }

  /** `segregation`: the approver must not be the person who prepared the case. */
  private async reviewApproved(tx: Tx, request: ServiceRequest, segregation: boolean): Promise<GuardFailure | null> {
    const { approved } = await this.reader.review(tx, request.id);
    if (!approved) return fail('APPROVAL_REQUIRED', 'A reviewer must approve the prepared application first.');
    if (segregation && request.assignedToId && approved.decidedById) {
      const operator = await tx.tenantMembership.findFirst({ where: { id: request.assignedToId, tenantId: this.db.tenantId }, select: { userId: true } });
      if (operator?.userId === approved.decidedById) {
        return fail('SEGREGATION_OF_DUTIES', 'The person who prepared the case cannot approve it. Another reviewer must decide.', undefined, 403);
      }
    }
    return null;
  }

  private async reviewApprovedIfRequired(tx: Tx, request: ServiceRequest): Promise<GuardFailure | null> {
    return (await this.reader.reviewRequired(tx, request)) ? this.reviewApproved(tx, request, false) : null;
  }

  /** Section 31: who may submit, through which channel, and with what evidence. */
  private async submissionPermitted(tx: Tx, request: ServiceRequest): Promise<GuardFailure | null> {
    const snapshot = await this.reader.snapshot(tx, request);
    const channels = permittedChannels(snapshot.complianceCapability);
    if (!channels.length) {
      return fail('SUBMISSION_NOT_PERMITTED', 'The centre only prepares the documents for this service. The customer submits the application themselves, so no submission can be recorded.');
    }
    const reference = await this.reader.latestExternalReference(tx, request.id);
    if (!reference || externalResultOf(reference)) {
      return fail('EXTERNAL_REFERENCE_REQUIRED', 'Record the submission (channel and reference number) before the request can move to external processing.');
    }
    if (!channels.includes(reference.channel)) {
      return fail('CHANNEL_NOT_PERMITTED', `This service cannot be submitted through ${reference.channel}. Permitted: ${channels.join(', ')}.`);
    }
    if (reference.channel === 'AUTHORISED_PARTNER' && !reference.partnerName) {
      return fail('PARTNER_NAME_REQUIRED', 'Name the authorised partner the application was handed to.');
    }
    if (reference.channel === 'OFFICIAL_API' && (!reference.integrationId || reference.statusSource !== 'VERIFIED_OFFICIAL')) {
      return fail('OFFICIAL_INTEGRATION_NOT_AVAILABLE', 'No verified official integration confirmed this submission. Use the official portal and record the reference as a manual submission.');
    }
    return null;
  }

  private async externalResultRecorded(tx: Tx, request: ServiceRequest): Promise<GuardFailure | null> {
    const reference = await this.reader.latestExternalReference(tx, request.id);
    return externalResultOf(reference) === 'COMPLETED' ? null : fail('EXTERNAL_RESULT_REQUIRED', 'Record the result received from the authority or partner first.');
  }

  /** Final review may only skip submission when the centre does not submit this service at all. */
  private async noSubmissionPending(tx: Tx, request: ServiceRequest): Promise<GuardFailure | null> {
    const snapshot = await this.reader.snapshot(tx, request);
    if (!permittedChannels(snapshot.complianceCapability).length) return null;
    if (!(await this.reader.hasStep(tx, request, 'EXTERNAL_PROCESSING'))) return null;
    return fail('EXTERNAL_SUBMISSION_PENDING', 'This application has to be submitted and its reference recorded before final review.');
  }

  private async completionDocuments(tx: Tx, request: ServiceRequest): Promise<GuardFailure | null> {
    const checklist = await this.reader.checklist(tx, request.id);
    if (!checklist.completionMissing.length) return null;
    return fail('COMPLETION_DOCUMENTS_MISSING', `Attach the completed documents first: ${names(checklist.completionMissing)}.`, { checklistItemIds: checklist.completionMissing.map((l) => l.id) });
  }
}
