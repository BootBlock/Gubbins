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

// High-value async-safety rules — the payoff for a worker/RPC/React-Query codebase (and for
// the bridge, a Node server that runs for days) that `tsc` alone won't catch. Kept as a focused
// set, not the full type-checked preset, so real findings aren't buried in stylistic noise.
//
// Shared by the two type-aware blocks below — the app's and the bridge's — so the two can never
// drift apart. Both need type information, so each points the parser at its own tsconfig via the
// project service.
const asyncSafetyRules = {
  '@typescript-eslint/no-floating-promises': 'error',
  // JSX event handlers are legitimately `async` (React ignores the returned promise), so exempt
  // attributes; still flags a promise passed where a plain callback is run.
  '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
  '@typescript-eslint/await-thenable': 'error',
};

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
      // Sibling checkouts of this same repo live here. Without this, `eslint .` from the
      // primary checkout descends into every one of them — linting other branches' work
      // (7895 files instead of 1512) and reporting findings that aren't in this tree.
      '.claude/worktrees/**',
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
      // `no-explicit-any` is an error in product code (from the recommended preset). The
      // one legitimate use — the TS-mandated mixin constructor in `item/mixin.ts` — carries
      // a scoped disable; test files relax it below (loose JSON-boundary assertions).
    },
  },

  // Strip-only TypeScript: the bridge runs the app's `.ts` directly under Node's built-in
  // type-stripping loader (no build step), which erases type syntax but never *generates*
  // code. Constructor parameter properties, `enum` and `namespace` all need generated code,
  // so Node rejects them at import time with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` — while
  // `tsc` and esbuild both accept them happily. The boot-smoke (`npm run smoke:bridge`)
  // catches this, but only after the fact; this rule makes it an editor squiggle instead.
  //
  // It applies to `src/**` as well as `bridge/**` because the constraint follows the
  // bridge's *import graph*, which reaches deep into the app source (much of `src/db`, the
  // search modules, backup/snapshot). That graph shifts as imports change, so scoping the
  // rule to today's reachable set would silently rot; a uniform ban costs a plain field
  // assignment at the handful of call sites and can never be tripped by accident.
  {
    files: ['src/**/*.{ts,tsx}', 'bridge/**/*.ts'],
    ignores: ['**/*.test.{ts,tsx}', 'src/test/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TSParameterProperty',
          message:
            "Constructor parameter properties can't run under Node's strip-only TypeScript loader (the bridge imports this graph). Declare the field explicitly and assign it in the constructor body.",
        },
        {
          selector: 'TSEnumDeclaration',
          message:
            "`enum` can't run under Node's strip-only TypeScript loader (the bridge imports this graph). Use a `const` object with `as const` plus a derived union type.",
        },
        // NOTE: the third strip-hostile construct, `namespace` / `module` blocks, needs no
        // selector here — `@typescript-eslint/no-namespace` (already an error via the
        // recommended preset) bans exactly the value-producing forms and already permits
        // ambient `declare module`/`.d.ts` type space, which strips fine. Adding one here
        // only produced a second error on the same line.
      ],
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
      // The two classic hook rules, enabled explicitly rather than by spreading
      // `reactHooks.configs.recommended.rules`. As of eslint-plugin-react-hooks v7 that
      // preset also turns on the React Compiler rule set (`set-state-in-effect`, `refs`,
      // `purity`, `immutability`, …) — 14 rules that report 113 errors against this
      // codebase today. Those are worth adopting, but auditing them is its own piece of
      // work, not a dependency bump; tracked in #401 so they land deliberately.
      // Enumerating the rules we want (instead of spreading and switching the rest off)
      // means a future v8 can't silently re-enable a rule set nobody has triaged.
      'react-hooks/rules-of-hooks': 'error',
      // Promote the hook-dependency check to an error: a stale/oversized dep array is a
      // real bug (missed re-render or an effect firing every render), not a style nit.
      'react-hooks/exhaustive-deps': 'error',
      // Accessibility linting — the app invests heavily in ARIA/APG patterns, so this is a
      // natural fit, enforced at the recommended preset's severities (errors).
      ...jsxA11y.flatConfigs.recommended.rules,
      // Teach `label-has-associated-control` about the Foundry form primitives: a `<label>`
      // wrapping one of these wraps a real control, exactly as if it wrapped a bare <input>.
      'jsx-a11y/label-has-associated-control': [
        'error',
        { controlComponents: ['Input', 'Select', 'Textarea', 'Checkbox', 'Radio'] },
      ],
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      ...asyncSafetyRules,
      // NOTE: `no-unnecessary-type-assertion` is intentionally omitted. Under TS 6.x (newer
      // than this typescript-eslint supports) its type view drops `noUncheckedIndexedAccess`,
      // so it wrongly reports index-access assertions as unnecessary and its autofix removes
      // assertions that `tsc` actually requires. Revisit once typescript-eslint supports TS 6.
    },
  },

  // The bridge (INCLUDING its tests): the same type-aware async-safety rules. This is the one
  // long-running process in the project — an unhandled rejection takes the whole server down
  // rather than logging a warning in a console nobody has open — so it is the part that needs
  // these rules most (#601).
  //
  // Its tests are in scope too, unlike the app's: `bridge/tsconfig.json` includes them in its
  // program, so the project service can type them, and an unawaited promise in a test is how a
  // test quietly stops asserting anything. (The app's tests stay out — `tsconfig.app.json`
  // excludes them, so there is no program to type them against.)
  //
  // `bridge/src/**` rather than `bridge/**` deliberately mirrors that tsconfig's `include`:
  // `bridge/vitest.config.ts` is outside the program, and the project service errors on a file
  // it cannot find a program for.
  {
    files: ['bridge/src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        warnOnUnsupportedTypeScriptVersion: false,
      },
    },
    rules: { ...asyncSafetyRules },
  },

  // Tests: vitest globals (globals: true), browser env via happy-dom. This block adds globals
  // and relaxes `no-explicit-any`; it does not set a parser, so whatever an earlier block
  // established still stands. In practice that means the APP's tests are parsed syntactically
  // only (no block points the project service at them, and `tsconfig.app.json` excludes them
  // from the program anyway), while the BRIDGE's tests keep the project service — and therefore
  // the type-aware rules — from the block above.
  {
    files: ['**/*.test.{ts,tsx}', 'src/test/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.worker, ...globals.vitest },
    },
    rules: {
      // Tests assert against loosely-typed boundaries (parsed JSON API responses, fixtures),
      // where `any` is pragmatic and the assertions themselves are the real safety net —
      // the standard production-strict / test-pragmatic split. Product code stays strict.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  // Browser-context extension code (content script + background/service worker), with the same
  // type-aware async-safety rules as the app and the bridge. It could not have them before
  // `extension/tsconfig.json` existed — the project service had no program to point at, which is
  // the only reason this block used to set globals alone (#557, #601). The background worker is
  // the strongest case for them: an unhandled rejection there is invisible, since nobody has a
  // service-worker console open.
  {
    files: ['extension/src/**/*.ts'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.worker, chrome: 'readonly' },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        warnOnUnsupportedTypeScriptVersion: false,
      },
    },
    rules: { ...asyncSafetyRules },
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
