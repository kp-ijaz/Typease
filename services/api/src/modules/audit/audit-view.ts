import type { AuditLogQuery } from '@typease/validation';
import type { Prisma } from '../../common/db/prisma.service';

/** Pure helpers shared by the tenant audit viewer and the platform audit viewer. */

/** "2026-06-01" means the whole day in UTC; a full timestamp is taken as it is. */
export function rangeBound(value: string | undefined, end: boolean): Date | undefined {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date(`${value}T${end ? '23:59:59.999' : '00:00:00.000'}Z`);
  return new Date(value);
}

type Filters = Pick<AuditLogQuery, 'action' | 'resourceType' | 'resourceId' | 'actorUserId' | 'actorType' | 'from' | 'to' | 'q'> & Partial<Pick<AuditLogQuery, 'supportAccess' | 'supportGrantId'>>;

/** Prisma filter for audit rows. The caller adds the tenant restriction. */
export function auditWhere(query: Filters): Prisma.AuditLogWhereInput {
  const from = rangeBound(query.from, false);
  const to = rangeBound(query.to, true);
  // One grant = everything done under it (rows that carry its id: the request, the entry, every call and action
  // of TypEase support) AND what the centre itself did about it (approved / denied / revoked / expired: those rows
  // are the centre's own acts, so they do not count as "support access", but they are about this grant).
  const grant: Prisma.AuditLogWhereInput | null = query.supportGrantId ? { OR: [{ supportGrantId: query.supportGrantId }, { resourceType: 'AccessGrant', resourceId: query.supportGrantId }] } : null;
  const search: Prisma.AuditLogWhereInput | null = query.q ? { OR: [{ summary: { contains: query.q, mode: 'insensitive' } }, { actorLabel: { contains: query.q, mode: 'insensitive' } }, { action: { contains: query.q, mode: 'insensitive' } }] } : null;
  return {
    ...(query.action ? { action: { startsWith: query.action } } : {}),
    ...(query.resourceType ? { resourceType: query.resourceType } : {}),
    ...(query.resourceId ? { resourceId: query.resourceId } : {}),
    ...(query.actorUserId ? { actorUserId: query.actorUserId } : {}),
    ...(query.actorType ? { actorType: query.actorType } : {}),
    ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
    ...(grant ? {} : query.supportAccess === true ? { supportGrantId: { not: null } } : query.supportAccess === false ? { supportGrantId: null } : {}),
    ...(grant && search ? { AND: [grant, search] } : (grant ?? search ?? {})),
  };
}

export const AUDIT_LIST_SELECT = {
  id: true, createdAt: true, action: true, resourceType: true, resourceId: true, summary: true, actorType: true, actorLabel: true, actorUserId: true, supportGrantId: true, requestId: true, ip: true,
} as const;

export const CSV_COLUMNS = ['createdAt', 'action', 'resourceType', 'resourceId', 'summary', 'actorType', 'actorLabel', 'actorUserId', 'supportGrantId', 'ip', 'requestId', 'id'] as const;

/**
 * One CSV cell (RFC 4180). A value that a spreadsheet would run as a formula
 * (= + - @, tab, carriage return) is prefixed with an apostrophe.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: Array<Record<string, unknown>>, columns: readonly string[] = CSV_COLUMNS): string {
  const lines = [columns.join(',')];
  for (const row of rows) lines.push(columns.map((c) => csvCell(row[c])).join(','));
  // UTF-8 byte-order mark so spreadsheets read Arabic names correctly.
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
