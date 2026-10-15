const path = require('node:path');
const preset = require('./tailwind-preset.cjs');

/**
 * Tailwind configuration for a TypEase web app:
 *
 *   // apps/<app>/tailwind.config.cjs
 *   module.exports = require('@typease/ui/tailwind.cjs').createTailwindConfig(__dirname);
 *
 * Scans the app's own sources and the shared component sources.
 */
function createTailwindConfig(appDir, overrides = {}) {
  return {
    presets: [preset],
    content: [
      path.join(appDir, 'app/**/*.{ts,tsx}'),
      path.join(appDir, 'components/**/*.{ts,tsx}'),
      path.join(appDir, 'lib/**/*.{ts,tsx}'),
      path.join(__dirname, 'src/**/*.{ts,tsx}'),
      `!${path.join(__dirname, 'src/**/*.test.{ts,tsx}')}`,
    ],
    ...overrides,
  };
}

module.exports = { createTailwindConfig, preset };
