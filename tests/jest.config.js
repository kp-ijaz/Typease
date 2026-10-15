/**
 * Cross-module acceptance suite (API level): the 30 required scenarios of section 34 of the master prompt.
 *
 * The suite has no dependencies of its own. It is run by the API package's jest (see package.json):
 *
 *   pnpm test:integration   ->  jest.integration.config.js  (tests/integration)
 *   pnpm test:security      ->  jest.security.config.js     (tests/security)
 *   pnpm --filter @typease/tests test   -> this file (both folders)
 *
 * Each of them is `pnpm --filter @typease/api exec jest --runInBand --config ../../tests/<config>`, so the
 * current directory is services/api, and everything that has to be found there (the swc transform, supertest,
 * Nest, ...) is addressed with absolute paths from this file. Anything appended to a script is a jest argument:
 * `pnpm test:integration 02-request-journey`, `pnpm test:security -t "refund"`.
 */
const path = require('node:path');

const root = path.join(__dirname, '..');
const api = path.join(root, 'services', 'api');
const pkg = (p) => path.join(root, p);
const fromApi = (name) => require.resolve(name, { paths: [api] });

// The API's .swcrc is only found automatically when jest's rootDir is services/api: pass the same options here.
const swc = {
  jsc: {
    parser: { syntax: 'typescript', decorators: true },
    transform: { legacyDecorator: true, decoratorMetadata: true },
    target: 'es2022',
    keepClassNames: true,
  },
  module: { type: 'commonjs' },
  sourceMaps: 'inline',
  swcrc: false,
};

/** @type {import('jest').Config} */
module.exports = {
  rootDir: __dirname,
  // The API sources live outside rootDir; jest has to be allowed to resolve and transform them.
  roots: [__dirname],
  testEnvironment: 'node',
  testMatch: ['<rootDir>/integration/**/*.spec.ts', '<rootDir>/security/**/*.spec.ts'],
  // "ts" first so a compiled .js next to a .ts source can never shadow it.
  moduleFileExtensions: ['ts', 'js', 'mjs', 'cjs', 'json', 'node'],
  transform: { '^.+\\.ts$': [fromApi('@swc/jest'), swc] },
  // Bare imports in tests/support (none today besides node built-ins) resolve like in the API package.
  modulePaths: [path.join(api, 'node_modules')],
  moduleNameMapper: {
    '^@typease/permissions$': pkg('packages/permissions/src/index.ts'),
    '^@typease/types$': pkg('packages/types/src/index.ts'),
    '^@typease/validation$': pkg('packages/validation/src/index.ts'),
    '^@typease/database$': pkg('database/index.ts'),
  },
  // Same database rebuild and environment as the API's own integration tests.
  globalSetup: path.join(api, 'test', 'global-setup.ts'),
  setupFiles: [path.join(api, 'test', 'env.ts')],
  // 01-..., 02-... in that order, always (see support/sequencer.js).
  testSequencer: path.join(__dirname, 'support', 'sequencer.js'),
  testTimeout: 120000,
  maxWorkers: 1,
};
