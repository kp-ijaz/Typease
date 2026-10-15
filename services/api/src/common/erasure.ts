import { Injectable, Logger } from '@nestjs/common';
import { Tx } from './db/prisma.service';

/**
 * Erasure of one person's data inside one centre (a data subject request of
 * type DELETION carried out by the privacy module).
 *
 * The privacy module decides IF and WHEN; every module decides WHAT happens to
 * its own tables by registering a step here in onModuleInit - the same way
 * tenant defaults are registered with the provisioning service. Steps run in
 * the privacy module's tenant transaction, in the order of registration, and
 * must be idempotent (an erasure can be repeated without harm).
 */
export interface ErasureSubject {
  tenantId: string;
  privacyRequestId: string;
  /** The customer record the request is about. */
  customerId: string;
  /** That record plus every record that was merged into it: all of them are the same person. */
  customerIds: string[];
  /** Global user ids of the portal logins linked to the person in this centre. */
  userIds: string[];
  /** Service requests of the person (any status). */
  requestIds: string[];
  /**
   * Ids of everything that belongs to the person: their records, requests, documents, quotations, invoices,
   * payments, refunds, credit notes, appointments, tickets, reminders, tasks ... Use it to recognise rows that
   * are ABOUT the person although they are not addressed to them (a staff notification, a log entry).
   */
  resourceIds: string[];
  /**
   * What the person was known by before the erasure. For scrubbing copies that
   * sit in free text or JSON. Never write these to a log or an audit entry.
   */
  identifiers: ErasureIdentifiers;
}
export interface ErasureIdentifiers {
  names: string[];
  emails: string[];
  phones: string[];
  identityNumbers: string[];
}
/** What a step did: row counts by a short label, shown on the audit entry of the erasure. Numbers only. */
export type ErasureReport = Record<string, number>;
export type ErasureStep = (tx: Tx, subject: ErasureSubject) => Promise<ErasureReport>;

export const ERASED_TEXT = '[erased]';

@Injectable()
export class ErasureRegistry {
  private readonly logger = new Logger(ErasureRegistry.name);
  private readonly steps: Array<{ name: string; run: ErasureStep }> = [];

  /** Called by the owning module in onModuleInit. `name` is the module name (shown in the audit entry). */
  register(name: string, run: ErasureStep): void {
    if (this.steps.some((s) => s.name === name)) throw new Error(`Erasure step "${name}" is already registered.`);
    this.steps.push({ name, run });
  }
  names(): string[] {
    return this.steps.map((s) => s.name);
  }

  /**
   * Runs every step. A failing step fails the whole erasure (the caller's
   * transaction rolls back): a half-erased person is worse than a retry.
   */
  async run(tx: Tx, subject: ErasureSubject): Promise<Record<string, ErasureReport>> {
    const report: Record<string, ErasureReport> = {};
    for (const step of this.steps) {
      try {
        report[step.name] = await step.run(tx, subject);
      } catch (e: any) {
        this.logger.error(`erasure step "${step.name}" failed for privacy request ${subject.privacyRequestId}: ${e?.message ?? e}`);
        throw e;
      }
    }
    return report;
  }
}

// ---------------------------------------------------------------------------------------------
// Scrubbing copies of personal values in text and JSON (pure functions)
// ---------------------------------------------------------------------------------------------

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Spellings under which a value may have been written down. */
function variants(kind: keyof ErasureIdentifiers, raw: string): string[] {
  const value = raw.trim();
  if (!value) return [];
  switch (kind) {
    case 'names': {
      // Very short names would hit unrelated words; a full name of 4+ characters is a safe match.
      const collapsed = value.replace(/\s+/g, ' ');
      return collapsed.length >= 4 ? [...new Set([value, collapsed])] : [];
    }
    case 'emails':
      return value.length >= 5 ? [value] : [];
    case 'phones': {
      const digits = value.replace(/[^\d]/g, '');
      if (digits.length < 7) return [];
      return [...new Set([value, digits, `+${digits}`, `00${digits}`])];
    }
    case 'identityNumbers': {
      const compact = value.replace(/[\s-]/g, '');
      if (compact.length < 5) return [];
      const out = new Set([value, compact]);
      // Emirates ID as printed on the card: 784-YYYY-NNNNNNN-C
      if (/^784\d{12}$/.test(compact)) out.add(`${compact.slice(0, 3)}-${compact.slice(3, 7)}-${compact.slice(7, 14)}-${compact.slice(14)}`);
      return [...out];
    }
  }
}

/** One case-insensitive pattern for everything the person was known by, or null when there is nothing to look for. */
export function identifierPattern(identifiers: ErasureIdentifiers): RegExp | null {
  const all: string[] = [];
  for (const kind of ['names', 'emails', 'phones', 'identityNumbers'] as const) for (const value of identifiers[kind] ?? []) all.push(...variants(kind, value));
  const unique = [...new Set(all)].sort((a, b) => b.length - a.length);
  if (!unique.length) return null;
  // A name or number between whitespace may be written with different spacing: allow any run of whitespace.
  return new RegExp(unique.map((v) => escapeRegex(v).replace(/\s+/g, '\\s+')).join('|'), 'giu');
}

/** Replaces every occurrence of the person's identifiers in a text. */
export function scrubText<T extends string | null | undefined>(text: T, pattern: RegExp | null): T {
  if (!text || !pattern) return text;
  pattern.lastIndex = 0;
  return text.replace(pattern, ERASED_TEXT) as T;
}

/** Keys whose values are personal data wherever they appear in a record about the person. Compared in lower case. */
const PERSONAL_KEYS = new Set(
  [
    'fullName', 'fullNameAr', 'email', 'phone', 'nationality', 'dateOfBirth', 'address', 'emiratesId', 'emiratesIdLast4', 'emiratesIdMasked', 'emiratesIdExpiry',
    'passportNo', 'passportNoLast4', 'passportNoMasked', 'passportCountry', 'passportExpiry', 'guestName', 'guestPhone', 'customerName', 'sourceName', 'targetName',
    'recipient', 'recipientAddress', 'recipientName', 'subjectLabel', 'employeeNo', 'designation', 'contactValue',
  ].map((k) => k.toLowerCase()),
);

/**
 * Deep copy of a JSON value from a record that is ABOUT the person: values under personal keys are replaced, and
 * the person's identifiers are removed from every other string. Ids, numbers, dates and statuses are kept, so the
 * record still says what happened and to which (now anonymous) record.
 * `extraKeys`: additional keys that are personal in this kind of record (e.g. `value` on a customer's contact entry).
 */
export function scrubJson(value: unknown, pattern: RegExp | null, extraKeys: string[] = [], depth = 0): unknown {
  if (value === null || value === undefined || depth > 12) return value ?? null;
  if (typeof value === 'string') return scrubText(value, pattern);
  if (Array.isArray(value)) return value.map((v) => scrubJson(v, pattern, extraKeys, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      const personal = PERSONAL_KEYS.has(key.toLowerCase()) || extraKeys.includes(key);
      out[key] = personal && v !== null && v !== undefined && v !== '' ? ERASED_TEXT : scrubJson(v, pattern, extraKeys, depth + 1);
    }
    return out;
  }
  return value;
}
