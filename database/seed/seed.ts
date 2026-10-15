/**
 * `pnpm db:seed` / `pnpm db:reset` entry point.
 *
 * The demo data is created by driving the real API, so the program lives with
 * the API (services/api/src/cli/seed.ts). This launcher only starts it, with
 * the arguments and environment it was given.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const apiDir = join(__dirname, '..', '..', 'services', 'api');
const result = spawnSync(process.execPath, ['-r', '@swc-node/register', 'src/cli/seed.ts', ...process.argv.slice(2)], { cwd: apiDir, stdio: 'inherit', env: process.env });
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
