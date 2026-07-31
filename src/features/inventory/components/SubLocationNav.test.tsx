import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { LocationWithCount } from '@/db/repositories';
import { SubLocationNav, describeLocationContents } from './SubLocationNav';

/**
 * Covers the "drill down" navigation shown in the item pane when a location holds no
 * items of its own but nests other locations: each child is a clickable card (Visual) or
 * row (Data) that selects it, plus the contents-summary helper feeding their subtitles.
 */

function loc(over: Partial<LocationWithCount> & Pick<LocationWithCount, 'id' | 'name'>): LocationWithCount {
  return {
    parentId: null,
    isSystem: false,
    description: null,
    color: null,
    kind: null,
    capacity: null,
    isDefault: false,
    archivedAt: null,
    updatedAt: 0,
    itemCount: 0,
    ...over,
  };
}

afterEach(cleanup);

describe('describeLocationContents', () => {
  it('summarises items and nested locations, pluralising each', () => {
    expect(describeLocationContents(0, 0)).toBe('Empty');
    expect(describeLocationContents(1, 0)).toBe('1 item');
    expect(describeLocationContents(3, 0)).toBe('3 items');
    expect(describeLocationContents(0, 1)).toBe('1 sub-location');
    expect(describeLocationContents(0, 2)).toBe('2 sub-locations');
    expect(describeLocationContents(3, 2)).toBe('3 items · 2 sub-locations');
  });
});

describe('SubLocationNav', () => {
  const children = [
    loc({ id: 'a', name: 'Cabinet A', parentId: 'shed', itemCount: 4 }),
    loc({ id: 'b', name: 'Cabinet B', parentId: 'shed' }),
  ];
  // Cabinet B nests a drawer, so its summary should read "1 sub-location".
  const all = [...children, loc({ id: 'd', name: 'Drawer', parentId: 'b' })];

  it('renders a clickable card per child and navigates on click (Visual)', () => {
    const onSelect = vi.fn();
    render(<SubLocationNav childLocations={children} locations={all} density="visual" onSelect={onSelect} />);

    fireEvent.click(screen.getByRole('button', { name: /Open Cabinet A — 4 items/i }));
    expect(onSelect).toHaveBeenCalledWith('a');

    // The childless-but-nesting cabinet advertises its sub-location count.
    expect(screen.getByRole('button', { name: /Open Cabinet B — 1 sub-location/i })).toBeInTheDocument();
  });

  it('renders a clickable row per child and navigates on click (Data)', () => {
    const onSelect = vi.fn();
    render(<SubLocationNav childLocations={children} locations={all} density="data" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: /Open Cabinet B/i }));
    expect(onSelect).toHaveBeenCalledWith('b');
  });

  it('ignores an archived grandchild when counting sub-locations', () => {
    const withArchived = [...children, loc({ id: 'd', name: 'Drawer', parentId: 'b', archivedAt: 1 })];
    render(
      <SubLocationNav
        childLocations={children}
        locations={withArchived}
        density="visual"
        onSelect={vi.fn()}
      />,
    );
    // Cabinet B's only child is archived → it reads "Empty", not "1 sub-location".
    expect(screen.getByRole('button', { name: /Open Cabinet B — Empty/i })).toBeInTheDocument();
  });

  // Issue #617: a child's description previews on its card, so the note a user wrote about a
  // place is readable at the moment they choose which place to open.
  describe("a child's description", () => {
    const described = [
      loc({ id: 'a', name: 'Cabinet A', parentId: 'shed', description: 'Overflow for the **workshop**' }),
      loc({ id: 'b', name: 'Cabinet B', parentId: 'shed' }),
    ];

    it.each(['visual', 'data'] as const)('previews it as plain text (%s)', (density) => {
      render(
        <SubLocationNav
          childLocations={described}
          locations={described}
          density={density}
          onSelect={vi.fn()}
        />,
      );
      // Flattened, so the Markdown markers never leak onto the card.
      expect(screen.getByText('Overflow for the workshop')).toBeInTheDocument();
    });

    it('carries the preview into the accessible name, which the Data row relies on', () => {
      render(
        <SubLocationNav childLocations={described} locations={described} density="data" onSelect={vi.fn()} />,
      );
      expect(
        screen.getByRole('button', { name: 'Open Cabinet A — Empty. Overflow for the workshop' }),
      ).toBeInTheDocument();
      // A child with no description keeps the original label exactly.
      expect(screen.getByRole('button', { name: 'Open Cabinet B — Empty' })).toBeInTheDocument();
    });
  });
});
