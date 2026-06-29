/**
 * OpenAPI spec tests: the committed `openapi.yaml` is generated from the typed
 * `openapiDocument` (single source of truth), so guard against drift, and sanity-check the
 * document's internal references so a broken spec can't ship.
 */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { openapiDocument, type JsonValue } from './openapi.ts';
import { emitYaml } from './openapi-yaml.ts';

const YAML_URL = new URL('../openapi.yaml', import.meta.url);

describe('openapi.yaml', () => {
  it('matches a fresh emit of the spec object (no drift)', async () => {
    const committed = await readFile(YAML_URL, 'utf8');
    expect(committed).toBe(emitYaml(openapiDocument));
  });
});

describe('openapiDocument', () => {
  const doc = openapiDocument as Record<string, any>;

  it('is OpenAPI 3 with a versioned info block', () => {
    expect(doc.openapi).toBe('3.0.3');
    expect(doc.info.version).toBe('1.0.0');
  });

  it('describes every v1 endpoint under /api/v1 with a GET or (write) POST, secured by the bearer scheme', () => {
    const paths = doc.paths as Record<string, any>;
    for (const [path, ops] of Object.entries(paths)) {
      expect(path.startsWith('/api/v1'), `${path} should be under /api/v1`).toBe(true);
      // Reads are GET; the opt-in write endpoints are POST. Every path must define one of them.
      expect(ops.get ?? ops.post, `${path} should have a GET or POST`).toBeDefined();
    }
    // The write endpoints are POST-only and tagged `writes`.
    expect(doc.paths['/api/v1/items/{id}/adjust-quantity'].post.tags).toContain('writes');
    expect(doc.paths['/api/v1/items/{id}/adjust-gauge'].post.tags).toContain('writes');
    expect(doc.components.securitySchemes.bearerAuth.scheme).toBe('bearer');
  });

  it('has no dangling $ref — every referenced schema exists', () => {
    const schemas = new Set(Object.keys(doc.components.schemas));
    for (const ref of collectRefs(openapiDocument)) {
      const name = ref.replace('#/components/schemas/', '');
      expect(schemas.has(name), `missing schema for ${ref}`).toBe(true);
    }
  });
});

/** Walk the document collecting every `$ref` string value. */
function collectRefs(value: JsonValue, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const v of value) collectRefs(v, out);
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === '$ref' && typeof v === 'string') out.push(v);
      else collectRefs(v, out);
    }
  }
  return out;
}
