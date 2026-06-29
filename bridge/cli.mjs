/**
 * Bare-Node entry point for the throwaway HA-1 parity CLI.
 *
 * It registers the `@/`-alias resolve hook (loader.mjs) and then dynamically imports
 * the real TypeScript CLI, so all of the app code it pulls in resolves correctly and
 * is type-stripped by Node at load. This indirection is required because the loader
 * must be registered *before* the modules that use the `@/` alias are imported.
 *
 *   node bridge/cli.mjs <path-to-gubbins-sync.json>
 */
import { register } from 'node:module';

register('./loader.mjs', import.meta.url);

await import('./src/cli.ts');
