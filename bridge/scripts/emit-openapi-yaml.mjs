/**
 * Regenerate the committed `bridge/openapi.yaml` from the typed single source of truth
 * (`src/openapi.ts`). The `openapi.test.ts` drift-guard asserts the committed file matches a
 * fresh emit, so run this after editing the spec object:
 *
 *   node bridge/scripts/emit-openapi-yaml.mjs
 */
import { register } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { assertSupportedNodeVersion } from '../node-version.mjs';

// Same as the runnable entry points: this imports `.ts` directly, so say which Node is
// needed rather than dying on a type annotation.
assertSupportedNodeVersion();

register('../loader.mjs', import.meta.url);

const { openapiDocument } = await import('../src/openapi.ts');
const { emitYaml } = await import('../src/openapi-yaml.ts');

const target = fileURLToPath(new URL('../openapi.yaml', import.meta.url));
await writeFile(target, emitYaml(openapiDocument), 'utf8');
console.log(`Wrote ${target}`);
