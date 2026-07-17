import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { LocationWithCount } from '@/db/repositories';
import { LocationDescriptionCard } from './LocationDescriptionCard';

/**
 * The selected location's description block, shown atop the inventory list (issue #108).
 * It renders the description through the shared Markdown engine, so the test asserts both
 * the region labelling and that Markdown formatting is applied (rather than shown raw).
 */

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

afterEach(cleanup);

describe('LocationDescriptionCard', () => {
  it('labels the region with the location name', () => {
    render(<LocationDescriptionCard location={makeLocation()} />);
    expect(screen.getByRole('region', { name: 'Description of Cabinet A' })).toBeInTheDocument();
  });

  it('renders the description as Markdown, not raw text', () => {
    render(<LocationDescriptionCard location={makeLocation()} />);
    // `**fragile**` becomes a <strong>, so the asterisks are gone and the word is emphasised.
    const strong = screen.getByText('fragile');
    expect(strong.tagName).toBe('STRONG');
    expect(screen.getByTestId('location-description-card')).not.toHaveTextContent('**fragile**');
  });
});
