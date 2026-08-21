/**
 * Guards the one registry property the pure tests cannot see: that every optional feature is
 * actually *read* somewhere outside `features/modules/`.
 *
 * A `FeatureDef` with a toggle, a description and a preset membership looks completely healthy
 * from inside the module system — the intent is stored, `resolveEnabled` reports it off, and the
 * Modules screen renders its row — while no screen ever asks. The user then switches the module
 * off, watches the feature stay exactly where it was, and reasonably concludes the whole modular
 * system is decorative. That is what `cycle-counts` did between its declaration and issue #649,
 * and nothing in the suite noticed, because every assertion about the registry was an assertion
 * about the registry.
 *
 * So this sweeps the source instead. It is a **floor, not a proof**: it says a gate for the id
 * exists somewhere, never that the gate covers every surface the feature owns. A textual sweep
 * cannot know the second thing, and pretending otherwise would be worse than not checking.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { repoPath, sourceFiles } from '@/test/repo-path';
import { OPTIONAL_FEATURE_IDS, type FeatureId } from './feature-registry';
import { HIDEABLE_CAPABILITY_IDS } from '@/features/inventory/category-capabilities';

const SRC = repoPath(import.meta.dirname, 'src');
/** The registry, presets and read hooks name every id by definition — they prove nothing here. */
const MODULES_DIR = join(SRC, 'features', 'modules') + sep;

const corpus = sourceFiles(SRC)
  .filter((path) => !path.startsWith(MODULES_DIR))
  // Generated files carry no gate, and `routeTree.gen.ts` is rewritten by the router plugin
  // while the suite runs — reading one mid-write would silently shrink the corpus.
  .filter((path) => !path.endsWith('.gen.ts'))
  .map((path) => readFileSync(path, 'utf8'))
  .join('\n');

/**
 * The gating idioms a consumer uses: the read hooks, a `.has(id)` over the resolved set, and the
 * `feature:` / `feature=` annotation carried by nav destinations, dashboard widgets, item-detail
 * tabs and `ModuleGuard`. Whitespace-tolerant so a Prettier reflow cannot silently un-gate a
 * feature as far as this guard is concerned.
 */
function isGated(id: FeatureId): boolean {
  const quoted = `(?:'${id}'|"${id}")`;
  return new RegExp(
    `(?:useFeature|isFeatureEnabled|has)\\(\\s*${quoted}|feature\\s*[:=]\\s*\\{?\\s*${quoted}`,
  ).test(corpus);
}

/**
 * A capability a *category* may hide is gated through `isCapabilityVisible`, which takes the id
 * as a value rather than naming it at the call site — so the idioms above never match one, and
 * membership of that list is itself the consumer.
 */
const HIDEABLE = new Set<FeatureId>(HIDEABLE_CAPABILITY_IDS);

describe('every optional feature has a consumer', () => {
  it('sweeps a plausible corpus (a silently-empty sweep would pass everything)', () => {
    expect(corpus.length).toBeGreaterThan(1_000_000);
    expect(isGated('scanner')).toBe(true);
  });

  it('does not match an id no code mentions (guards a regex that matches anything)', () => {
    expect(isGated('not-a-real-feature' as FeatureId)).toBe(false);
  });

  it.each([...OPTIONAL_FEATURE_IDS])('%s is read by something outside features/modules', (id) => {
    expect(
      isGated(id) || HIDEABLE.has(id),
      `No code reads '${id}'. A module whose switch nothing consults is a dead switch: the user ` +
        `turns it off and the feature stays. Gate its entry points with useFeature('${id}'), or ` +
        `remove the registry entry and its preset memberships.`,
    ).toBe(true);
  });
});
