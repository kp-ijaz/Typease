/**
 * `pnpm test:e2e` runs this instead of Playwright: the browser end-to-end suite was NOT written.
 * It prints tests/e2e/README.md (which says what exists instead and how to build the suite) and exits 1,
 * so that no pipeline or person can take `pnpm test:e2e` for a passing suite.
 * Restore `playwright test --config e2e/playwright.config.ts` in tests/package.json once the suite exists.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const readme = resolve(dirname(fileURLToPath(import.meta.url)), 'README.md');
console.error('tests/e2e: NO BROWSER END-TO-END TESTS EXIST. This is not a passing suite.\n');
console.error(readFileSync(readme, 'utf8'));
console.error('\ntests/e2e: exiting with status 1 - the Playwright suite has not been written.');
process.exit(1);
