import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { LocationFieldValue, LocationWithCount } from '@/db/repositories';
import { LocationDetailCard } from './LocationDetailCard';

/**
 * The selected location's own-detail block, shown atop the inventory list (issues #108, #617).
 * It renders the description through the shared Markdown engine and the location's custom-field
 * values through the same renderer the item cards use, so the tests cover both halves plus the
 * "nothing to say" case that decides whether the block appears at all.
 */

const fieldValues = vi.hoisted(() => ({ current: [] as LocationFieldValue[] }));
vi.mock('../categories', () => ({
  useLocationFieldValues: () => ({ data: fieldValues.current, isLoading: false }),
}));

function makeLocation(overrides: Partial<LocationWithCount> = {}): LocationWithCount {
  return {
    id: 'l1',
    name: 'Cabinet A',
    parentId: 'root',
    isSystem: false,
    description: 'Top shelf, **fragile** items only',
    color: null,
    kind: 'cabinet',
    capacity: 50,
    isDefault: false,
    archivedAt: null,
    updatedAt: 1_700_000_000_000,
    itemCount: 30,
    ...overrides,
  };
}

function makeField(overrides: Partial<LocationFieldValue> = {}): LocationFieldValue {
  return {
    id: 'lfv-1',
    locationId: 'l1',
    defId: 'def-load',
    name: 'Load rating',
    fieldType: 'TEXT',
    options: null,
    description: null,
    value: '30 kg',
    isInheritable: false,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  fieldValues.current = [];
});

describe('LocationDetailCard', () => {
  it('labels the region with the location name', () => {
    render(<LocationDetailCard location={makeLocation()} />);
    expect(screen.getByRole('region', { name: 'Details for Cabinet A' })).toBeInTheDocument();
  });

  it('renders the description as Markdown, not raw text', () => {
    render(<LocationDetailCard location={makeLocation()} />);
    // `**fragile**` becomes a <strong>, so the asterisks are gone and the word is emphasised.
    const strong = screen.getByText('fragile');
    expect(strong.tagName).toBe('STRONG');
    expect(screen.getByTestId('location-detail-card')).not.toHaveTextContent('**fragile**');
  });

  it("shows the location's own field values beside the description", () => {
    fieldValues.current = [makeField()];
    render(<LocationDetailCard location={makeLocation()} />);
    expect(screen.getByText('Load rating')).toBeInTheDocument();
    expect(screen.getByText('30 kg')).toBeInTheDocument();
  });

  it('shows a value that is also offered to the items inside', () => {
    // Inheritance decides who *else* reads the value, never whether the location does — and the
    // editor seeds a newly-added field as inheritable, so hiding these would leave the panel empty
    // for almost every user (issue #617).
    fieldValues.current = [makeField({ isInheritable: true, name: 'Manufacturer', value: 'Ryobi' })];
    render(<LocationDetailCard location={makeLocation({ description: null })} />);
    expect(screen.getByText('Manufacturer')).toBeInTheDocument();
    expect(screen.getByText('Ryobi')).toBeInTheDocument();
  });

  it('drops a field the location holds but has not filled in', () => {
    fieldValues.current = [
      makeField({ value: null }),
      makeField({ id: 'lfv-2', defId: 'def-humidity', value: '  ' }),
    ];
    render(<LocationDetailCard location={makeLocation({ description: null })} />);
    expect(screen.queryByTestId('location-detail-card')).not.toBeInTheDocument();
  });

  it('renders nothing when the location has neither a description nor a value', () => {
    render(<LocationDetailCard location={makeLocation({ description: null })} />);
    expect(screen.queryByTestId('location-detail-card')).not.toBeInTheDocument();
  });

  it('renders on field values alone, with no description', () => {
    fieldValues.current = [makeField()];
    render(<LocationDetailCard location={makeLocation({ description: '   ' })} />);
    expect(screen.getByTestId('location-detail-card')).toBeInTheDocument();
    expect(screen.getByText('Load rating')).toBeInTheDocument();
  });
});
