/**
 * Demo environment seed.
 *
 *   pnpm db:seed                               (root script; the environment must be loaded, see docs/DEMO_ENVIRONMENT.md)
 *   pnpm db:seed -- --env-file=.env.dev-local  (reads KEY=VALUE lines first)
 *   pnpm db:seed -- --force-empty-check=skip   (development only: do not insist on an empty database)
 *
 * Creates a complete, entirely FICTIONAL data set by starting the real
 * application in this process and using its public HTTP API like the web apps
 * do. For local development and demonstrations only: the passwords it sets are
 * public knowledge. It refuses to run with NODE_ENV=production.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { isAbsolute, join, resolve } from 'node:path';

const HELP = `TypEase demo seed

  --env-file=<path>          load KEY=VALUE lines before starting (values already set win)
  --force-empty-check=skip   development only: run although the database already has centres
  --help                     this text

Environment: the usual API settings (DATABASE_URL, DATABASE_SYSTEM_URL, REDIS_URL, JWT_ACCESS_SECRET,
DATA_ENCRYPTION_KEY, HMAC_KEY, STORAGE_LOCAL_DIR ...) and DEMO_PASSWORD (optional).`;

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');

function loadEnvFile(path: string): void {
  const file = isAbsolute(path) ? path : [resolve(process.cwd(), path), resolve(REPO_ROOT, path)].find(existsSync) ?? path;
  if (!existsSync(file)) throw new Error(`--env-file: ${path} does not exist.`);
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => done(port));
    });
  });
}

async function main(): Promise<number> {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return 0;
  }
  const unknown = args.filter((a) => !/^--(env-file=.+|force-empty-check=skip)$/.test(a));
  if (unknown.length) {
    console.error(`Unknown argument: ${unknown.join(' ')}\n\n${HELP}`);
    return 2;
  }
  for (const a of args) if (a.startsWith('--env-file=')) loadEnvFile(a.slice('--env-file='.length));
  const skipEmptyCheck = args.includes('--force-empty-check=skip');

  if (process.env.NODE_ENV === 'production') {
    console.error('REFUSED: the demo seed never runs with NODE_ENV=production. It creates accounts with publicly known passwords.');
    return 2;
  }

  // Settings of THIS process only (the in-process application the seed drives). Nothing is written to any .env file.
  const port = await freePort();
  Object.assign(process.env, {
    // Verification / invitation / OTP tokens are returned in API responses so the flows can be completed without a mailbox.
    EXPOSE_DEV_TOKENS: 'true',
    // Jobs run when the seed drains the queue, which keeps the result reproducible; no Redis queue, no worker needed.
    QUEUE_DRIVER: 'inline',
    QUEUE_INLINE_AUTORUN: 'false',
    // Hundreds of sign-ins and registrations in a few minutes are not an attack.
    RATE_LIMIT_ENABLED: 'false',
    // The test payment gateway (no money moves).
    PAYMENT_SANDBOX_ENABLED: 'true',
    // Safety: the seed must never send a real email, SMS, WhatsApp or push message, whatever the developer's environment says.
    MAIL_DRIVER: 'log',
    SMS_DRIVER: 'log',
    WHATSAPP_DRIVER: 'log',
    PUSH_DRIVER: 'log',
    // Safety, same reason: automations and centre-configured gateways may only "call" this machine. The one
    // gateway the seed configures (the SMS outage of the demo) points at a closed local port on purpose.
    OUTBOUND_WEBHOOK_ALLOWED_HOSTS: '127.0.0.1',
    // No antivirus daemon is assumed; the built-in EICAR check still works.
    MALWARE_SCANNER: 'none',
    REQUIRE_CLEAN_SCAN: 'false',
    // Upload links issued by the local storage driver must point at this process.
    PORT: String(port),
    API_PUBLIC_URL: `http://127.0.0.1:${port}`,
  });
  // Safety: no real payment gateway, no automation hub and no external OCR service is contacted by a seed run.
  for (const key of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'N8N_WEBHOOK_BASE_URL', 'N8N_WEBHOOK_SECRET']) delete process.env[key];
  if (process.env.OCR_PROVIDER === 'external-http') process.env.OCR_PROVIDER = 'disabled';
  // One run can take longer than the default 15-minute access token.
  if (!(Number(process.env.JWT_ACCESS_TTL_SECONDS) >= 3600)) process.env.JWT_ACCESS_TTL_SECONDS = '3600';
  if (!process.env.LOG_LEVEL) process.env.LOG_LEVEL = 'warn';

  // Loaded only now, so that the application reads the settings above.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { runSeed } = require('./seed/main') as typeof import('./seed/main');
  return runSeed({ port, skipEmptyCheck, fixturesPath: join(REPO_ROOT, 'database', 'seed', 'index.ts') });
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e?.stack ?? e);
    process.exit(1);
  });
