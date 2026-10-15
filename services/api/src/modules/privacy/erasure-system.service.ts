import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../../common/audit.service';
import { SystemDb, Tx } from '../../common/db/prisma.service';
import { ERASED_TEXT, ErasureSubject, identifierPattern, scrubJson, scrubText } from '../../common/erasure';

export const ERASED_USER_NAME = 'Erased user';
/** Keys that are personal on a record whose resource IS the customer (a contact value, a tag or note text ...). */
const CUSTOMER_RECORD_KEYS = ['value', 'label', 'name', 'note', 'details', 'body'];
const PERSON_ACTORS = ['CUSTOMER', 'CORPORATE'];
const UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** SQL: does this text name one of the ids in the array parameter? One pass over the text, however many ids there are. */
const MENTIONS = (textExpr: string, arrayParam: string) => `EXISTS (SELECT 1 FROM regexp_matches(${textExpr}, '${UUID_RE}', 'g') AS m WHERE m[1] = ANY(${arrayParam}::text[]))`;

export interface LoginOutlook {
  /** Accounts that exist only for this person at this centre: they are anonymised and disabled. */
  anonymise: string[];
  /** Accounts that are also used elsewhere (another centre, a staff or platform role): they are kept. */
  keep: string[];
}

/**
 * The two parts of an erasure that cannot run on the tenant-scoped connection:
 *
 *  1. Trails. The audit trail, security events, the request status history, the consent history and
 *     the document access log are append-only: the database refuses UPDATE for the tenant role. They
 *     are kept - who did what and when stays on record - but the personal values of the erased person
 *     are taken out of them. That needs the controlled purge switch (`typease.allow_purge`), which
 *     only works on the system connection.
 *  2. The login. `users` is a platform-wide table: one person, possibly several centres. Only the
 *     system connection may change it, and only it can see whether the account is used elsewhere.
 *
 * Every statement here is filtered by the tenant of the erasure (or by the ids of the person's own
 * accounts); nothing of another centre is read or changed.
 */
@Injectable()
export class ErasureSystemService {
  private readonly logger = new Logger(ErasureSystemService.name);

  constructor(
    private readonly sys: SystemDb,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------------ 1. trails
  /**
   * Removes the person's values from the trails of one centre. An entry is only touched when it is about
   * something that belongs to the person (`subject.resourceIds`: their records, requests, documents,
   * invoices ...), mentions one of the person's ids, or was made by the person - never because a name or a
   * phone number happens to match, so the trail of another customer cannot be damaged.
   * Idempotent: a second run finds nothing left to replace.
   */
  async redactTrails(subject: ErasureSubject): Promise<Record<string, number>> {
    const tenantId = subject.tenantId;
    const pattern = identifierPattern(subject.identifiers);
    // Everything that belongs to the person; an entry that names one of these ids is ABOUT the person.
    const linked = [...new Set([...subject.resourceIds, ...subject.customerIds])];
    const users = subject.userIds;
    const emails = [...new Set(subject.identifiers.emails.map((e) => e.toLowerCase()))];
    const counts: Record<string, number> = { auditEntries: 0, securityEvents: 0, signInHistory: 0, statusHistory: 0, consentHistory: 0, documentAccessLog: 0, events: 0, storedResponses: 0, automationRuns: 0, integrationLog: 0 };
    const json = (value: unknown) => (value === null || value === undefined ? null : JSON.stringify(value));
    const changed = (a: unknown, b: unknown) => JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);

    await this.sys.tx(
      async (tx) => {
        // Lets this transaction (and only this one) update append-only tables.
        await tx.$executeRawUnsafe(`SET LOCAL typease.allow_purge = 'on'`);

        // ---- audit trail
        const audits = await tx.$queryRawUnsafe<Array<{ id: string; summary: string | null; before: unknown; after: unknown; actorUserId: string | null; actorType: string; actorLabel: string | null; resourceType: string; resourceId: string | null; ip: string | null; userAgent: string | null; about: boolean }>>(
          `SELECT a."id"::text AS id, a."summary", a."before", a."after", a."actorUserId"::text AS "actorUserId", a."actorType"::text AS "actorType", a."actorLabel", a."resourceType", a."resourceId", a."ip", a."userAgent", f.about
           FROM "audit_logs" a
           CROSS JOIN LATERAL (SELECT coalesce(a."summary", '') || ' ' || coalesce(a."before"::text, '') || ' ' || coalesce(a."after"::text, '') AS body) t
           CROSS JOIN LATERAL (SELECT (a."resourceId" = ANY($2::text[]) OR ${MENTIONS('t.body', '$2')}) AS about) f
           WHERE a."tenantId" = $1::uuid AND (f.about OR a."actorUserId"::text = ANY($3::text[]) OR ${MENTIONS('t.body', '$3')})`,
          tenantId,
          linked,
          users,
        );
        for (const row of audits) {
          const byPerson = !!row.actorUserId && users.includes(row.actorUserId) && PERSON_ACTORS.includes(row.actorType);
          // An entry that is merely MADE by (or mentions) the same account - it may also be a staff login - keeps its
          // content: only the person's own identifiers are removed. Entries ABOUT the person lose every personal field.
          const extra = row.resourceType === 'Customer' && !!row.resourceId && subject.customerIds.includes(row.resourceId) ? CUSTOMER_RECORD_KEYS : [];
          const before = row.about ? scrubJson(row.before, pattern, extra) : scrubValues(row.before, pattern);
          const after = row.about ? scrubJson(row.after, pattern, extra) : scrubValues(row.after, pattern);
          const summary = scrubText(row.summary, pattern);
          const actorLabel = byPerson ? ERASED_TEXT : row.actorLabel;
          const ip = byPerson ? null : row.ip;
          const userAgent = byPerson ? null : row.userAgent;
          if (!changed(before, row.before) && !changed(after, row.after) && summary === row.summary && actorLabel === row.actorLabel && ip === row.ip && userAgent === row.userAgent) continue;
          await tx.$executeRaw`
            UPDATE "audit_logs" SET "summary" = ${summary}, "before" = ${json(before)}::jsonb, "after" = ${json(after)}::jsonb, "actorLabel" = ${actorLabel}, "ip" = ${ip}, "userAgent" = ${userAgent}
            WHERE "id" = ${row.id}::uuid AND "tenantId" = ${tenantId}::uuid`;
          counts.auditEntries += 1;
        }

        // ---- security events of the centre: by the person's accounts, about their records, or about a sign-in with their address
        const security = await tx.$queryRawUnsafe<Array<{ id: string; details: unknown; userId: string | null; ip: string | null; own: boolean }>>(
          `SELECT s."id"::text AS id, s."details", s."userId"::text AS "userId", s."ip",
                  (s."userId"::text = ANY($3::text[]) OR lower(coalesce(s."details"->>'email', '')) = ANY($4::text[])) AS own
           FROM "security_events" s
           WHERE s."tenantId" = $1::uuid
             AND (s."userId"::text = ANY($3::text[]) OR lower(coalesce(s."details"->>'email', '')) = ANY($4::text[]) OR ${MENTIONS(`s."details"::text`, '$2')} OR ${MENTIONS(`s."details"::text`, '$3')})`,
          tenantId,
          linked,
          users,
          emails,
        );
        for (const row of security) {
          const details = scrubJson(row.details, pattern);
          if (!changed(details, row.details) && !(row.own && row.ip)) continue;
          await tx.$executeRaw`UPDATE "security_events" SET "details" = ${json(details)}::jsonb, "ip" = ${row.own ? null : row.ip} WHERE "id" = ${row.id}::uuid AND "tenantId" = ${tenantId}::uuid`;
          counts.securityEvents += 1;
        }

        // ---- sign-in history of this centre for the person's accounts and addresses
        counts.signInHistory = await tx.$executeRaw`
          UPDATE "login_activity" SET "email" = NULL, "ip" = NULL, "userAgent" = NULL
          WHERE "tenantId" = ${tenantId}::uuid AND ("userId"::text = ANY(${users}::text[]) OR lower(coalesce("email", '')) = ANY(${emails}::text[]))
            AND ("email" IS NOT NULL OR "ip" IS NOT NULL OR "userAgent" IS NOT NULL)`;

        // ---- status history of the person's requests: reasons and messages are free text about the person
        if (subject.requestIds.length) {
          counts.statusHistory = await tx.$executeRaw`
            UPDATE "request_status_history"
            SET "reason" = CASE WHEN "reason" IS NULL THEN NULL ELSE ${ERASED_TEXT} END,
                "customerMessage" = CASE WHEN "customerMessage" IS NULL THEN NULL ELSE ${ERASED_TEXT} END
            WHERE "tenantId" = ${tenantId}::uuid AND "requestId"::text = ANY(${subject.requestIds}::text[])
              AND (("reason" IS NOT NULL AND "reason" <> ${ERASED_TEXT}) OR ("customerMessage" IS NOT NULL AND "customerMessage" <> ${ERASED_TEXT}))`;
        }

        // ---- network addresses recorded with the person's own actions
        counts.consentHistory = await tx.$executeRaw`
          UPDATE "consent_records" SET "ip" = NULL WHERE "tenantId" = ${tenantId}::uuid AND "customerId"::text = ANY(${subject.customerIds}::text[]) AND "ip" IS NOT NULL`;
        if (users.length) {
          counts.documentAccessLog = await tx.$executeRaw`
            UPDATE "document_access_logs" SET "ip" = NULL, "userAgent" = NULL
            WHERE "tenantId" = ${tenantId}::uuid AND "actorId"::text = ANY(${users}::text[]) AND "actorType"::text = ANY(${PERSON_ACTORS}::text[]) AND ("ip" IS NOT NULL OR "userAgent" IS NOT NULL)`;
        }

        // ---- JSON logs that are not append-only but belong to no single module's erasure step
        counts.events = await this.scrubJsonColumn(tx, 'outbox_events', ['payload'], tenantId, linked, pattern);
        counts.storedResponses = await this.scrubJsonColumn(tx, 'idempotency_keys', ['responseBody'], tenantId, linked, pattern);
        counts.automationRuns = await this.scrubJsonColumn(tx, 'automation_executions', ['actionResults'], tenantId, linked, pattern);
        counts.integrationLog = await this.scrubJsonColumn(tx, 'integration_logs', ['request', 'response'], tenantId, linked, pattern);
      },
      { timeoutMs: 120_000 },
    );
    return counts;
  }

  /** Rows of one tenant table whose JSON columns name something that belongs to the person: personal fields and identifiers are replaced. */
  private async scrubJsonColumn(tx: Tx, table: string, columns: string[], tenantId: string, linked: string[], pattern: RegExp | null): Promise<number> {
    if (!linked.length) return 0;
    if (!/^[a-z_]+$/.test(table) || columns.some((c) => !/^[A-Za-z]+$/.test(c))) throw new Error('scrubJsonColumn: invalid identifier.');
    const text = columns.map((c) => `coalesce(x."${c}"::text, '')`).join(` || ' ' || `);
    const rows = await tx.$queryRawUnsafe<Array<Record<string, unknown> & { id: string }>>(
      `SELECT x."id"::text AS id, ${columns.map((c) => `x."${c}"`).join(', ')} FROM "${table}" x WHERE x."tenantId" = $1::uuid AND ${MENTIONS(`(${text})`, '$2')}`,
      tenantId,
      linked,
    );
    let updated = 0;
    for (const row of rows) {
      const next = columns.map((c) => scrubJson(row[c], pattern));
      if (columns.every((c, i) => JSON.stringify(next[i] ?? null) === JSON.stringify(row[c] ?? null))) continue;
      const sets = columns.map((c, i) => `"${c}" = $${i + 3}::jsonb`).join(', ');
      await tx.$executeRawUnsafe(`UPDATE "${table}" SET ${sets} WHERE "id" = $1::uuid AND "tenantId" = $2::uuid`, row.id, tenantId, ...next.map((v) => (v === null || v === undefined ? null : JSON.stringify(v))));
      updated += 1;
    }
    return updated;
  }

  // ------------------------------------------------------------------ 2. logins
  /**
   * Which of the person's accounts would be left without any use once their membership of this centre is gone.
   * `ignoreMembershipIds`: the memberships the erasure is about to remove.
   */
  async loginOutlook(userIds: string[], ignoreMembershipIds: string[]): Promise<LoginOutlook> {
    const out: LoginOutlook = { anonymise: [], keep: [] };
    for (const userId of [...new Set(userIds)]) {
      const user = await this.sys.client.user.findUnique({ where: { id: userId }, select: { id: true, platformRole: true, deletedAt: true } });
      if (!user || user.deletedAt) continue;
      const elsewhere = await this.sys.client.tenantMembership.count({ where: { userId, status: { not: 'REMOVED' }, id: { notIn: ignoreMembershipIds } } });
      (user.platformRole || elsewhere > 0 ? out.keep : out.anonymise).push(userId);
    }
    return out;
  }

  /**
   * After the erasure committed. For every account of the person: the sessions and one-time tokens for this
   * centre end. An account that is not used anywhere else - no membership of another centre, no staff or
   * corporate role, no platform role - is anonymised and disabled: nothing is left to sign in with and nothing
   * says whose it was. An account that is used elsewhere is left alone. Idempotent.
   */
  async closeLogins(tenantId: string, userIds: string[], privacyRequestId: string): Promise<{ anonymised: number; kept: number }> {
    let anonymised = 0;
    let kept = 0;
    const outlook = await this.loginOutlook(userIds, []);
    for (const userId of [...outlook.keep, ...outlook.anonymise]) {
      const user = await this.sys.client.user.findUnique({ where: { id: userId }, select: { id: true, email: true, phone: true } });
      if (!user) continue;
      await this.sys.client.session.deleteMany({ where: { userId, tenantId } });
      await this.sys.client.authToken.deleteMany({ where: { tenantId, OR: [{ userId }, { target: user.email }] } });
      if (outlook.keep.includes(userId)) {
        kept += 1;
        continue;
      }
      await this.sys.tx(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL typease.allow_purge = 'on'`);
        await tx.user.update({
          where: { id: userId },
          data: {
            // The address column is unique and mandatory: a reserved, undeliverable address takes its place.
            email: `erased-${userId}@erased.invalid`, emailVerifiedAt: null, phone: null, phoneVerifiedAt: null, passwordHash: null, fullName: ERASED_USER_NAME, status: 'DISABLED',
            mfaEnabled: false, mfaSecretEnc: null, mfaRecoveryHashes: [], failedLoginCount: 0, lockedUntil: null, deletedAt: new Date(),
          },
        });
        await tx.session.deleteMany({ where: { userId } });
        await tx.authToken.deleteMany({ where: { OR: [{ userId }, { target: user.email }, ...(user.phone ? [{ target: user.phone }] : [])] } });
        await tx.loginActivity.updateMany({ where: { OR: [{ userId }, { email: user.email }] }, data: { email: null, ip: null, userAgent: null } });
        // Security events about the account (sign-in problems, at any centre: the account belonged to this one only):
        // what was recorded with them goes.
        await tx.$executeRaw`
          UPDATE "security_events" SET "ip" = NULL, "details" = '{}'::jsonb
          WHERE ("userId" = ${userId}::uuid AND "tenantId" IS NULL) OR lower(coalesce("details"->>'email', '')) = ${user.email.toLowerCase()}`;
      });
      anonymised += 1;
      await this.audit.logSystem({ action: 'privacy.login_anonymised', resourceType: 'User', resourceId: userId, summary: `Erasure request ${privacyRequestId}: the login was used for nothing else, so it was anonymised and disabled` }, tenantId);
    }
    if (kept) this.logger.log(`erasure ${privacyRequestId}: ${kept} login account(s) kept because they are used elsewhere`);
    return { anonymised, kept };
  }
}

/** Removes the person's identifiers from the strings of a JSON value without touching anything else. */
function scrubValues(value: unknown, pattern: RegExp | null, depth = 0): unknown {
  if (value === null || value === undefined || depth > 12) return value ?? null;
  if (typeof value === 'string') return scrubText(value, pattern);
  if (Array.isArray(value)) return value.map((v) => scrubValues(v, pattern, depth + 1));
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, scrubValues(v, pattern, depth + 1)]));
  return value;
}

