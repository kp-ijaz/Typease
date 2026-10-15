const path = require('node:path');
const pkg = (p) => path.join(__dirname, '..', '..', p);

/** @type {import('jest').Config} */
module.exports = {
  rootDir: __dirname,
  testEnvironment: 'node',
  // TypeScript sources first so a stray compiled .js next to a .ts can never shadow it.
  moduleFileExtensions: ['ts', 'js', 'json', 'node'],
  testMatch: ['<rootDir>/src/**/*.spec.ts', '<rootDir>/test/**/*.spec.ts'],
  transform: { '^.+\\.ts$': ['@swc/jest'] },
  moduleNameMapper: {
    '^@typease/permissions$': pkg('packages/permissions/src/index.ts'),
    '^@typease/types$': pkg('packages/types/src/index.ts'),
    '^@typease/validation$': pkg('packages/validation/src/index.ts'),
    '^@typease/database$': pkg('database/index.ts'),
  },
  globalSetup: '<rootDir>/test/global-setup.ts',
  setupFiles: ['<rootDir>/test/env.ts'],
  testTimeout: 60000,
  maxWorkers: 1,
};
