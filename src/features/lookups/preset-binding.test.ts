/**
 * The zero-config promise: an **untouched preset category binds every one of its provider's
 * output keys, with no `fieldMap` at all** (issue #616).
 *
 * That promise is the whole reason binding is by *name* rather than by a field id a provider
 * cannot know, and it rests on two lists in two different files agreeing — a provider's
 * `defaultTarget`s and the preset's field names. Nothing else forces them to: renaming a preset
 * field, retyping one, or renaming an output key's target would leave the lookup silently
 * reporting "there's no such field" on a category the app itself created.
 *
 * The failure is quiet by design (an unbound key is *reported*, never a crash), so it is exactly
 * the kind of drift a test has to catch rather than review.
 */
import { describe, expect, it } from 'vitest';
import { CATEGORY_PRESETS } from '@/features/inventory/category-presets';
import { bindLookupOutputs, type BindableField } from './binding';
import { WIKIDATA_FILM_PROVIDER } from './providers/wikidata-film';
import type { LookupProvider } from './types';

/** The preset with this id, or a failure naming what has gone missing. */
function preset(presetId: string) {
  const found = CATEGORY_PRESETS.find((candidate) => candidate.id === presetId);
  if (found === undefined) throw new Error(`no "${presetId}" preset — has it been renamed?`);
  return found;
}

/** The preset's declared fields, in the shape the binder takes. Ids stand in for real rows. */
function presetFields(presetId: string): readonly BindableField[] {
  return preset(presetId).seed.fields.map((field, index) => ({
    id: `field-${index}`,
    name: field.name,
    fieldType: field.fieldType,
    options: field.options ?? null,
  }));
}

/** The preset each provider's default field names are lifted from, and which attaches it. */
const PROVIDER_PRESETS: ReadonlyArray<{ provider: LookupProvider; presetId: string }> = [
  { provider: WIKIDATA_FILM_PROVIDER, presetId: 'movie' },
];

describe.each(PROVIDER_PRESETS)(
  '$provider.id binds the $presetId preset with no configuration',
  ({ provider, presetId }) => {
    it('is attached by the preset, with no field map to maintain', () => {
      // The attachment is what makes the lookup reachable at all: without it the preset creates a
      // category whose items show no "Fill from a database" affordance. `fieldMap: null` is the
      // zero-config claim the rest of this file exists to keep true — a map here would mean the
      // names below had stopped lining up and someone had papered over it.
      expect(preset(presetId).seed.category.lookupSources).toEqual([
        { providerId: provider.id, fieldMap: null },
      ]);
    });

    it('binds every output key', () => {
      const { bindings, problems } = bindLookupOutputs(provider.outputs, presetFields(presetId), null);
      // Named individually so a failure says *which* key drifted, not just that one did.
      expect(problems.map((p) => `${p.kind}: ${p.outputKey} → ${p.wantedName}`)).toEqual([]);
      expect(bindings.map((b) => b.outputKey)).toEqual(provider.outputs.map((o) => o.key));
    });

    it('binds each key to a distinct target, so two values cannot land in one field', () => {
      const { bindings } = bindLookupOutputs(provider.outputs, presetFields(presetId), null);
      const targets = bindings.map((b) =>
        b.target.kind === 'field' ? `field:${b.target.field.id}` : b.target.target,
      );
      expect(new Set(targets).size).toBe(targets.length);
    });
  },
);
