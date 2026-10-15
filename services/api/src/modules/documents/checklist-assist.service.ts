import { Injectable } from '@nestjs/common';
import { TenantDb } from '../../common/db/prisma.service';
import { DocumentAccess } from './access';
import { isoDay } from './presenters';

/** A document is reported as "expiring" this many days before its expiry date. */
export const EXPIRING_WITHIN_DAYS = 183;

export type ChecklistLineState = 'MISSING' | 'PROCESSING' | 'BLOCKED' | 'REJECTED' | 'EXPIRED' | 'EXPIRING' | 'UNVERIFIED' | 'PRESENT' | 'WAIVED';

export interface ChecklistDocumentFacts {
  status: string;
  verificationStatus: string;
  expiryDate: Date | null;
}
/** Pure decision: what to tell the user about one checklist line. Most severe finding first. */
export function checklistLineState(waived: boolean, doc: ChecklistDocumentFacts | null, today: Date): { state: ChecklistLineState; daysToExpiry: number | null } {
  if (waived) return { state: 'WAIVED', daysToExpiry: null };
  if (!doc || doc.status === 'DELETED') return { state: 'MISSING', daysToExpiry: null };
  const start = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const daysToExpiry = doc.expiryDate ? Math.round((doc.expiryDate.getTime() - start) / 86400_000) : null;
  if (doc.status === 'QUARANTINED') return { state: 'BLOCKED', daysToExpiry };
  if (doc.status === 'PENDING_UPLOAD' || doc.status === 'PENDING_SCAN') return { state: 'PROCESSING', daysToExpiry };
  if (doc.verificationStatus === 'REJECTED') return { state: 'REJECTED', daysToExpiry };
  if (daysToExpiry !== null && daysToExpiry < 0) return { state: 'EXPIRED', daysToExpiry };
  if (daysToExpiry !== null && daysToExpiry <= EXPIRING_WITHIN_DAYS) return { state: 'EXPIRING', daysToExpiry };
  if (doc.verificationStatus !== 'VERIFIED') return { state: 'UNVERIFIED', daysToExpiry };
  return { state: 'PRESENT', daysToExpiry };
}

const HINTS: Record<ChecklistLineState, string> = {
  MISSING: 'No document has been provided for this line yet.',
  PROCESSING: 'The file is still being uploaded or checked.',
  BLOCKED: 'The uploaded file was blocked by the malware scanner. A clean copy is needed.',
  REJECTED: 'The document was rejected by a reviewer. A corrected copy is needed.',
  EXPIRED: 'The document has expired.',
  EXPIRING: 'The document expires soon. Check whether the authority accepts it.',
  UNVERIFIED: 'A document is attached but has not been verified by staff yet.',
  PRESENT: 'A verified document is attached.',
  WAIVED: 'This document is not required for this request.',
};

/**
 * Checklist assistance: compares a request's document checklist with what is in
 * the vault. Read-only and deterministic (no AI involved): it never changes the
 * checklist, which belongs to the requests module.
 */
@Injectable()
export class ChecklistAssistService {
  constructor(
    private readonly db: TenantDb,
    private readonly access: DocumentAccess,
  ) {}

  async forRequest(requestId: string, today = new Date()) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const request = await this.access.findReadableRequest(tx, requestId);
      const staff = this.access.isStaff();
      const lines = await tx.requestDocument.findMany({ where: { tenantId, requestId: request.id }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }], include: { document: true } });
      // Other documents of the same customer that could answer a missing line.
      const reusable = await tx.document.findMany({
        where: { tenantId, customerId: request.customerId, status: 'AVAILABLE', documentTypeKey: { in: [...new Set(lines.map((l) => l.documentTypeKey))] }, ...(staff ? {} : { customerVisible: true }) },
        orderBy: { createdAt: 'desc' },
        take: 200,
      });

      const items = lines.map((line) => {
        const visible = line.document && (staff || line.document.customerVisible) ? line.document : null;
        const { state, daysToExpiry } = checklistLineState(line.status === 'WAIVED', visible, today);
        const needsDocument = ['MISSING', 'BLOCKED', 'REJECTED', 'EXPIRED'].includes(state);
        const candidates = needsDocument
          ? reusable
              .filter((d) => d.documentTypeKey === line.documentTypeKey && d.id !== line.documentId && (!d.expiryDate || d.expiryDate.getTime() >= today.getTime()))
              .slice(0, 5)
              .map((d) => ({ documentId: d.id, title: d.title, verificationStatus: d.verificationStatus, expiryDate: isoDay(d.expiryDate) }))
          : [];
        return {
          checklistItemId: line.id,
          documentTypeKey: line.documentTypeKey,
          label: line.label,
          labelAr: line.labelAr,
          kind: line.kind,
          isMandatory: line.isMandatory,
          /** Status kept by the requests module. */
          checklistStatus: line.status,
          state,
          hint: HINTS[state],
          documentId: visible?.id ?? null,
          verificationStatus: visible?.verificationStatus ?? null,
          expiryDate: isoDay(visible?.expiryDate),
          expiryVerified: visible?.expiryVerified ?? null,
          daysToExpiry,
          /** Existing documents of the customer that might be reused. A person decides; nothing is attached automatically. */
          candidates,
        };
      });
      const count = (s: ChecklistLineState) => items.filter((i) => i.state === s).length;
      const blocking = items.filter((i) => i.isMandatory && i.kind === 'INPUT' && ['MISSING', 'BLOCKED', 'REJECTED', 'EXPIRED', 'PROCESSING'].includes(i.state));
      return {
        requestId: request.id,
        generatedAt: today,
        expiringWithinDays: EXPIRING_WITHIN_DAYS,
        summary: {
          total: items.length,
          missing: count('MISSING') + count('BLOCKED'),
          rejected: count('REJECTED'),
          expired: count('EXPIRED'),
          expiring: count('EXPIRING'),
          unverified: count('UNVERIFIED'),
          present: count('PRESENT'),
          waived: count('WAIVED'),
          processing: count('PROCESSING'),
          /** True when every mandatory input line has a usable document (verified or not). */
          mandatoryInputsProvided: blocking.length === 0,
          missingMandatory: blocking.map((i) => i.checklistItemId),
        },
        items,
      };
    });
  }
}
