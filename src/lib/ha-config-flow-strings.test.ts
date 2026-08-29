/**
 * Guards the Home Assistant custom integration's config-flow catalogs.
 *
 * `custom_components/gubbins/` is Python, so nothing in the TypeScript build ever looks at it,
 * and Home Assistant only notices a missing string at the moment it renders the dialog: the
 * frontend falls back to printing the raw key. A user then meets `already_in_progress` where a
 * sentence should be (issue #673). The failure is invisible until someone walks that exact path
 * by hand, which is why it is asserted here instead.
 *
 * Two claims are checked, both of which the flow's *behaviour* depends on:
 *
 * 1. `strings.json` and `translations/en.json` are hand-kept copies of one another — Home
 *    Assistant builds them apart for core integrations, but a custom integration ships both
 *    unbuilt. They are compared as parsed objects, so key order and formatting may differ while
 *    the meaning may not.
 * 2. Every step, error and abort reason the flow can actually end on has a string. Reasons that
 *    Home Assistant raises on the flow's behalf are listed explicitly below, because they appear
 *    nowhere in our source to be scanned for.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoPath } from '../test/repo-path';

const COMPONENT = repoPath(import.meta.dirname, 'custom_components', 'gubbins');
const STRINGS = join(COMPONENT, 'strings.json');
const EN = join(COMPONENT, 'translations', 'en.json');
const FLOW = join(COMPONENT, 'config_flow.py');

const read = (path: string) => readFileSync(path, 'utf8');
const parse = (path: string) => JSON.parse(read(path)) as Record<string, unknown>;

const flow = read(FLOW);

/** Every `<attr>="<value>"` in the flow source, e.g. `matches('step_id')` for the form steps. */
function matches(attribute: string): string[] {
  // The leading class stands in for a word boundary, so `error=` does not also match the
  // `probe_error=` of some future keyword argument. Only the literal directly after the `=` is
  // seen, so a value in the alternative branch of a ternary is not — the one such site today
  // (`reason="bridge_moved" if moved else "already_configured"`) names a reason that the list
  // below covers anyway.
  const pattern = new RegExp(`(?:^|[^a-zA-Z_])${attribute}="([a-z_]+)"`, 'g');
  return [...new Set([...flow.matchAll(pattern)].map((m) => m[1]))];
}

/**
 * Abort reasons Home Assistant names on the flow's behalf. Nothing in `config_flow.py` spells
 * them, so the sweep above cannot see them, yet each is an end state a user can reach:
 *
 * - `_async_abort_entries_match()` aborts with `already_configured`.
 * - `async_set_unique_id()` defaults to `raise_on_progress=True`, and aborts with
 *   `already_in_progress` when another flow — in practice the discovery one — already holds
 *   that unique id.
 * - `async_update_reload_and_abort()` given no `reason` (neither of our two calls passes one)
 *   uses `reauth_successful` or `reconfigure_successful`, whichever the flow's source calls for.
 */
const RAISED_BY_HOME_ASSISTANT = [
  'already_configured',
  'already_in_progress',
  'reauth_successful',
  'reconfigure_successful',
];

const config = parse(STRINGS).config as {
  step: Record<string, unknown>;
  error: Record<string, string>;
  abort: Record<string, string>;
};

describe('Home Assistant config-flow strings', () => {
  it('keeps strings.json and translations/en.json saying the same thing', () => {
    expect(parse(EN)).toEqual(parse(STRINGS));
  });

  it('finds the flow source at all (guards against a silently-empty sweep)', () => {
    expect(matches('step_id').length).toBeGreaterThan(2);
    expect(matches('error').length).toBeGreaterThan(0);
    expect(matches('reason').length).toBeGreaterThan(0);
  });

  it.each(matches('step_id'))('has a form for step %s', (step) => {
    expect(Object.keys(config.step)).toContain(step);
  });

  it.each(matches('error'))('has wording for the %s form error', (error) => {
    expect(Object.keys(config.error)).toContain(error);
  });

  it.each([...new Set([...matches('reason'), ...RAISED_BY_HOME_ASSISTANT])])(
    'has wording for the %s abort',
    (reason) => {
      expect(Object.keys(config.abort)).toContain(reason);
    },
  );

  it('words every abort as a sentence rather than restating its key', () => {
    for (const [reason, text] of Object.entries(config.abort)) {
      expect(text, reason).not.toContain(reason);
      expect(text.length, reason).toBeGreaterThan(20);
    }
  });
});
