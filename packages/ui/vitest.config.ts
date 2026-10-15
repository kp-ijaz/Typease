import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      '@typease/types': src('../types/src/index.ts'),
      '@typease/validation': src('../validation/src/index.ts'),
      '@typease/permissions': src('../permissions/src/index.ts'),
      '@typease/branding': src('../branding/src/index.ts'),
      '@typease/api-client': src('../api-client/src/index.ts'),
    },
  },
  test: { environment: 'jsdom', include: ['src/**/*.test.{ts,tsx}'], setupFiles: ['./src/test-setup.ts'] },
});
