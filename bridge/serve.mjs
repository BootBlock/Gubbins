/**
 * Bare-Node bootstrap for the read-only HTTP bridge (Phase HA-3).
 *
 * Like `cli.mjs`, it registers the `@/`-alias resolve hook (loader.mjs) before importing
 * any TypeScript that uses the alias, then loads the git-ignored `.env` (token + paths),
 * and finally imports the real server entry point.
 *
 *   node bridge/serve.mjs
 *
 * `.env` is optional — if it is absent, configuration is read from the real process
 * environment instead (e.g. systemd/Docker env), so nothing secret need ever touch disk.
 */
import { register } from 'node:module';

register('./loader.mjs', import.meta.url);

try {
  process.loadEnvFile('.env');
} catch {
  // No .env present: fall back to the ambient process environment.
}

await import('./src/serve.ts');
