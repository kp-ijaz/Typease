import 'reflect-metadata';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Business modules are discovered from the folder structure: every
 * `src/modules/<name>/<name>.module.(ts|js)` that exports a Nest module is loaded.
 * Each module owns its controllers, services, job handlers, provisioning steps
 * and tests; shared infrastructure lives in src/common.
 *
 * TYPEASE_MODULES=a,b,c restricts loading to the named folders (used by
 * focused test runs). `auth`, `tenancy` and `health` are always loaded by
 * AppModule itself.
 */
const CORE = new Set(['auth', 'tenancy', 'health']);

function discover(): any[] {
  const only = (process.env.TYPEASE_MODULES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const found: any[] = [];
  for (const entry of readdirSync(__dirname, { withFileTypes: true })) {
    if (!entry.isDirectory() || CORE.has(entry.name)) continue;
    if (only.length && !only.includes(entry.name)) continue;
    const dir = join(__dirname, entry.name);
    for (const file of readdirSync(dir)) {
      if (!/\.module\.(ts|js)$/.test(file) || file.endsWith('.d.ts')) continue;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const exported = require(join(dir, file));
      for (const value of Object.values(exported)) {
        if (typeof value !== 'function') continue;
        const keys = Reflect.getMetadataKeys(value);
        if (keys.some((k) => ['imports', 'controllers', 'providers', 'exports'].includes(String(k)))) found.push(value);
      }
    }
  }
  return found;
}

export const FEATURE_MODULES: any[] = discover();
