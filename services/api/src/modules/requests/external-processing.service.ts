import { Injectable, Optional } from '@nestjs/common';
import { REQUEST_STATUS_META, TERMINAL_STATUSES } from '@typease/types';
import type { RecordExternalReferenceBody, RecordExternalResultBody, UpdateExternalReferenceBody } from '@typease/validation';
import type { RequestExternalReference, ServiceRequest, StatusSource } from '@typease/database';
import { AuditService } from '../../common/audit.service';
import { ctx } from '../../common/context';
import { TenantDb, Tx } from '../../common/db/prisma.service';
import { Errors, found } from '../../common/errors';
import { Clock } from '../workflows/clock';
import { OfficialSubmissionPort } from './official-submission.port';
import { isExternalActor, RequestAccess } from './request-access';
import { EXTERNAL_RESULT_STATUSES, externalResultOf, permittedChannels, RequestReader } from './request-reader.service';
import { AS_CONTEXT, RequestStateMachine } from './request-state-machine.service';
import { RequestViews } from './request-view.service';

const notAvailable = (why: string) =>
  Errors.unprocessable('OFFICIAL_INTEGRATION_NOT_AVAILABLE', `Submission through an official API is not available: ${why} Submit through the official portal and record the reference as a manual submission instead.`);

/**
 * Government / external processing (product brief section 31).
 *
 * The centre's staff submit outside TypEase - on the official portal with the
 * centre's own authorised credentials, or through an authorised partner - and
 * record here what happened. TypEase never contacts an authority itself, and
 * every stored status carries its source:
 *
 *   STAFF_ENTERED      typed by staff (not verified by the authority)
 *   PARTNER_PROVIDED   reported by the authorised partner
 *   VERIFIED_OFFICIAL  returned by a registered OfficialSubmissionPort adapter - never by HTTP input
 */
@Injectable()
export class ExternalProcessingService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly access: RequestAccess,
    private readonly reader: RequestReader,
    private readonly machine: RequestStateMachine,
    private readonly views: RequestViews,
    @Optional() private officialPort?: OfficialSubmissionPort,
  ) {}

  private requirePermission(...any: string[]): void {
    const c = ctx();
    if (c.actorType !== 'SYSTEM' && !any.some((p) => c.permissions.has(p))) throw Errors.forbidden();
  }

  async list(id: string) {
    return this.db.tx(async (tx) => {
      const request = await this.access.load(tx, id);
      const rows = await tx.requestExternalReference.findMany({ where: { tenantId: this.db.tenantId, requestId: request.id }, orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }] });
      return rows.map((r) => this.views.reference(r, isExternalActor()));
    });
  }

  /** Records a submission and moves the request to EXTERNAL_PROCESSING. */
  async recordSubmission(id: string, input: RecordExternalReferenceBody) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      await this.access.assertVisible(tx, id);
      const request = await this.machine.lock(tx, id);
      this.requirePermission('request.submit_external');

      const snapshot = await this.reader.snapshot(tx, request);
      const channels = permittedChannels(snapshot.complianceCapability);
      if (!channels.length) {
        throw Errors.unprocessable('SUBMISSION_NOT_PERMITTED', 'The centre only prepares the documents for this service. The customer submits the application themselves, so no submission can be recorded.');
      }
      if (!channels.includes(input.channel)) {
        throw Errors.unprocessable('CHANNEL_NOT_PERMITTED', `This service cannot be submitted through ${input.channel}. Permitted: ${channels.join(', ')}.`, { permitted: channels });
      }
      if (input.channel === 'AUTHORISED_PARTNER' && !input.partnerName) {
        throw Errors.unprocessable('PARTNER_NAME_REQUIRED', 'Name the authorised partner the application was handed to.');
      }
      if (request.status !== 'READY_TO_SUBMIT' && request.status !== 'EXTERNAL_PROCESSING') {
        throw Errors.conflict('INVALID_TRANSITION', `A submission can only be recorded when the request is ready to submit (it is ${REQUEST_STATUS_META[request.status].en.toLowerCase()}).`, { from: request.status, to: 'EXTERNAL_PROCESSING' });
      }

      let status = 'Submitted';
      let statusSource: StatusSource = input.channel === 'AUTHORISED_PARTNER' ? 'PARTNER_PROVIDED' : 'STAFF_ENTERED';
      let integrationId: string | null = null;
      let referenceNo = input.referenceNo;
      if (input.channel === 'OFFICIAL_API') {
        const confirmed = await this.confirmOfficially(tx, request, input);
        ({ status, referenceNo, integrationId } = confirmed);
        statusSource = 'VERIFIED_OFFICIAL';
      }

      const now = this.clock.now();
      const reference = await tx.requestExternalReference.create({
        data: {
          tenantId, requestId: id, channel: input.channel, authorityName: input.authorityName ?? null, referenceNo,
          partnerName: input.channel === 'AUTHORISED_PARTNER' ? (input.partnerName ?? null) : null,
          partnerReference: input.channel === 'AUTHORISED_PARTNER' ? (input.partnerReference ?? null) : null,
          status, statusSource, integrationId, notes: input.notes ?? null, recordedById: ctx().userId ?? null, recordedAt: now,
        },
      });
      await this.audit.log(
        { action: 'request.submission_recorded', resourceType: 'RequestExternalReference', resourceId: reference.id, summary: `${request.requestNo}: submitted via ${input.channel}, reference ${referenceNo}`, after: { channel: input.channel, referenceNo, authorityName: input.authorityName ?? null, partnerName: reference.partnerName, statusSource } },
        tx,
      );
      const mirror = { submissionChannel: input.channel, externalStatus: status, externalStatusSource: statusSource, externalStatusAt: now };
      if (request.status === 'EXTERNAL_PROCESSING') {
        // An additional reference for a case that is already with the authority / partner.
        const after = await tx.serviceRequest.update({ where: { id }, data: { ...mirror, version: { increment: 1 } } });
        return this.views.detail(tx, after);
      }
      const result = await this.machine.transition(tx, id, 'EXTERNAL_PROCESSING', { actor: AS_CONTEXT, meta: { externalReferenceId: reference.id, channel: input.channel }, set: mirror });
      return this.views.detail(tx, result.request);
    });
  }

  /**
   * OFFICIAL_API: only with a verified, active government integration of the
   * tenant AND a registered adapter that confirms the submission with the
   * authority. Without both, the answer is a typed "not available" error.
   */
  private async confirmOfficially(tx: Tx, request: ServiceRequest, input: RecordExternalReferenceBody) {
    const integration = await tx.integration.findFirst({
      where: { tenantId: this.db.tenantId, category: 'GOVERNMENT', status: 'ACTIVE', authorisationVerifiedAt: { not: null } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, provider: true },
    });
    if (!integration) throw notAvailable('this centre has no active government integration whose authorisation has been verified.');
    if (!this.officialPort || !this.officialPort.providers.includes(integration.provider)) {
      throw notAvailable(`no official adapter for "${integration.provider}" is installed in this TypEase deployment.`);
    }
    let confirmation;
    try {
      confirmation = await this.officialPort.confirmSubmission({ integrationId: integration.id, provider: integration.provider, requestId: request.id, requestNo: request.requestNo, referenceNo: input.referenceNo, authorityName: input.authorityName ?? null });
    } catch (e: any) {
      throw notAvailable(`the authority did not confirm reference ${input.referenceNo} (${String(e?.message ?? e).slice(0, 200)}).`);
    }
    return { status: confirmation.status, referenceNo: confirmation.referenceNo, integrationId: integration.id };
  }

  /** Staff or partner update of an external status. The source is derived, never accepted from the client. */
  async updateReference(id: string, referenceId: string, input: UpdateExternalReferenceBody) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      await this.access.assertVisible(tx, id);
      const request = await this.machine.lock(tx, id);
      this.requirePermission('request.submit_external', 'request.process');
      if (TERMINAL_STATUSES.includes(request.status)) throw Errors.conflict('REQUEST_CLOSED', `This request is ${REQUEST_STATUS_META[request.status].en.toLowerCase()} and can no longer be changed.`);
      const reference = found(await tx.requestExternalReference.findFirst({ where: { id: referenceId, requestId: id, tenantId } }), 'External reference');
      if (input.status !== undefined && (EXTERNAL_RESULT_STATUSES as readonly string[]).includes(input.status.toUpperCase())) {
        throw Errors.unprocessable('USE_RESULT_ACTION', 'To record the final outcome (completed, returned or rejected) use "Record result", so that the request moves on correctly.');
      }
      if (input.status !== undefined && externalResultOf(reference)) {
        throw Errors.conflict('RESULT_ALREADY_RECORDED', `The result of this submission is already recorded (${reference.status}). Record a new submission if the application was sent again.`);
      }
      const now = this.clock.now();
      // Whatever a person types is, at best, what the partner told them. It is never "official".
      const statusSource: StatusSource = reference.channel === 'AUTHORISED_PARTNER' ? 'PARTNER_PROVIDED' : 'STAFF_ENTERED';
      const updated = await tx.requestExternalReference.update({
        where: { id: referenceId },
        data: { ...(input.status !== undefined ? { status: input.status, statusSource } : {}), ...(input.notes !== undefined ? { notes: input.notes ?? null } : {}) },
      });
      if (input.status !== undefined) await this.mirrorLatest(tx, id, updated, now);
      await this.audit.log(
        { action: 'request.external_status_updated', resourceType: 'RequestExternalReference', resourceId: referenceId, summary: `${request.requestNo}: external status "${updated.status ?? ''}" (${updated.statusSource})`, before: { status: reference.status, statusSource: reference.statusSource }, after: { status: updated.status, statusSource: updated.statusSource } },
        tx,
      );
      return this.views.reference(updated, false);
    });
  }

  /** The request shows the status of its newest reference. */
  private async mirrorLatest(tx: Tx, requestId: string, updated: RequestExternalReference, now: Date): Promise<void> {
    const latest = await this.reader.latestExternalReference(tx, requestId);
    if (latest?.id !== updated.id) return;
    await tx.serviceRequest.update({ where: { id: requestId }, data: { externalStatus: updated.status, externalStatusSource: updated.statusSource, externalStatusAt: now } });
  }

  /** The outcome reported by the authority / partner: completed, returned for correction, or rejected. */
  async recordResult(id: string, input: RecordExternalResultBody) {
    return this.db.tx(async (tx) => {
      await this.access.assertVisible(tx, id);
      const request = await this.machine.lock(tx, id);
      this.requirePermission('request.process');
      if (request.status !== 'EXTERNAL_PROCESSING') {
        throw Errors.conflict('INVALID_TRANSITION', `A result can only be recorded while the request is in external processing (it is ${REQUEST_STATUS_META[request.status].en.toLowerCase()}).`, { from: request.status });
      }
      if (input.outcome !== 'COMPLETED') {
        // The state machine stamps the outcome on the open submission as part of the transition.
        const result = await this.machine.transition(tx, id, input.outcome, { actor: AS_CONTEXT, reason: input.note ?? null, meta: { externalOutcome: input.outcome } });
        return this.views.detail(tx, result.request);
      }
      const reference = await this.reader.latestExternalReference(tx, id);
      if (!reference || externalResultOf(reference)) throw Errors.unprocessable('EXTERNAL_REFERENCE_REQUIRED', 'There is no open submission to record a result for.');
      const now = this.clock.now();
      const statusSource: StatusSource = reference.channel === 'AUTHORISED_PARTNER' ? 'PARTNER_PROVIDED' : 'STAFF_ENTERED';
      await tx.requestExternalReference.update({ where: { id: reference.id }, data: { status: 'COMPLETED', statusSource, notes: input.note ?? reference.notes } });
      await this.audit.log({ action: 'request.external_result_recorded', resourceType: 'RequestExternalReference', resourceId: reference.id, summary: `${request.requestNo}: external result COMPLETED (${statusSource})`, before: { status: reference.status }, after: { status: 'COMPLETED', statusSource } }, tx);
      const result = await this.machine.transition(tx, id, 'FINAL_REVIEW', {
        actor: AS_CONTEXT,
        reason: input.note ?? null,
        meta: { externalOutcome: 'COMPLETED', externalReferenceId: reference.id },
        set: { externalStatus: 'COMPLETED', externalStatusSource: statusSource, externalStatusAt: now },
      });
      return this.views.detail(tx, result.request);
    });
  }

  /**
   * For an OfficialSubmissionPort adapter only (never routed over HTTP):
   * refreshes a reference from the authority and stores the answer as
   * VERIFIED_OFFICIAL. Without a registered adapter this is not available.
   */
  async refreshOfficialStatus(requestId: string, referenceId: string) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const request = await this.machine.lock(tx, requestId);
      const reference = found(await tx.requestExternalReference.findFirst({ where: { id: referenceId, requestId, tenantId } }), 'External reference');
      const integration = reference.integrationId
        ? await tx.integration.findFirst({ where: { id: reference.integrationId, tenantId, category: 'GOVERNMENT', status: 'ACTIVE', authorisationVerifiedAt: { not: null } }, select: { id: true, provider: true } })
        : null;
      if (reference.channel !== 'OFFICIAL_API' || !integration) throw notAvailable('this submission was not made through a verified official integration.');
      if (!this.officialPort || !this.officialPort.providers.includes(integration.provider)) throw notAvailable(`no official adapter for "${integration.provider}" is installed in this TypEase deployment.`);
      const answer = await this.officialPort.fetchStatus({ integrationId: integration.id, provider: integration.provider, requestId, requestNo: request.requestNo, referenceNo: reference.referenceNo, authorityName: reference.authorityName });
      const now = this.clock.now();
      const updated = await tx.requestExternalReference.update({ where: { id: referenceId }, data: { status: answer.status, statusSource: 'VERIFIED_OFFICIAL' } });
      await this.mirrorLatest(tx, requestId, updated, now);
      await this.audit.log({ action: 'request.external_status_verified', resourceType: 'RequestExternalReference', resourceId: referenceId, summary: `${request.requestNo}: official status "${answer.status}"`, before: { status: reference.status, statusSource: reference.statusSource }, after: { status: answer.status, statusSource: 'VERIFIED_OFFICIAL' } }, tx);
      return this.views.reference(updated, false);
    });
  }
}
