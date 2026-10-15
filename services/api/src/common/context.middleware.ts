import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { TenantResolver } from '../modules/tenancy/tenant-resolver.service';
import { newContext, runWithContext } from './context';
import { logRequest } from './logger';

/**
 * Opens the per-request security context. Requests start anonymous (no tenant,
 * no permissions); the AuthGuard fills in the verified identity afterwards.
 */
@Injectable()
export class ContextMiddleware implements NestMiddleware {
  constructor(private readonly resolver: TenantResolver) {}

  async use(req: Request, res: Response, next: NextFunction) {
    const incoming = req.header('x-request-id');
    const requestId = incoming && /^[A-Za-z0-9-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    res.setHeader('x-request-id', requestId);

    // Which portal is this request coming from? (public presentation only, never authorisation)
    let host = req.header('x-tenant-host');
    if (!host) {
      const origin = req.header('origin');
      if (origin) {
        try {
          host = new URL(origin).host;
        } catch {
          host = undefined;
        }
      }
    }
    let hostTenantId: string | undefined;
    try {
      hostTenantId = (await this.resolver.fromHost(host)) ?? undefined;
    } catch {
      hostTenantId = undefined;
    }
    const context = newContext({
      requestId,
      ip: req.ip,
      userAgent: req.header('user-agent') ?? undefined,
      app: req.header('x-client-app') ?? undefined,
      hostTenantId,
      actorType: 'CUSTOMER',
      actorLabel: 'anonymous',
    });
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      runWithContext(context, () =>
        logRequest({
          method: req.method,
          // Route pattern when known (ids never reach the logs), otherwise the path without its query string.
          path: (req.route?.path && `${req.baseUrl}${req.route.path}`) || req.originalUrl.split('?')[0],
          status: res.statusCode,
          durationMs: Math.round(Number(process.hrtime.bigint() - started) / 1e6),
          ip: req.ip,
          app: context.app,
        }),
      );
    });
    runWithContext(context, () => next());
  }
}
