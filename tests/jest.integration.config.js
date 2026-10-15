/** `pnpm test:integration`: scenarios 1-23 and 26-30 (tests/integration). See jest.config.js for everything else. */
const base = require('./jest.config');

/** @type {import('jest').Config} */
module.exports = { ...base, testMatch: ['<rootDir>/integration/**/*.spec.ts'] };
