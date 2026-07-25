/**
 * Drift guard for every **prose restatement** of a published field vocabulary — the projectable
 * fields (`fields` / `$select`) and the searchable ones (`$search`).
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
 * The **searchable** vocabulary went the same way, which is why it is guarded here too: the
 * `$search` description and both of the README's restatements had lost `barcode`, so the docs told
 * a scanner integration that the one column it cares about was not searchable, while the index
 * had covered it since the schema was written. The OpenAPI copy is now interpolated from
 * {@link SEARCHABLE_FIELD_NAMES}; the README's two are prose, and are checked against it below.
 *
 * The `$metadata` restatement is guarded separately, in `odata-metadata.test.ts`; the
 * `openapi.ts` → `openapi.yaml` serialisation pair in `openapi.test.ts`.
 */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { openapiDocument } from '../openapi.ts';
import { ITEM_FIELD_REGISTRY } from './item-view.ts';
import { LOCATION_FIELD_REGISTRY } from './location-view.ts';
import { SEARCHABLE_FIELD_NAMES } from './odata.ts';

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

/**
 * The `$search` vocabulary, restated in three places: the OpenAPI parameter description (one
 * object, reused by every endpoint that accepts it) and the bridge README twice — once in the
 * query-option table, once in the `$search` paragraph. All three lost `barcode`; nothing noticed,
 * because a list inside a sentence is invisible to every other check in the suite.
 */
describe('the $search vocabulary is restated without drift', () => {
  /** The `$search` parameter description, which is a single shared object in the document. */
  function searchParamDescriptions(): readonly string[] {
    const doc = openapiDocument as Record<string, any>;
    const found = new Set<string>();
    for (const operations of Object.values(doc.paths as Record<string, any>)) {
      for (const operation of Object.values(operations as Record<string, any>)) {
        for (const parameter of (operation?.parameters ?? []) as { name?: string; description?: string }[]) {
          if (parameter.name === '$search') found.add(parameter.description ?? '');
        }
      }
    }
    return [...found];
  }

  it('covers every FTS-indexed column, so the docs cannot understate the index', () => {
    // Pin the derivation itself against the schema's own list. `FTS_ITEM_COLUMNS` is what the
    // migration builds `items_fts` from, so this is the assertion that makes the other two
    // meaningful — without it, dropping a column from the constant would quietly agree everywhere.
    expect(SEARCHABLE_FIELD_NAMES).toEqual([
      'name',
      'description',
      'notes',
      'mpn',
      'manufacturer',
      'barcode',
      'serialNumber',
    ]);
  });

  it('names them all in the OpenAPI $search description (no drift)', () => {
    const descriptions = searchParamDescriptions();
    // A guard that finds nothing passes, so assert the description exists before reading it.
    expect(descriptions).toHaveLength(1);
    for (const field of SEARCHABLE_FIELD_NAMES) {
      expect(descriptions[0]).toContain(field);
    }
  });

  it('names them all in both of the README restatements (no drift)', async () => {
    const readme = await readFile(README_URL, 'utf8');

    // The query-option table row, and the `**`$search`** — …` paragraph that expands on it.
    const tableRow = /^\| `\$search` \|.*$/m.exec(readme)?.[0];
    if (tableRow === undefined) expect.fail('README should carry a `$search` query-option table row');
    const paragraph = /\*\*`\$search`\*\*[\s\S]*?\n\n/.exec(readme)?.[0];
    if (paragraph === undefined) expect.fail('README should carry a **`$search`** paragraph');

    for (const restatement of [tableRow, paragraph]) {
      // Backticked names only: the surrounding prose mentions `$filter` and `contains()`, so a
      // bare substring search would pass on words that are not the field list at all.
      const named = [...restatement.matchAll(/`([A-Za-z]+)`/g)].map((m) => m[1]);
      expect(named).toEqual(expect.arrayContaining([...SEARCHABLE_FIELD_NAMES]));
    }
  });
});
