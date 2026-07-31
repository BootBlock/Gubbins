import { describe, expect, it } from 'vitest';
import type { BindableField, LookupBinding } from './binding';
import {
  applyLookupFillPlan,
  buildLookupFillPlan,
  planHasChanges,
  type LookupCurrentValues,
} from './fill-plan';

const field = (id: string, name: string, fieldType: BindableField['fieldType'] = 'TEXT'): BindableField => ({
  id,
  name,
  fieldType,
  options: null,
});

const toField = (outputKey: string, f: BindableField): LookupBinding => ({
  outputKey,
  target: { kind: 'field', field: f },
  targetName: f.name,
});

const toName: LookupBinding = {
  outputKey: 'title',
  target: { kind: 'builtin', target: 'builtin:name' },
  targetName: 'builtin:name',
};

const NOTHING_HELD: LookupCurrentValues = { fieldValues: {}, builtins: {} };

describe('buildLookupFillPlan — classification', () => {
  const director = field('f1', 'Director');
  const bindings = [toField('director', director)];

  it('FILLs an empty field', () => {
    const plan = buildLookupFillPlan(bindings, [], { director: 'Ridley Scott' }, NOTHING_HELD);
    expect(plan.proposals[0]).toMatchObject({ status: 'FILL', current: null, incoming: 'Ridley Scott' });
  });

  it('treats a whitespace-only current value as empty', () => {
    const plan = buildLookupFillPlan(
      bindings,
      [],
      { director: 'Ridley Scott' },
      {
        fieldValues: { f1: '   ' },
        builtins: {},
      },
    );
    expect(plan.proposals[0]!.status).toBe('FILL');
  });

  it('CONFLICTs when the field holds a different value', () => {
    const plan = buildLookupFillPlan(
      bindings,
      [],
      { director: 'Ridley Scott' },
      {
        fieldValues: { f1: 'Denis Villeneuve' },
        builtins: {},
      },
    );
    expect(plan.proposals[0]).toMatchObject({
      status: 'CONFLICT',
      current: 'Denis Villeneuve',
      incoming: 'Ridley Scott',
    });
  });

  it('reads UNCHANGED when the values differ only by case or spacing', () => {
    // Prompting to replace "Ridley Scott" with "RIDLEY SCOTT" would be noise, not safety.
    for (const held of ['Ridley Scott', 'RIDLEY SCOTT', '  ridley scott ']) {
      const plan = buildLookupFillPlan(
        bindings,
        [],
        { director: 'Ridley Scott' },
        {
          fieldValues: { f1: held },
          builtins: {},
        },
      );
      expect(plan.proposals[0]!.status, held).toBe('UNCHANGED');
    }
  });

  it('SKIPs a key the source had nothing for, whether absent, null or blank', () => {
    for (const value of [undefined, null, '', '   ']) {
      const plan = buildLookupFillPlan(
        bindings,
        [],
        { director: value },
        {
          fieldValues: { f1: 'Mine' },
          builtins: {},
        },
      );
      expect(plan.proposals[0], String(value)).toMatchObject({ status: 'SKIP', incoming: null });
    }
  });

  it('never proposes clearing a value the user has, when the source knows nothing', () => {
    const plan = buildLookupFillPlan(
      bindings,
      [],
      { director: null },
      {
        fieldValues: { f1: 'Mine' },
        builtins: {},
      },
    );
    expect(applyLookupFillPlan(plan, new Set(['director']))).toEqual({ fieldValues: {}, builtins: {} });
  });
});

describe('buildLookupFillPlan — values are validated against the field they land in', () => {
  it('canonicalises a number so an equal value is not mistaken for a conflict', () => {
    const year = field('f1', 'Release year', 'NUMBER');
    const plan = buildLookupFillPlan(
      [toField('releaseYear', year)],
      [],
      { releaseYear: 1982 },
      {
        fieldValues: { f1: '1982' },
        builtins: {},
      },
    );
    expect(plan.proposals[0]).toMatchObject({ status: 'UNCHANGED', incoming: '1982' });
  });

  it('reports a value the bound field cannot hold instead of proposing a write that would fail', () => {
    // The URL field is the right *type* for the key, but this particular value is not a URL —
    // knowable only once the value is in hand, so it is a plan-time problem, not a binding one.
    const url = field('f1', 'Reference', 'URL');
    const plan = buildLookupFillPlan([toField('imdbUrl', url)], [], { imdbUrl: 'not a url' }, NOTHING_HELD);
    expect(plan.proposals).toEqual([]);
    expect(plan.problems).toHaveLength(1);
    expect(plan.problems[0]).toMatchObject({
      kind: 'UNUSABLE_VALUE',
      outputKey: 'imdbUrl',
      wantedName: 'Reference',
    });
  });

  it('reports a SELECT value outside the field’s option list', () => {
    const format: BindableField = {
      id: 'f1',
      name: 'Format',
      fieldType: 'SELECT',
      options: ['DVD', 'Blu-ray'],
    };
    const plan = buildLookupFillPlan([toField('format', format)], [], { format: 'VHS' }, NOTHING_HELD);
    expect(plan.proposals).toEqual([]);
    expect(plan.problems[0]!.kind).toBe('UNUSABLE_VALUE');
  });

  it('carries binding problems through unchanged, so the dialog has one list to render', () => {
    const plan = buildLookupFillPlan(
      [],
      [{ kind: 'NO_FIELD', outputKey: 'cast', wantedName: 'Cast', wantedType: 'LONG_TEXT' }],
      {},
      NOTHING_HELD,
    );
    expect(plan.problems).toHaveLength(1);
    expect(plan.problems[0]!.kind).toBe('NO_FIELD');
  });
});

describe('buildLookupFillPlan — built-in targets', () => {
  it('classifies a built-in against the item’s own attribute', () => {
    const plan = buildLookupFillPlan(
      [toName],
      [],
      { title: 'Blade Runner' },
      {
        fieldValues: {},
        builtins: { 'builtin:name': 'blade runner' },
      },
    );
    expect(plan.proposals[0]!.status).toBe('UNCHANGED');
  });

  it('fills a built-in the item leaves empty, and does not validate it as a custom field', () => {
    const plan = buildLookupFillPlan([toName], [], { title: 'Blade Runner' }, NOTHING_HELD);
    expect(applyLookupFillPlan(plan)).toEqual({
      fieldValues: {},
      builtins: { 'builtin:name': 'Blade Runner' },
    });
  });
});

describe('applyLookupFillPlan — the no-overwrite safeguard', () => {
  const director = field('f1', 'Director');
  const genre = field('f2', 'Genre');
  const bindings = [toField('director', director), toField('genre', genre)];
  const held: LookupCurrentValues = { fieldValues: { f1: 'Someone else' }, builtins: {} };
  const values = { director: 'Ridley Scott', genre: 'science fiction film' };

  it('writes FILLs and withholds CONFLICTs by default', () => {
    const plan = buildLookupFillPlan(bindings, [], values, held);
    expect(applyLookupFillPlan(plan)).toEqual({
      fieldValues: { f2: 'science fiction film' },
      builtins: {},
    });
  });

  it('writes a CONFLICT only when that specific key is opted into', () => {
    const plan = buildLookupFillPlan(bindings, [], values, held);
    expect(applyLookupFillPlan(plan, new Set(['director'])).fieldValues).toEqual({
      f1: 'Ridley Scott',
      f2: 'science fiction film',
    });
  });

  it('ignores an opt-in for a key that is not a CONFLICT, so it can never introduce a change', () => {
    const plan = buildLookupFillPlan(bindings, [], { director: null, genre: null }, held);
    expect(applyLookupFillPlan(plan, new Set(['director', 'genre']))).toEqual({
      fieldValues: {},
      builtins: {},
    });
  });

  it('planHasChanges tracks exactly what would be written', () => {
    const conflictOnly = buildLookupFillPlan([toField('director', director)], [], values, held);
    expect(planHasChanges(conflictOnly)).toBe(false);
    expect(planHasChanges(conflictOnly, new Set(['director']))).toBe(true);
  });

  it('a plan whose only outcome is a problem writes nothing and reports no change', () => {
    const plan = buildLookupFillPlan(
      [],
      [{ kind: 'NO_FIELD', outputKey: 'cast', wantedName: 'Cast', wantedType: 'LONG_TEXT' }],
      { cast: 'Harrison Ford' },
      NOTHING_HELD,
    );
    expect(planHasChanges(plan)).toBe(false);
  });
});
