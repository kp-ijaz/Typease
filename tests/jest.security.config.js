/** `pnpm test:security`: scenarios 24 and 25 and the boundaries around them (tests/security). See jest.config.js for everything else. */
const base = require('./jest.config');

/** @type {import('jest').Config} */
module.exports = { ...base, testMatch: ['<rootDir>/security/**/*.spec.ts'] };
