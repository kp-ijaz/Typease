// ESLint 9 flat config for the whole TypEase monorepo. One file: every workspace
// package runs `eslint .` from its own directory and ESLint walks up to this file.
// Rules are non-type-aware on purpose (tsc runs in the `typecheck` step), so a
// run needs no tsconfig and stays fast on the shared build machine.
//
// See docs/architecture/LINTING.md for what is linted, the warning budgets and
// the reasons behind every deliberate exception.
import { createRequire } from 'node:module';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

// `@eslint/js` is a dependency of eslint itself and is not hoisted to the root
// node_modules, so it is resolved from eslint's own location. No extra install.
const requireFromEslint = createRequire(createRequire(import.meta.url).resolve('eslint'));
const eslintJs = requireFromEslint('@eslint/js');

const APPS = ['centre-web', 'customer-web', 'corporate-portal', 'platform-admin'];

/** `(apps|packages)/...` files that may render raw HTML. Keep this list short and reviewed. */
const RAW_HTML_ALLOW_LIST = [
  // Inline theme bootstrap script (constant string, CSP nonce) and tenant brand CSS variables.
  'packages/ui/src/providers/theme-script.tsx',
  'packages/ui/src/providers/brand-style.tsx',
];

const NO_RAW_HTML = {
  selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
  message:
    'dangerouslySetInnerHTML is only allowed in the files listed in eslint.config.mjs (RAW_HTML_ALLOW_LIST); render data as JSX instead.',
};

/** Imports an app must never make: other apps, the backend services, the database package. */
function appRestrictedImports(app) {
  const otherApps = APPS.filter((a) => a !== app).concat('customer-mobile');
  return {
    patterns: [
      {
        group: otherApps.flatMap((a) => [`**/${a}/**`, `@typease/${a}`, `@typease/${a}/**`]),
        message: 'Apps must not import from other apps; move shared code to packages/ui or another package.',
      },
      {
        group: ['**/services/**', '@typease/api', '@typease/api/**', '@typease/worker', '@typease/worker/**'],
        message: 'Frontend apps must not import backend service code; use @typease/api-client and @typease/types.',
      },
      {
        group: ['**/database/**', '@typease/database', '@typease/database/**'],
        message: 'Frontend apps must not import the database package.',
      },
    ],
  };
}

const sharedRules = {
  eqeqeq: ['error', 'always', { null: 'ignore' }],
  'prefer-const': 'error',
  'no-var': 'error',
  'no-empty': ['error', { allowEmptyCatch: true }],
  '@typescript-eslint/no-unused-vars': [
    'error',
    {
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      caughtErrorsIgnorePattern: '^_',
      destructuredArrayIgnorePattern: '^_',
      ignoreRestSiblings: true,
    },
  ],
  // Counted and reported, never mass-rewritten: see LINTING.md.
  '@typescript-eslint/no-explicit-any': 'warn',
  '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports', fixStyle: 'inline-type-imports' }],
};

export default tseslint.config(
  // ---------------------------------------------------------------- ignores
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/.next/**',
      '**/.next-*/**',
      '**/out/**',
      '**/.turbo/**',
      '**/test-results/**',
      '**/playwright-report/**',
      '**/*.tsbuildinfo',
      '**/next-env.d.ts',
      // Generated code.
      'packages/types/src/generated/**',
      'database/generated/**',
      'docs/api/openapi.json',
      // Stale tsc output checked in next to test/helpers.ts; not source.
      // Not JavaScript/TypeScript, or not ours to lint.
      'apps/customer-mobile/**',
      'storage-data/**',
      'docs/**',
      'infrastructure/**',
      'pnpm-lock.yaml',
    ],
  },

  // ------------------------------------------------------------ base: all code
  eslintJs.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx,mts,cts}'],
    linterOptions: { reportUnusedDisableDirectives: 'warn' },
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.es2024 },
    },
    rules: sharedRules,
  },
  // Plain JavaScript (scripts, config files) gets no TypeScript-only rules.
  {
    files: ['**/*.{js,mjs,cjs}'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
  },

  // Playwright screenshot scripts: Node code whose page.evaluate() callbacks run in the browser.
  {
    files: ['packages/ui/scripts/screenshots.mjs', 'apps/*/scripts/shots*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },

  // ---------------------------------------------------- Node: backend & tooling
  {
    files: [
      'services/**',
      'database/**',
      'scripts/**',
      'packages/config/**',
      'packages/*/scripts/**',
      'packages/*/vitest.config.ts',
      'packages/ui/tailwind*.cjs',
      'apps/*/scripts/**',
      'apps/*/next.config.mjs',
      'apps/*/postcss.config.cjs',
      'apps/*/tailwind.config.cjs',
      'tests/**',
      'eslint.config.mjs',
    ],
    languageOptions: { globals: { ...globals.node } },
  },
  // NestJS + emitDecoratorMetadata: a class used only as a constructor-parameter type is still
  // needed at runtime for DI, so the type-only import rule must not run on decorated code.
  {
    files: ['services/**/*.ts', 'tests/**/*.ts'],
    rules: { '@typescript-eslint/consistent-type-imports': 'off' },
  },

  // ----------------------------------------------------- React: packages & apps
  {
    files: ['packages/ui/**/*.{ts,tsx}', 'packages/api-client/**/*.{ts,tsx}', 'packages/branding/**/*.{ts,tsx}', 'apps/*/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-hooks/rules-of-hooks': 'error',
      // Deliberately a warning: dependency arrays are not changed by the lint pass.
      'react-hooks/exhaustive-deps': 'warn',
      'no-restricted-syntax': ['error', NO_RAW_HTML],
    },
  },
  {
    files: RAW_HTML_ALLOW_LIST,
    rules: { 'no-restricted-syntax': 'off' },
  },
  // Browser code must not log; `warn` / `error` are allowed for reporting failures.
  {
    files: ['apps/*/**/*.{ts,tsx}', 'packages/ui/**/*.{ts,tsx}'],
    ignores: ['apps/*/scripts/**'],
    rules: { 'no-console': ['error', { allow: ['warn', 'error'] }] },
  },
  // Dependency direction between apps, packages and services.
  ...APPS.map((app) => ({
    files: [`apps/${app}/**/*.{ts,tsx,js,mjs,cjs}`],
    rules: { 'no-restricted-imports': ['error', appRestrictedImports(app)] },
  })),
  {
    files: ['packages/**/*.{ts,tsx,js,mjs,cjs}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/apps/**', '**/services/**', '@typease/api', '@typease/api/**', '@typease/worker', '@typease/worker/**'],
              message: 'Shared packages must not depend on apps or services.',
            },
          ],
        },
      ],
    },
  },

  // ---------------------------------------------------------------- test files
  {
    // Vitest (packages/*): APIs are imported explicitly, but jsdom/browser + node globals are in play.
    files: ['packages/**/*.test.{ts,tsx}', 'packages/ui/src/test-setup.ts'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: { 'no-console': 'off', '@typescript-eslint/no-explicit-any': 'off' },
  },
  {
    // Jest: API unit specs, e2e specs in services/api/test, integration & security suites.
    files: [
      'services/api/**/*.spec.ts',
      'services/api/test/**/*.ts',
      'tests/integration/**/*.ts',
      'tests/security/**/*.ts',
      'tests/support/**/*.ts',
      'tests/**/jest*.config.js',
    ],
    languageOptions: { globals: { ...globals.node, ...globals.jest } },
    rules: { 'no-console': 'off', '@typescript-eslint/no-explicit-any': 'off', '@typescript-eslint/no-non-null-assertion': 'off' },
  },
  {
    // Playwright: everything is imported from @playwright/test; browser globals appear inside page.evaluate().
    files: ['tests/e2e/**/*.ts'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: { 'no-console': 'off', '@typescript-eslint/no-explicit-any': 'off' },
  },

  // ------------------------------------------------- declaration & config files
  {
    files: ['**/*.d.ts', '**/*.d.mts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off', '@typescript-eslint/no-unused-vars': 'off' },
  },
);
