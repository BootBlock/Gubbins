/**
 * Reachability guard for the inventory **View** axis (issue #444).
 *
 * `LAYOUT_DENSITIES` is the union the store persists and the render fork switches on;
 * `DENSITY_MODES` is the list the "View" submenu draws. Nothing in the type system ties them
 * together, so a mode added to the union and forgotten in the descriptor list compiles, ships,
 * and is reachable only by hand-editing `localStorage` — and one dropped from the union but left
 * in the descriptor list gives the menu an entry that normalises straight back to the default.
 *
 * Both directions are asserted here rather than left to review, because both failures are silent.
 * The English labels themselves are guarded by the catalog-drift test.
 */
import { describe, expect, it } from 'vitest';
import { LAYOUT_DENSITIES } from '@/state/stores/useLayoutStore';
import { DENSITY_MODES } from './view-modes';

describe('DENSITY_MODES ↔ LAYOUT_DENSITIES', () => {
  it('offers exactly the modes the store can hold, in no duplicate', () => {
    const offered = DENSITY_MODES.map((mode) => mode.value);
    expect([...offered].sort()).toEqual([...LAYOUT_DENSITIES].sort());
    expect(new Set(offered).size).toBe(offered.length);
  });

  it('gives every mode an icon and a distinct label key', () => {
    const keys = DENSITY_MODES.map((mode) => mode.labelKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const mode of DENSITY_MODES) {
      // A Lucide icon is a `forwardRef` object, not a plain function — assert it is a renderable
      // component reference rather than its exact shape.
      expect(mode.icon, `view mode ${mode.value}`).toBeTruthy();
      expect(mode.label, `view mode ${mode.value}`).not.toBe('');
    }
  });
});
