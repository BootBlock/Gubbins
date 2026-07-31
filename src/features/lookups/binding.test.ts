import { describe, expect, it } from 'vitest';
import { bindLookupOutputs, type BindableField } from './binding';
import type { LookupOutputDef } from './types';

const field = (id: string, name: string, fieldType: BindableField['fieldType'] = 'TEXT'): BindableField => ({
  id,
  name,
  fieldType,
  options: null,
});

const OUTPUTS: readonly LookupOutputDef[] = [
  { key: 'title', type: 'TEXT', defaultTarget: 'builtin:name' },
  { key: 'director', type: 'TEXT', defaultTarget: 'Director' },
  { key: 'releaseYear', type: 'NUMBER', defaultTarget: 'Release year' },
];

describe('bindLookupOutputs — binding by name', () => {
  it('binds an output key to the category field of that name', () => {
    const { bindings, problems } = bindLookupOutputs([OUTPUTS[1]!], [field('f1', 'Director')], null);
    expect(problems).toEqual([]);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]!.target).toEqual({ kind: 'field', field: field('f1', 'Director') });
    expect(bindings[0]!.targetName).toBe('Director');
  });

  it('matches case, spacing and Unicode composition through the dictionary fold', () => {
    // The same fold `field_defs` identifies a definition by, so a lookup can never bind to a
    // *different* field than the one the dictionary would consider the same name.
    for (const name of ['director', 'DIRECTOR', '  Director  ']) {
      const { bindings } = bindLookupOutputs([OUTPUTS[1]!], [field('f1', name)], null);
      expect(bindings, name).toHaveLength(1);
    }
    const composed = bindLookupOutputs(
      [{ key: 'k', type: 'TEXT', defaultTarget: 'Régisseur' }],
      // "Régisseur" with a combining acute — a different string that renders identically.
      [field('f1', 'Régisseur')],
      null,
    );
    expect(composed.bindings).toHaveLength(1);
  });

  it('reports an output key no field matches rather than dropping it', () => {
    const { bindings, problems } = bindLookupOutputs([OUTPUTS[1]!], [field('f1', 'Genre')], null);
    expect(bindings).toEqual([]);
    expect(problems).toEqual([
      { kind: 'NO_FIELD', outputKey: 'director', wantedName: 'Director', wantedType: 'TEXT' },
    ]);
  });

  it('reports a type mismatch rather than coercing the value into the wrong field', () => {
    const { bindings, problems } = bindLookupOutputs(
      [OUTPUTS[2]!],
      [field('f1', 'Release year', 'TEXT')],
      null,
    );
    expect(bindings).toEqual([]);
    expect(problems).toEqual([
      {
        kind: 'TYPE_MISMATCH',
        outputKey: 'releaseYear',
        wantedName: 'Release year',
        wantedType: 'NUMBER',
        foundType: 'TEXT',
      },
    ]);
  });

  it('is stable when two field names fold to the same key, taking the first', () => {
    // A database written before the fold existed can hold both spellings; which one a lookup
    // binds to must not vary between runs.
    const fields = [field('first', 'Director'), field('second', 'DIRECTOR')];
    for (let run = 0; run < 3; run += 1) {
      const { bindings } = bindLookupOutputs([OUTPUTS[1]!], fields, null);
      expect(bindings[0]!.target).toMatchObject({ kind: 'field', field: { id: 'first' } });
    }
  });
});

describe('bindLookupOutputs — built-in targets', () => {
  it("binds a provider's builtin default without needing a field of that name", () => {
    const { bindings, problems } = bindLookupOutputs([OUTPUTS[0]!], [], null);
    expect(problems).toEqual([]);
    expect(bindings[0]!.target).toEqual({ kind: 'builtin', target: 'builtin:name' });
  });

  it('does not confuse a custom field called "Name" with the built-in attribute', () => {
    // `builtin-field-names.ts` establishes that a custom field may legitimately share a
    // built-in's name, so the built-in is addressed by its reserved id and never by name.
    const custom = field('f1', 'Name');
    const { bindings } = bindLookupOutputs([OUTPUTS[0]!], [custom], null);
    expect(bindings[0]!.target).toEqual({ kind: 'builtin', target: 'builtin:name' });
  });

  it('lets a stored map redirect a builtin default onto a custom field', () => {
    const custom = field('f1', 'Title');
    const { bindings } = bindLookupOutputs([OUTPUTS[0]!], [custom], { title: 'f1' });
    expect(bindings[0]!.target).toEqual({ kind: 'field', field: custom });
  });
});

describe('bindLookupOutputs — the stored fieldMap override', () => {
  it('binds to the mapped field id, ignoring the name match', () => {
    const renamed = field('f9', 'Helmed by');
    const { bindings } = bindLookupOutputs([OUTPUTS[1]!], [renamed, field('f1', 'Director')], {
      director: 'f9',
    });
    expect(bindings[0]!.target).toEqual({ kind: 'field', field: renamed });
  });

  it('falls back to the name match when the mapped field no longer exists', () => {
    // A field can be removed long after the map was written, and the name is the more durable
    // of the two — a stale map entry must not disable the lookup for that key.
    const { bindings } = bindLookupOutputs([OUTPUTS[1]!], [field('f1', 'Director')], { director: 'gone' });
    expect(bindings[0]!.target).toMatchObject({ kind: 'field', field: { id: 'f1' } });
  });

  it('falls back to the built-in default when the mapped field no longer exists', () => {
    // A built-in cannot go missing, so a stale map entry must not lose it. Without the fallback
    // the key would look for a field literally named "builtin:name", find none, and report
    // "there's no “builtin:name” field in this category" — a sentence with no meaning to a user.
    const { bindings, problems } = bindLookupOutputs([OUTPUTS[0]!], [], { title: 'gone' });
    expect(problems).toEqual([]);
    expect(bindings[0]!.target).toEqual({ kind: 'builtin', target: 'builtin:name' });
  });

  it('maps a key onto a built-in target', () => {
    const { bindings } = bindLookupOutputs([OUTPUTS[1]!], [], { director: 'builtin:description' });
    expect(bindings[0]!.target).toEqual({ kind: 'builtin', target: 'builtin:description' });
  });

  it('names the *mapped* field in a type mismatch, since that is the one to fix', () => {
    const { problems } = bindLookupOutputs([OUTPUTS[2]!], [field('notes', 'Notes', 'LONG_TEXT')], {
      releaseYear: 'notes',
    });
    expect(problems).toEqual([
      {
        kind: 'TYPE_MISMATCH',
        outputKey: 'releaseYear',
        wantedName: 'Notes',
        wantedType: 'NUMBER',
        foundType: 'LONG_TEXT',
      },
    ]);
  });
});

describe('bindLookupOutputs — the whole set', () => {
  it('resolves each key independently, so one failure never hides another binding', () => {
    const { bindings, problems } = bindLookupOutputs(
      OUTPUTS,
      [field('f1', 'Director'), field('f2', 'Release year', 'TEXT')],
      null,
    );
    expect(bindings.map((b) => b.outputKey)).toEqual(['title', 'director']);
    expect(problems.map((p) => p.outputKey)).toEqual(['releaseYear']);
  });

  it('reports every key when the category has no fields at all', () => {
    const { bindings, problems } = bindLookupOutputs(OUTPUTS, [], null);
    expect(bindings.map((b) => b.outputKey)).toEqual(['title']);
    expect(problems).toHaveLength(2);
    expect(problems.every((p) => p.kind === 'NO_FIELD')).toBe(true);
  });
});
