import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/** Rebuilds the test database from the real migration files before the suite runs. */
export default async function globalSetup() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- side-effect module (sets process.env defaults); loaded when the setup runs, not when the file is imported
  require('./env');
  if (process.env.TEST_SKIP_DB_RESET === 'true') return;
  const root = join(__dirname, '..', '..', '..');
  execFileSync('pnpm', ['--filter', '@typease/database', 'exec', 'tsx', 'scripts/migrate.ts', '--reset'], {
    cwd: root,
    stdio: process.env.TEST_VERBOSE ? 'inherit' : 'pipe',
    env: { ...process.env, ALLOW_DB_RESET: 'true' },
  });
}
