'use client';

import * as React from 'react';
import { useI18n, type Tone } from '@typease/ui';

export const REQUEST_STATUS_TONE: Record<string, Tone> = { RECEIVED: 'info', IN_REVIEW: 'warning', APPROVED: 'info', REJECTED: 'neutral', COMPLETED: 'success' };
export const INCIDENT_STATUS_TONE: Record<string, Tone> = { OPEN: 'danger', INVESTIGATING: 'warning', CONTAINED: 'info', RESOLVED: 'success' };
export const SEVERITY_TONE: Record<string, Tone> = { LOW: 'neutral', MEDIUM: 'info', HIGH: 'warning', CRITICAL: 'danger' };
export const PROCESSOR_STATUS_TONE: Record<string, Tone> = { PENDING_REVIEW: 'warning', APPROVED: 'success', REJECTED: 'danger' };

/** Words for the codes of the privacy module. Unknown codes (added to the API later) are shown readable instead of dropped. */
export function usePrivacyLabels() {
  const { t, has } = useI18n();
  return React.useMemo(() => {
    const word = (prefix: string, code: string) => (has(`${prefix}.${code}`) ? t(`${prefix}.${code}`) : code.toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()));
    return {
      requestType: (code: string) => word('adm.privacy.requests.types', code),
      requestStatus: (code: string) => word('adm.privacy.requests.statuses', code),
      purpose: (code: string) => word('adm.privacy.consents.purposes', code),
      basis: (code: string) => word('adm.privacy.consents.bases', code),
      entity: (code: string) => word('adm.privacy.retention.entities', code),
      action: (code: string) => word('adm.privacy.retention.actions', code),
      incidentStatus: (code: string) => word('adm.privacy.incidents.statuses', code),
      severity: (code: string) => word('adm.privacy.incidents.severities', code),
      processorStatus: (code: string) => word('adm.privacy.processors.statuses', code),
    };
  }, [t, has]);
}

/** ISO timestamp <-> the value of an <input type="datetime-local"> (the browser's local time). */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
