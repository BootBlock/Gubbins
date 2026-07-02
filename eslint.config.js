// Flat ESLint config (ESLint 9). Codifies the house style this repo already writes by
// hand — 2-space, single-quote, braceless single-line guards — and adds the bug-catching
// rules `tsc` can't express. Formatting (whitespace/quotes/width) is Prettier's job;
// `eslint-config-prettier` (last) switches off every rule that would fight it.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  // Never lint build output, deps, coverage, or generated code.
  {
    ignores: [
      'dist/**',
      'dist-ssr/**',
      'coverage/**',
      'node_modules/**',
      'extension/dist/**',
      'public/**',
      'src/routeTree.gen.ts',
      '**/*.gen.ts',
    ],
  },

  // Base: ESLint core + typescript-eslint (syntactic — fast, no type information needed).
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Project-wide rules.
  {
    rules: {
      // `tsc` already flags genuinely-undefined identifiers with full type awareness, and
      // `no-undef` throws false positives on ambient/DOM types — typescript-eslint's own
      // guidance is to switch it off for TypeScript.
      'no-undef': 'off',
      // Allow intentionally-unused args/vars when prefixed with `_`.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // Pre-existing `any` (mostly test casts + a mixin constructor helper where `any` is
      // idiomatic) is surfaced as a warning — visible, but not a merge blocker.
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },

  // Ambient declaration files legitimately use triple-slash references.
  {
    files: ['**/*.d.ts'],
    rules: { '@typescript-eslint/triple-slash-reference': 'off' },
  },

  // App source (NOT tests): React rules + type-aware async-safety rules. These need type
  // information, so the parser is pointed at the nearest tsconfig via the project service.
  // Tests are excluded here because tsconfig.app.json excludes them from the program.
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['**/*.test.{ts,tsx}', 'src/test/**'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.worker },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        // TS 6.x is newer than this typescript-eslint's tested range; it still parses
        // fine, so silence the one-time "unsupported version" warning.
        warnOnUnsupportedTypeScriptVersion: false,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
      'jsx-a11y': jsxA11y,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Accessibility linting — the app invests heavily in ARIA/APG patterns, so this is a
      // natural fit. Adopted at `warn` (not `error`) so the pre-existing findings are a
      // visible backlog rather than a merge blocker; promote to `error` as they're fixed.
      // Rules the recommended preset ships disabled (e.g. the deprecated `label-has-for`)
      // stay disabled — only the active `error` rules are softened to `warn`.
      ...Object.fromEntries(
        Object.entries(jsxA11y.flatConfigs.recommended.rules).map(([rule, setting]) => {
          const severity = Array.isArray(setting) ? setting[0] : setting;
          const disabled = severity === 'off' || severity === 0;
          return [rule, disabled ? setting : 'warn'];
        }),
      ),
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // High-value async-safety rules — the payoff for a worker/RPC/React-Query codebase
      // that `tsc` alone won't catch. Kept as a focused set, not the full type-checked
      // preset, so real findings aren't buried in stylistic noise on first adoption.
      '@typescript-eslint/no-floating-promises': 'error',
      // JSX event handlers are legitimately `async` (React ignores the returned promise),
      // so exempt attributes; still flags a promise passed where a plain callback is run.
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
      '@typescript-eslint/await-thenable': 'error',
      // NOTE: `no-unnecessary-type-assertion` is intentionally omitted. Under TS 6.x (newer
      // than this typescript-eslint supports) its type view drops `noUncheckedIndexedAccess`,
      // so it wrongly reports index-access assertions as unnecessary and its autofix removes
      // assertions that `tsc` actually requires. Revisit once typescript-eslint supports TS 6.
    },
  },

  // Tests: vitest globals (globals: true), browser env via happy-dom. Parsed
  // syntactically only — no project service, so no type-aware rules run here.
  {
    files: ['**/*.test.{ts,tsx}', 'src/test/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.worker, ...globals.vitest },
    },
  },

  // Browser-context extension code (content script + background/service worker).
  {
    files: ['extension/src/**/*.ts'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.worker, chrome: 'readonly' },
    },
  },

  // Node-side tooling: Vite config, build/test scripts, extension build.
  {
    files: ['*.{js,ts}', 'scripts/**/*.{js,mjs}', 'extension/*.mjs'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // Turn off any rule that overlaps with Prettier. MUST stay last EXCEPT for the curly
  // override below.
  prettier,

  // The house style: braceless single-line guards (`if (!x) return;`) are allowed, but a
  // body that wraps onto its own line MUST use braces — so a second statement can never be
  // silently added outside the `if`. `eslint-config-prettier` disables `curly` defensively,
  // so this must be re-asserted AFTER it.
  {
    rules: {
      curly: ['error', 'multi-line'],
    },
  },
);
