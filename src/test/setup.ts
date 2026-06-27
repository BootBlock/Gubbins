/**
 * Global Vitest setup (referenced by `test.setupFiles` in vite.config.ts).
 *
 * Extends `expect` with the Testing Library DOM matchers (e.g. `toBeInTheDocument`)
 * for the component-level tests of the Tier-1 state layer described in spec §8.5.
 */
import '@testing-library/jest-dom/vitest';
