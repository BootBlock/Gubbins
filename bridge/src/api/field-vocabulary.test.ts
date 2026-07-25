/**
 * Drift guard for every **prose restatement** of the projectable-field vocabulary.
 *
 * `ITEM_FIELD_REGISTRY` / `LOCATION_FIELD_REGISTRY` are the source of truth for what a caller may
 * name in `fields` (and its `$select` alias), but the same vocabulary is also spelled out in prose
 * that *is* the published contract: the `fields` parameter descriptions in the OpenAPI document
 * (mirrored verbatim into the committed `openapi.yaml`) and the field-vocabulary paragraph in the
 * bridge README. Those lists live inside a **string**, so no schema validator will ever notice one
 * drift — the API then advertises a field that returns 400, or omits one that works (issue #250).
 *
 * Both OpenAPI lists are interpolated from their registry, so this reads as a restatement of that
 * — which is the point: it fails the moment somebody replaces the interpolation with a hand-typed
 * copy and a registry subsequently moves. The README's list has no such seam (it is hand-written
 * prose) and had already lost the four dimension fields by the time this guard was added.
 *
 * The `$metadata` restatement is guarded separately, in `odata-metadata.test.ts`; the
 * `openapi.ts` → `openapi.yaml` serialisation pair in `openapi.test.ts`.
 */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { openapiDocument } from '../openapi.ts';
import { ITEM_FIELD_REGISTRY } from './item-view.ts';
import { LOCATION_FIELD_REGISTRY } from './location-view.ts';

const README_URL = new URL('../../README.md', import.meta.url);

const ITEM_FIELDS = [...ITEM_FIELD_REGISTRY.keys()];
const LOCATION_FIELDS = [...LOCATION_FIELD_REGISTRY.keys()];

/** One `fields` query parameter found in the document, tagged with the path that declares it. */
interface FieldsParam {
  readonly path: string;
  readonly fields: readonly string[];
}

/**
 * Pull the `Valid fields: a, b, c.` sentence out of a parameter description. Anchored on the
 * literal lead-in so the dotted nesting example earlier in the same sentence ("`placements.
 * quantity`") can't terminate the match early.
 */
function validFieldsIn(description: string): readonly string[] {
  const list = /Valid fields: ([^.]*)\./.exec(description)?.[1];
  if (list === undefined) expect.fail(`description should state its valid fields — ${description}`);
  return list.split(', ');
}

/** Every `fields` parameter in the emitted document, in path order. */
function collectFieldsParams(): readonly FieldsParam[] {
  const doc = openapiDocument as Record<string, any>;
  const found: FieldsParam[] = [];
  for (const [path, operations] of Object.entries(doc.paths as Record<string, any>)) {
    for (const operation of Object.values(operations as Record<string, any>)) {
      for (const parameter of (operation?.parameters ?? []) as { name?: string; description?: string }[]) {
        if (parameter.name === 'fields') {
          found.push({ path, fields: validFieldsIn(parameter.description ?? '') });
        }
      }
    }
  }
  return found;
}

describe('the OpenAPI document restates the field vocabulary', () => {
  const params = collectFieldsParams();
  // Locations are the only other projectable resource; anything else is an item endpoint.
  const isLocation = (path: string): boolean => path.startsWith('/api/v1/locations');

  it('declares `fields` on exactly the endpoints that support a projection', () => {
    // A drift guard that finds nothing passes, so pin the endpoints it is guarding. A new
    // projectable endpoint should have to be acknowledged here rather than slip through unchecked.
    expect(params.filter((p) => !isLocation(p.path)).map((p) => p.path)).toEqual([
      '/api/v1/search',
      '/api/v1/items',
      '/api/v1/items/{id}',
    ]);
    expect(params.filter((p) => isLocation(p.path)).map((p) => p.path)).toEqual([
      '/api/v1/locations',
      '/api/v1/locations/{id}',
    ]);
  });

  it('lists exactly the item field registry on every item endpoint (no drift)', () => {
    for (const { path, fields } of params.filter((p) => !isLocation(p.path))) {
      // Compare in registry order, not as sets: both lists are generated from the registry, so
      // order agrees for free, and a mismatch reads as a plain diff rather than a set difference.
      expect({ path, fields }).toEqual({ path, fields: ITEM_FIELDS });
    }
  });

  it('lists exactly the location field registry on every location endpoint (no drift)', () => {
    for (const { path, fields } of params.filter((p) => isLocation(p.path))) {
      expect({ path, fields }).toEqual({ path, fields: LOCATION_FIELDS });
    }
  });
});

describe('the bridge README restates the item field vocabulary', () => {
  it('lists exactly the item field registry (no drift)', async () => {
    const readme = await readFile(README_URL, 'utf8');
    const paragraph = /\*\*Full field vocabulary\*\*[\s\S]*?\n\n/.exec(readme)?.[0];
    if (paragraph === undefined) expect.fail('README should carry a **Full field vocabulary** paragraph');

    // Several entries carry a parenthetical whose own backticked names are element sub-keys, not
    // vocabulary entries — `placements` (nestable: `locationId, locationName, quantity`). Strip
    // parentheticals innermost-first, so the markdown link nested inside the last one doesn't
    // close its parent early and leave that parenthetical's sub-keys in the list.
    let prose = paragraph;
    for (let previous = ''; prose !== previous;) {
      previous = prose;
      prose = prose.replace(/\([^()]*\)/g, '');
    }

    expect([...prose.matchAll(/`([A-Za-z]+)`/g)].map((m) => m[1])).toEqual(ITEM_FIELDS);
  });
});
