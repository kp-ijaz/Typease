import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppModule } from '../app.module';
import { buildOpenApi, configureApp } from '../bootstrap';
import { AccessRule } from '../common/auth/access';
import { discoverRoutes } from '../common/auth/routes';

/**
 * Writes docs/api/openapi.json and docs/api/ENDPOINTS.md (every route with its
 * access rule) from the running application's metadata, so the published API
 * reference can never drift from the code.
 *
 *   pnpm --filter @typease/api openapi
 */

function describeRule(rule: AccessRule | undefined): string {
  if (!rule) return '**UNDECLARED**';
  switch (rule.type) {
    case 'public':
      return 'Public';
    case 'internal':
      return 'Internal token';
    case 'authenticated':
      return 'Signed in';
    case 'platform':
      return `Platform: ${rule.any.join(' or ')}`;
    case 'tenant': {
      const parts: string[] = [];
      if (rule.kinds?.length) parts.push(`member kind ${rule.kinds.join('/')}`);
      if (rule.any?.length) parts.push(rule.any.join(' or '));
      if (rule.all?.length) parts.push(rule.all.join(' and '));
      return parts.length ? parts.join('; ') : 'Any tenant member';
    }
  }
}

async function main() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ['error'], rawBody: true });
  configureApp(app);
  await app.init();
  const outDir = join(__dirname, '..', '..', '..', '..', 'docs', 'api');
  mkdirSync(outDir, { recursive: true });

  const doc = buildOpenApi(app);
  writeFileSync(join(outDir, 'openapi.json'), JSON.stringify(doc, null, 2));

  const rows = discoverRoutes(app).map((r) => ({ tag: r.tag, method: r.method, path: r.path, rule: describeRule(r.rule) + (r.support ? ` (support session: ${r.support.mode === 'SAFE' ? 'allowed without a scope' : 'counts as a read'})` : ''), handler: r.handler }));
  const lines = [
    '# TypEase API - endpoint index',
    '',
    `Generated from the application metadata by \`pnpm --filter @typease/api openapi\`. ${rows.length} endpoints.`,
    'Request and response details are in `docs/api/modules/*.md` and `openapi.json` (also served at `/api/docs` outside production).',
    '',
  ];
  let current = '';
  for (const r of rows) {
    if (r.tag !== current) {
      current = r.tag;
      lines.push('', `## ${current}`, '', '| Method | Path | Access |', '| --- | --- | --- |');
    }
    lines.push(`| ${r.method} | \`${r.path}\` | ${r.rule} |`);
  }
  writeFileSync(join(outDir, 'ENDPOINTS.md'), lines.join('\n') + '\n');
  const undeclared = rows.filter((r) => r.rule.includes('UNDECLARED'));
  console.log(`Wrote openapi.json (${Object.keys(doc.paths).length} paths) and ENDPOINTS.md (${rows.length} endpoints).`);
  if (undeclared.length) {
    console.error(`Routes without an access rule:\n${undeclared.map((r) => `  ${r.handler}`).join('\n')}`);
    process.exitCode = 1;
  }
  await app.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
