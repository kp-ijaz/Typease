import { Injectable, Logger } from '@nestjs/common';
import type { ActorType } from '@typease/database';
import { tryCtx } from './context';
import { SystemDb, TenantDb, Tx } from './db/prisma.service';

export interface AuditEntry {
  action: string;
  resourceType: string;
  resourceId?: string | null;
  summary?: string;
  before?: unknown;
  after?: unknown;
}

const REDACT = /password|secret|token|hash|enc$|otp|recovery/i;
/** Deep-copies a value for the audit trail, dropping credentials and encrypted blobs. */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined || depth > 6) return value ?? null;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    if (typeof (value as any).toFixed === 'function' && typeof (value as any).toString === 'function' && 'd' in (value as any))
      return (value as any).toString();
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Append-only audit trail. Tenant events are written inside the caller's
 * transaction so the audit record exists if and only if the change committed.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  constructor(
    private readonly db: TenantDb,
    private readonly sys: SystemDb,
  ) {}

  private row(entry: AuditEntry, tenantId: string | null) {
    const c = tryCtx();
    return {
      tenantId,
      actorUserId: c?.userId ?? null,
      actorType: (c?.actorType ?? 'SYSTEM') as ActorType,
      actorLabel: c?.actorLabel ?? null,
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId ?? null,
      summary: entry.summary ?? null,
      before: entry.before === undefined ? undefined : (redact(entry.before) as any),
      after: entry.after === undefined ? undefined : (redact(entry.after) as any),
      supportGrantId: c?.supportGrantId ?? null,
      requestId: c?.requestId ?? null,
      ip: c?.ip ?? null,
      userAgent: c?.userAgent?.slice(0, 300) ?? null,
    };
  }

  /** Tenant-scoped audit entry (joins the current transaction). */
  async log(entry: AuditEntry, tx?: Tx): Promise<void> {
    const write = (t: Tx) => t.auditLog.create({ data: this.row(entry, this.db.tenantId) });
    if (tx) await write(tx);
    else await this.db.tx(write);
  }

  /**
   * Platform-level or explicitly targeted audit entry (system connection).
   * `strict`: the caller must not go on without the record (the error is thrown instead of logged).
   */
  async logSystem(entry: AuditEntry, tenantId: string | null = null, opts: { strict?: boolean } = {}): Promise<void> {
    try {
      await this.sys.client.auditLog.create({ data: this.row(entry, tenantId) });
    } catch (e: any) {
      this.logger.error(`audit write failed: ${e?.message}`);
      if (opts.strict) throw e;
    }
  }

  async security(type: string, severity: 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL', details: Record<string, unknown> = {}, tenantId?: string | null) {
    const c = tryCtx();
    try {
      await this.sys.client.securityEvent.create({
        data: {
          type,
          severity,
          details: redact({ ...details, requestId: c?.requestId }) as any,
          tenantId: tenantId === undefined ? (c?.tenantId ?? null) : tenantId,
          // Events about a sign-in that failed or a session that ended have no signed-in caller: the person they are
          // about is named in the details (`userId`), and that is who the event is filed under.
          userId: c?.userId ?? (typeof details.userId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(details.userId) ? details.userId : null),
          ip: c?.ip ?? null,
        },
      });
    } catch (e: any) {
      this.logger.error(`security event write failed: ${e?.message}`);
    }
  }
}
