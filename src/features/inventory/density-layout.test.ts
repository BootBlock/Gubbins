/**
 * Tests for the per-item layout seam (issue #444).
 *
 * The point of this module is that three call sites — the flat list and the grouped view's two
 * section bodies — ask the same question and must get the same answer. So what earns a test is
 * the *distinctness* of the four per-item modes rather than any one class string: Card and
 * Gallery must both pack a grid but not at the same width, Data and Compact must both stack but
 * not at the same gap. Assert those relationships, and a change that quietly collapsed two modes
 * into one fails here instead of shipping as a near-duplicate.
 */
import { describe, expect, it } from 'vitest';
import { LAYOUT_DENSITIES, type ItemDensity } from '@/state/stores/useLayoutStore';
import {
  DENSITY_COLUMN_WIDTH,
  densityColumnWidth,
  densityGridStyle,
  densitySectionClass,
  densitySectionGridStyle,
  densityVirtualRowClass,
  isMultiColumnDensity,
} from './density-layout';

const ITEM_DENSITIES = LAYOUT_DENSITIES.filter((d): d is ItemDensity => d !== 'map' && d !== 'treemap');

describe('the per-item modes stay distinct', () => {
  it('packs Card and Gallery into columns, and stacks Data and Compact one per line', () => {
    expect(isMultiColumnDensity('visual')).toBe(true);
    expect(isMultiColumnDensity('gallery')).toBe(true);
    expect(isMultiColumnDensity('data')).toBe(false);
    expect(isMultiColumnDensity('compact')).toBe(false);
    expect(isMultiColumnDensity('table')).toBe(false);
  });

  it('gives Gallery a narrower column than Card, so the two grids do not coincide', () => {
    const card = densityColumnWidth('visual');
    const gallery = densityColumnWidth('gallery');
    expect(card).not.toBeNull();
    expect(gallery).not.toBeNull();
    expect(gallery!).toBeLessThan(card!);
  });

  it('draws each of the four with its own row and section classes', () => {
    const rows = ['visual', 'gallery', 'data', 'compact'].map((d) =>
      densityVirtualRowClass(d as ItemDensity),
    );
    expect(new Set(rows).size).toBe(4);
    const sections = ['visual', 'gallery', 'data', 'compact'].map((d) =>
      densitySectionClass(d as ItemDensity),
    );
    expect(new Set(sections).size).toBe(4);
  });
});

describe('every per-item mode is answered', () => {
  it.each(ITEM_DENSITIES)('has a column-width entry for %s', (density) => {
    // `null` is an answer; `undefined` means the record forgot the mode.
    expect(DENSITY_COLUMN_WIDTH[density]).not.toBeUndefined();
  });

  it.each(ITEM_DENSITIES)('returns a string class for %s', (density) => {
    expect(densityVirtualRowClass(density)).toBeTypeOf('string');
    expect(densitySectionClass(density)).toBeTypeOf('string');
  });
});

describe('grid templates', () => {
  it('spans the measured column count for a multi-column mode', () => {
    expect(densityGridStyle('gallery', 4)).toEqual({
      gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
    });
  });

  it('gives a one-per-line mode no template at all, so it is not a grid', () => {
    expect(densityGridStyle('compact', 4)).toBeUndefined();
    expect(densitySectionGridStyle('data')).toBeUndefined();
  });

  it('packs a section at the mode’s own minimum width', () => {
    expect(densitySectionGridStyle('gallery')).toEqual({
      gridTemplateColumns: `repeat(auto-fill, minmax(${densityColumnWidth('gallery')}px, 1fr))`,
    });
  });
});
