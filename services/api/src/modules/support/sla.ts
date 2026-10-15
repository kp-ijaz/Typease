/** Support SLA rules and the ticket state machine. Pure functions. */
export type Priority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
export type TicketStatus = 'OPEN' | 'IN_PROGRESS' | 'WAITING_CUSTOMER' | 'RESOLVED' | 'CLOSED';

export interface SlaTargets {
  firstResponseMinutes: number;
  resolutionMinutes: number;
}
/** Starting policies of a new centre (calendar minutes). Centres change them in their support settings. */
export const DEFAULT_SLA: Record<Priority, SlaTargets & { name: string }> = {
  URGENT: { name: 'Urgent', firstResponseMinutes: 30, resolutionMinutes: 8 * 60 },
  HIGH: { name: 'High', firstResponseMinutes: 60, resolutionMinutes: 24 * 60 },
  NORMAL: { name: 'Normal', firstResponseMinutes: 4 * 60, resolutionMinutes: 48 * 60 },
  LOW: { name: 'Low', firstResponseMinutes: 8 * 60, resolutionMinutes: 72 * 60 },
};
export const PRIORITIES: Priority[] = ['URGENT', 'HIGH', 'NORMAL', 'LOW'];
export const DEFAULT_REOPEN_WINDOW_DAYS = 7;

/** Targets count from the moment the ticket was opened, in calendar time. */
export function dueTimes(openedAt: Date, targets: SlaTargets | null | undefined): { firstResponseDueAt: Date | null; resolutionDueAt: Date | null } {
  if (!targets) return { firstResponseDueAt: null, resolutionDueAt: null };
  return {
    firstResponseDueAt: new Date(openedAt.getTime() + targets.firstResponseMinutes * 60_000),
    resolutionDueAt: new Date(openedAt.getTime() + targets.resolutionMinutes * 60_000),
  };
}

export interface SlaFacts {
  status: TicketStatus;
  firstResponseDueAt: Date | null;
  resolutionDueAt: Date | null;
  firstRespondedAt: Date | null;
  resolvedAt: Date | null;
}
/**
 * A target is breached when the thing happened too late, or has not happened
 * and the due time has passed. A ticket that was resolved without a reply
 * counts the resolution as the response.
 */
export function breachState(t: SlaFacts, now: Date): { firstResponseBreached: boolean; resolutionBreached: boolean } {
  const responded = t.firstRespondedAt ?? t.resolvedAt ?? (t.status === 'CLOSED' ? now : null);
  const firstResponseBreached = !!t.firstResponseDueAt && (responded ? responded.getTime() > t.firstResponseDueAt.getTime() : now.getTime() > t.firstResponseDueAt.getTime());
  const finished = t.resolvedAt ?? (t.status === 'CLOSED' ? now : null);
  const resolutionBreached = !!t.resolutionDueAt && (finished ? finished.getTime() > t.resolutionDueAt.getTime() : now.getTime() > t.resolutionDueAt.getTime());
  return { firstResponseBreached, resolutionBreached };
}

/** Status changes staff may make by hand. */
export const TICKET_TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  OPEN: ['IN_PROGRESS', 'WAITING_CUSTOMER', 'RESOLVED', 'CLOSED'],
  IN_PROGRESS: ['WAITING_CUSTOMER', 'RESOLVED', 'CLOSED'],
  WAITING_CUSTOMER: ['IN_PROGRESS', 'RESOLVED', 'CLOSED'],
  // Staff can take a resolved ticket up again; a closed ticket is final.
  RESOLVED: ['IN_PROGRESS', 'CLOSED'],
  CLOSED: [],
};
export const isOpen = (status: string) => status === 'OPEN' || status === 'IN_PROGRESS' || status === 'WAITING_CUSTOMER';

/**
 * What a customer reply does to the ticket status:
 *  - waiting for the customer -> back to the team;
 *  - resolved and still inside the reopen window -> reopened;
 *  - resolved long ago, or closed -> not possible (a new ticket is needed).
 */
export function afterCustomerReply(status: TicketStatus, resolvedAt: Date | null, reopenWindowDays: number, now: Date): { status: TicketStatus; reopened: boolean } | 'CLOSED' {
  if (status === 'CLOSED') return 'CLOSED';
  if (status === 'RESOLVED') {
    const within = !!resolvedAt && now.getTime() <= resolvedAt.getTime() + reopenWindowDays * 86_400_000;
    return within ? { status: 'IN_PROGRESS', reopened: true } : 'CLOSED';
  }
  if (status === 'WAITING_CUSTOMER') return { status: 'IN_PROGRESS', reopened: false };
  return { status, reopened: false };
}

export function parseSupportSettings(raw: unknown): { reopenWindowDays: number } {
  const v = Number((raw as any)?.support?.reopenWindowDays);
  return { reopenWindowDays: Number.isInteger(v) && v >= 0 && v <= 90 ? v : DEFAULT_REOPEN_WINDOW_DAYS };
}
