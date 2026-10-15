import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Prisma, PrismaClient, PrismaPg } from '@typease/database';
import { env } from '../../config/env';
import { ctx, tryCtx } from '../context';

/** Transaction client handed to service code. */
export type Tx = Prisma.TransactionClient;

interface TxScope {
  tx: Tx;
  tenantId: string | null;
  afterCommit: Array<() => void | Promise<void>>;
}
const txStorage = new AsyncLocalStorage<TxScope>();

/** Credentials never leave the database through the tenant-scoped client. */
const USER_SECRET_OMIT = {
  passwordHash: true,
  mfaSecretEnc: true,
  mfaRecoveryHashes: true,
  failedLoginCount: true,
  lockedUntil: true,
  passwordChangedAt: true,
} as const;

function build(url: string, omit: boolean) {
  // The driver sends timestamps as UTC wall-clock text. Pin the session time zone
  // to UTC so that values written by the application and the database's own
  // now() / CURRENT_TIMESTAMP always agree, whatever the server default is.
  const adapter = new PrismaPg({ connectionString: url, max: env().DATABASE_POOL_MAX, options: '-c timezone=UTC' });
  return new PrismaClient({ adapter, ...(omit ? { omit: { user: USER_SECRET_OMIT } } : {}) }) as PrismaClient;
}

/**
 * Tenant-scoped database access.
 *
 * Connects as the `typease_app` role, which is subject to row-level security.
 * Every unit of work runs in a transaction whose first statement binds the
 * tenant (and user) from the verified request context:
 *
 *     await this.db.tx((tx) => tx.customer.findMany({ where: { tenantId } }))
 *
 * Nested `tx()` calls join the surrounding transaction, so a status change,
 * its audit entry and its outbox event commit or roll back together.
 */
@Injectable()
export class TenantDb implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TenantDb.name);
  readonly client = build(env().DATABASE_URL, true);

  async onModuleInit() {
    const rows = await this.client.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean; current_user: string }>>`
      SELECT rolsuper, rolbypassrls, current_user::text FROM pg_roles WHERE rolname = current_user`;
    const role = rows[0];
    if (!role || role.rolsuper || role.rolbypassrls) {
      const msg = `DATABASE_URL connects as "${role?.current_user}", which bypasses row-level security. Tenant isolation is NOT enforced.`;
      if (env().NODE_ENV === 'production') throw new Error(msg);
      this.logger.error(msg);
    }
  }
  async onModuleDestroy() {
    await this.client.$disconnect();
  }

  get tenantId(): string {
    const id = txStorage.getStore()?.tenantId ?? ctx().tenantId;
    if (!id) throw new Error('TenantDb used without a tenant in the request context.');
    return id;
  }

  async tx<T>(fn: (tx: Tx) => Promise<T>, options: { timeoutMs?: number } = {}): Promise<T> {
    const c = ctx();
    if (!c.tenantId) throw new Error('TenantDb used without a tenant in the request context.');
    const outer = txStorage.getStore();
    if (outer) {
      if (outer.tenantId !== c.tenantId) throw new Error('Nested transaction for a different tenant.');
      return fn(outer.tx);
    }
    const scope: TxScope = { tx: undefined as any, tenantId: c.tenantId, afterCommit: [] };
    const result = await this.client.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${c.tenantId}, true), set_config('app.user_id', ${c.userId ?? ''}, true)`;
        scope.tx = tx;
        return txStorage.run(scope, () => fn(tx));
      },
      { timeout: options.timeoutMs ?? 20_000, maxWait: 10_000 },
    );
    await runHooks(scope, this.logger);
    return result;
  }

  /** Run after the surrounding transaction commits (immediately if there is none). */
  afterCommit(fn: () => void | Promise<void>): void {
    const scope = txStorage.getStore();
    if (scope) scope.afterCommit.push(fn);
    else void Promise.resolve().then(fn).catch((e) => this.logger.error(e));
  }
}

async function runHooks(scope: TxScope, logger: Logger) {
  for (const hook of scope.afterCommit) {
    try {
      await hook();
    } catch (e: any) {
      logger.error(`after-commit hook failed: ${e?.stack ?? e}`);
    }
  }
}

/**
 * System database access (role `typease_system`, not restricted by RLS).
 *
 * Only for code that is cross-tenant by nature: authentication, tenant
 * resolution and provisioning, SaaS billing, platform administration, webhook
 * intake and schedulers. The allow-list of files permitted to inject this
 * class is enforced by test/architecture.spec.ts.
 */
@Injectable()
export class SystemDb implements OnModuleDestroy {
  private readonly logger = new Logger(SystemDb.name);
  readonly client = build(env().DATABASE_SYSTEM_URL, false);

  async onModuleDestroy() {
    await this.client.$disconnect();
  }

  async tx<T>(fn: (tx: Tx) => Promise<T>, options: { timeoutMs?: number } = {}): Promise<T> {
    const outer = txStorage.getStore();
    if (outer && outer.tenantId === null) return fn(outer.tx);
    const scope: TxScope = { tx: undefined as any, tenantId: null, afterCommit: [] };
    const result = await this.client.$transaction(
      async (tx) => {
        scope.tx = tx;
        return txStorage.run(scope, () => fn(tx));
      },
      { timeout: options.timeoutMs ?? 30_000, maxWait: 10_000 },
    );
    await runHooks(scope, this.logger);
    return result;
  }
  afterCommit(fn: () => void | Promise<void>): void {
    const scope = txStorage.getStore();
    if (scope) scope.afterCommit.push(fn);
    else void Promise.resolve().then(fn).catch((e) => this.logger.error(e));
  }
}

export { Prisma };
export const currentTxTenant = () => txStorage.getStore()?.tenantId ?? tryCtx()?.tenantId;
