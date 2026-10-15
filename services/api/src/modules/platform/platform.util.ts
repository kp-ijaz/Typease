import { AuditEntry, AuditService } from '../../common/audit.service';
import type { PlatformPeriodQuery } from '@typease/validation';

/**
 * A platform action that concerns one centre is recorded twice: on the
 * platform audit trail (tenantId NULL, what TypEase staff did) and on the
 * centre's own trail (so the owner can see what TypEase did to their centre).
 */
export async function auditForCentre(audit: AuditService, entry: AuditEntry, centre: { id: string; slug: string; name?: string }): Promise<void> {
  await audit.logSystem({ ...entry, summary: `${entry.summary ?? entry.action} [centre ${centre.slug}]` });
  await audit.logSystem(entry, centre.id);
}

export const devTokens = () => process.env.EXPOSE_DEV_TOKENS === 'true' && process.env.NODE_ENV !== 'production';

const DAY = 86_400_000;
export const dayStart = (isoDate: string) => new Date(`${isoDate}T00:00:00.000Z`);
/** Exclusive end: the first instant after the given day. */
export const dayEndExclusive = (isoDate: string) => new Date(dayStart(isoDate).getTime() + DAY);

/** Resolves ?from=&to= (inclusive dates, UTC) into [start, end). Default: the last `defaultDays` days up to now. */
export function resolvePeriod(query: PlatformPeriodQuery, defaultDays: number, now = new Date()): { start: Date; end: Date } {
  const end = query.to ? dayEndExclusive(query.to) : now;
  const start = query.from ? dayStart(query.from) : new Date(end.getTime() - defaultDays * DAY);
  return { start, end };
}
