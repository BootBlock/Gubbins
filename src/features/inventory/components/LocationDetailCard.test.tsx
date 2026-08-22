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
    icon: 'Archive',
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
    unit: null,
    minValue: null,
    maxValue: null,
    precision: null,
    prominence: null,
    value: '30 kg',
    isInheritable: false,
    // Unattributed by default (W1g), which is what a real row holds unless a device authored
    // the value. Spelling it out matters: this file is not typechecked, and an *absent* origin
    // is not the same as a null one — it compares unequal to this device and would mark every
    // FILE path as foreign.
    originDeviceId: null,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

/** The device the component reads via `getDeviceId`, pinned so attribution is decidable. */
vi.mock('@/lib/env/device-id', () => ({ getDeviceId: () => 'device-this' }));

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

  /**
   * W1f — the panel's doc comment offers "a link to the boiler manual" as its worked example.
   * These assert it really is one, through the *shared* `FieldValue` renderer, so the item card,
   * the dense row and the table cell get the same behaviour from the same assertions.
   */
  describe('URL / FILE values (W1f)', () => {
    it('renders a URL value as a link that opens safely in a new tab', () => {
      fieldValues.current = [
        makeField({ name: 'Boiler manual', fieldType: 'URL', value: 'https://example.com/boiler.pdf' }),
      ];
      render(<LocationDetailCard location={makeLocation({ description: null })} />);
      const link = screen.getByRole('link', { name: /example\.com\/boiler\.pdf/ });
      expect(link).toHaveAttribute('href', 'https://example.com/boiler.pdf');
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      // The new-tab warning reaches assistive technology, which otherwise meets it only after
      // the tab has already opened.
      expect(link).toHaveAccessibleName(/opens in a new tab/);
    });

    it('renders a FILE value holding a path as text, never as a link', () => {
      fieldValues.current = [
        makeField({ name: 'Wiring diagram', fieldType: 'FILE', value: '\\\\nas\\docs\\wiring.pdf' }),
      ];
      render(<LocationDetailCard location={makeLocation({ description: null })} />);
      // A browser cannot navigate an http(s) page to a UNC share, so an anchor here would look
      // live and do nothing. The value is still shown, and named as the file path it is.
      expect(screen.queryByRole('link')).not.toBeInTheDocument();
      expect(screen.getByText('\\\\nas\\docs\\wiring.pdf')).toBeInTheDocument();
      expect(screen.getByText('File path:')).toBeInTheDocument();
    });

    it('marks a FILE path the location recorded on another device (W1g)', () => {
      fieldValues.current = [
        makeField({
          name: 'Wiring diagram',
          fieldType: 'FILE',
          value: '\\\\nas\\docs\\wiring.pdf',
          originDeviceId: 'device-other',
        }),
      ];
      render(<LocationDetailCard location={makeLocation({ description: null })} />);
      // The path is still shown — it is the only thing that identifies what was pointed at —
      // but it is named for what it is rather than passing as an ordinary file path.
      expect(screen.getByText('\\\\nas\\docs\\wiring.pdf')).toBeInTheDocument();
      expect(screen.getByText('File path from another device:')).toBeInTheDocument();
      expect(screen.queryByText('File path:')).not.toBeInTheDocument();
    });

    it('renders a FILE value holding a web address as a link', () => {
      fieldValues.current = [
        makeField({ name: 'Datasheet', fieldType: 'FILE', value: 'https://example.com/ds.pdf' }),
      ];
      render(<LocationDetailCard location={makeLocation({ description: null })} />);
      expect(screen.getByRole('link')).toHaveAttribute('href', 'https://example.com/ds.pdf');
    });

    it('never turns an out-of-band script value into a link', () => {
      fieldValues.current = [
        makeField({ name: 'Boiler manual', fieldType: 'URL', value: 'javascript:alert(1)' }),
      ];
      render(<LocationDetailCard location={makeLocation({ description: null })} />);
      expect(screen.queryByRole('link')).not.toBeInTheDocument();
      expect(screen.getByText('javascript:alert(1)')).toBeInTheDocument();
    });
  });

  it('renders on field values alone, with no description', () => {
    fieldValues.current = [makeField()];
    render(<LocationDetailCard location={makeLocation({ description: '   ' })} />);
    expect(screen.getByTestId('location-detail-card')).toBeInTheDocument();
    expect(screen.getByText('Load rating')).toBeInTheDocument();
  });
});
