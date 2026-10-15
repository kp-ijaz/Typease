import { INestApplication, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { patchNestJsSwagger } from 'nestjs-zod';
import { AppModule } from './app.module';
import { createAppLogger } from './common/logger';
import { env } from './config/env';
import { JobQueue } from './common/jobs/job-queue';
import { WorkerHeartbeat } from './common/jobs/worker-heartbeat';
import { ProvisioningService } from './modules/tenancy/provisioning.service';
import { TenantResolver } from './modules/tenancy/tenant-resolver.service';

let swaggerPatched = false;

/** HTTP hardening and conventions shared by the server, the tests and the OpenAPI generator. */
export function configureApp(app: NestExpressApplication): void {
  const resolver = app.get(TenantResolver);
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.setGlobalPrefix('api/v1', { exclude: ['health', 'health/ready'] });
  app.use(
    helmet({
      // The API returns JSON and files only; nothing may be framed or executed from it.
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      hsts: env().NODE_ENV === 'production' ? { maxAge: 31536000, includeSubDomains: true } : false,
    }),
  );
  app.use(cookieParser());
  app.enableCors({
    credentials: true,
    maxAge: 600,
    allowedHeaders: ['content-type', 'authorization', 'x-requested-with', 'x-client-app', 'x-tenant-host', 'x-request-id', 'idempotency-key', 'accept-language'],
    exposedHeaders: ['x-request-id', 'content-disposition', 'x-total-count'],
    origin: (origin, cb) => {
      // Non-browser clients (mobile app, server-to-server, webhooks) send no Origin header.
      if (!origin) return cb(null, true);
      resolver
        .isAllowedOrigin(origin)
        .then((ok) => cb(null, ok))
        .catch(() => cb(null, false));
    },
  });
  app.useBodyParser('json', { limit: '1mb' });
  app.enableShutdownHooks();
}

export function buildOpenApi(app: INestApplication) {
  if (!swaggerPatched) {
    patchNestJsSwagger();
    swaggerPatched = true;
  }
  const config = new DocumentBuilder()
    .setTitle('TypEase API')
    .setDescription(
      'REST API of the TypEase typing-centre platform. All tenant data is scoped to the centre bound to the access token; ' +
        'list endpoints accept page, pageSize, sort (field:asc|desc) and q. Money values are decimal strings.',
    )
    .setVersion('1.0.0')
    .addBearerAuth()
    .build();
  return SwaggerModule.createDocument(app, config);
}

export async function createApp(): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: createAppLogger(), rawBody: true });
  configureApp(app);
  if (env().NODE_ENV !== 'production') {
    SwaggerModule.setup('api/docs', app, buildOpenApi(app), { jsonDocumentUrl: 'api/docs-json' });
  }
  return app;
}

export async function startServer() {
  const app = await createApp();
  await app.listen(env().PORT, '0.0.0.0');
  // Reference data (permissions, plans, templates) is kept current on every start; all steps are idempotent.
  await app.get(ProvisioningService).bootstrapPlatform();
  app.get(JobQueue).startInlineSchedules();
  // Single-process mode: this process is what runs the jobs, so it is the one that reports being alive.
  if (env().QUEUE_DRIVER === 'inline' && env().QUEUE_INLINE_AUTORUN) app.get(WorkerHeartbeat).start('single-process');
  new Logger('Bootstrap').log(`TypEase API listening on :${env().PORT} (${env().NODE_ENV})`);
  return app;
}
