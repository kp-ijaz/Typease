import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { env } from '../../config/env';
import { AuditService } from '../audit.service';
import { ctx } from '../context';
import { safeEqual, sha256 } from '../crypto';
import { Errors } from '../errors';
import { RedisService } from '../redis';
import { ACCESS_KEY, AccessRule } from './access';
import { Principal, PrincipalService } from './principal.service';
import { decideSupportAccess, SUPPORT_KEY, SupportRouteRule } from './support-session';
import { verifyAccessToken } from './tokens';

/**
 * The single authentication + authorisation gate for every HTTP route.
 * Order: declared access rule -> token -> session/membership (database) ->
 * tenant state -> MFA policy -> permissions.
 *
 * A support session (platform staff inside a centre under an approved access
 * grant) takes its own, narrower path: see `supportSession` below and
 * `support-session.ts`.
 */
/**
 * A refused call of a support session is written to the centre's audit trail once per grant, route and
 * reason within this window; repeats inside the window are counted and the count is reported on the next
 * entry for the same call. (A client that retries a forbidden request in a loop must not be able to bury
 * the centre's trail.) Allowed calls are never collapsed: each one is recorded.
 */
export const REFUSED_AUDIT_WINDOW_SECONDS = 600;
/** How long a count of unrecorded repeats waits for a next entry to be reported on. */
const REFUSED_COUNT_TTL_SECONDS = 7 * 86400;

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly principals: PrincipalService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const rule = this.reflector.getAllAndOverride<AccessRule>(ACCESS_KEY, [context.getHandler(), context.getClass()]);
    if (!rule) {
      // Fail closed: a route nobody classified must never be reachable.
      throw Errors.forbidden('ACCESS_NOT_DECLARED', 'This endpoint is not available.');
    }
    const req = context.switchToHttp().getRequest<Request>();
    const c = ctx();

    if (rule.type === 'internal') {
      const token = req.header('x-internal-token') ?? '';
      if (!token || !safeEqual(token, env().INTERNAL_API_TOKEN)) throw Errors.unauthorized();
      return true;
    }

    const header = req.header('authorization') ?? '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (rule.type === 'public') {
      // Optional authentication: enrich the context when a valid token is present.
      if (bearer) {
        const claims = verifyAccessToken(bearer);
        if (claims) {
          try {
            const p = await this.principals.resolve(claims);
            if (p.context.supportGrantId) {
              // A support session gets nothing on a public route that an anonymous caller would not get: only
              // its identity is known (so that signing out ends the right session), never its staff standing.
              Object.assign(c, { userId: p.context.userId, sessionId: p.context.sessionId, app: p.context.app });
            } else {
              Object.assign(c, p.context);
              (req as any).sessionInfo = p.session;
            }
          } catch {
            /* treat as anonymous */
          }
        }
      }
      return true;
    }

    if (!bearer) throw Errors.unauthorized();
    const claims = verifyAccessToken(bearer);
    if (!claims) throw Errors.unauthorized('TOKEN_INVALID', 'Your session has expired. Please sign in again.');
    const principal = await this.principals.resolve(claims);
    Object.assign(c, principal.context);
    (req as any).sessionInfo = principal.session;

    if (c.supportGrantId) return this.supportSession(rule, context, req, principal);

    if (rule.type === 'authenticated') {
      if (principal.mfaSetupRequired && !rule.allowWithoutMfa) throw mfaSetup();
      return true;
    }
    if (principal.mfaSetupRequired) throw mfaSetup();

    if (rule.type === 'platform') {
      if (!c.platformRole || c.tenantId) throw Errors.forbidden('PLATFORM_ONLY', 'This area is for TypEase platform staff.');
      if (!rule.any.some((p) => c.permissions.has(p))) throw await this.denied(rule.any);
      return true;
    }

    // rule.type === 'tenant'
    if (!c.tenantId) throw Errors.forbidden('TENANT_REQUIRED', 'Select a centre to continue.');
    if (!rule.allowSuspended && !PrincipalService.tenantUsable(principal.tenantStatus ?? '', c.actorType)) {
      throw Errors.forbidden('TENANT_UNAVAILABLE', 'This centre is currently not available. Please contact the centre or TypEase support.');
    }
    if (rule.kinds && !rule.kinds.includes(c.actorType as any)) throw await this.denied(rule.kinds);
    if (rule.any?.length && !rule.any.some((p) => c.permissions.has(p))) throw await this.denied(rule.any);
    if (rule.all?.length && !rule.all.every((p) => c.permissions.has(p))) throw await this.denied(rule.all);
    return true;
  }

  /**
   * Platform staff inside a centre. The grant was re-read from the database by the principal service (approved,
   * not revoked, not expired, same person); here the route is checked against the granted scopes. Every call
   * that reaches centre data is written to the centre's audit trail with the grant id - if that record cannot be
   * written the call does not happen. Refused calls are written too, once per route and reason in ten minutes
   * (`REFUSED_AUDIT_WINDOW_SECONDS`); repeats are counted and reported on the next entry.
   */
  private async supportSession(rule: AccessRule, context: ExecutionContext, req: Request, principal: Principal): Promise<boolean> {
    const c = ctx();
    const marker = this.reflector.getAllAndOverride<SupportRouteRule | undefined>(SUPPORT_KEY, [context.getHandler(), context.getClass()]);
    const decision = decideSupportAccess(rule, marker, req.method, c.permissions);
    const route = `${req.method} ${req.route?.path ? `${req.baseUrl}${req.route.path}` : req.originalUrl.split('?')[0]}`;
    const record = (outcome: 'ALLOWED' | 'REFUSED', reason?: string, repeats?: number) =>
      this.audit.logSystem(
        {
          action: 'support_access.api_call',
          resourceType: 'AccessGrant',
          resourceId: c.supportGrantId,
          summary:
            outcome === 'ALLOWED'
              ? `TypEase support called ${route}`
              : `TypEase support was refused ${route}${repeats ? ` (${repeats} more refusal${repeats === 1 ? '' : 's'} of this call since the previous entry ${repeats === 1 ? 'was' : 'were'} not recorded one by one)` : ''}`,
          after: {
            method: req.method,
            route: route.slice(req.method.length + 1),
            path: req.originalUrl.split('?')[0],
            outcome,
            ...(reason ? { reason } : {}),
            // Refusals only: one entry per grant, route and reason in ten minutes; what was not written is counted here.
            ...(outcome === 'REFUSED' ? { collapsed: { windowMinutes: REFUSED_AUDIT_WINDOW_SECONDS / 60, suppressedSincePreviousEntry: repeats ?? 0 } } : {}),
          },
        },
        c.tenantId ?? null,
        { strict: true },
      );
    if (!decision.allowed) {
      await this.audit.security('PERMISSION_DENIED', 'LOW', { required: decision.required, supportGrantId: c.supportGrantId, route, reason: decision.code });
      const window = await this.refusalWindow(`${c.supportGrantId}|${route}|${decision.code}`);
      if (window.write) {
        try {
          await record('REFUSED', decision.code, window.suppressed);
        } catch (e) {
          // The entry was not written: the window must not swallow the next attempt to write it.
          await window.reopen();
          throw e;
        }
      }
      throw Errors.forbidden(decision.code, decision.message);
    }
    if (rule.type === 'tenant' && !rule.allowSuspended && !PrincipalService.tenantUsable(principal.tenantStatus ?? '', 'PLATFORM')) {
      throw Errors.forbidden('TENANT_UNAVAILABLE', 'This centre is currently not available. Please contact the centre or TypEase support.');
    }
    if (decision.audited) await record('ALLOWED');
    return true;
  }

  /**
   * Is this the first refusal of this call (grant + route + reason) in the current window? The first one is
   * written to the audit trail, together with the number of repeats that were only counted since the
   * previous entry. Without Redis every refusal is written: too many entries are better than none.
   */
  private async refusalWindow(identity: string): Promise<{ write: boolean; suppressed: number; reopen: () => Promise<void> }> {
    const key = `support:refused:${sha256(identity).slice(0, 40)}`;
    const counter = `${key}:n`;
    const reopen = async () => void (await this.redis.client.del(key).catch(() => undefined));
    try {
      const first = await this.redis.client.set(key, '1', 'EX', REFUSED_AUDIT_WINDOW_SECONDS, 'NX');
      if (first !== 'OK') {
        await this.redis.client.multi().incr(counter).expire(counter, REFUSED_COUNT_TTL_SECONDS).exec();
        return { write: false, suppressed: 0, reopen };
      }
      const counted = await this.redis.client.multi().get(counter).del(counter).exec();
      return { write: true, suppressed: Number(counted?.[0]?.[1] ?? 0) || 0, reopen };
    } catch {
      return { write: true, suppressed: 0, reopen };
    }
  }

  private async denied(required: string[]) {
    await this.audit.security('PERMISSION_DENIED', 'LOW', { required });
    return Errors.forbidden();
  }
}

const mfaSetup = () =>
  Errors.forbidden('MFA_SETUP_REQUIRED', 'Your role requires two-step verification. Set it up in your security settings to continue.');
