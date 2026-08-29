import { useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { FormField, Input } from '@/components/foundry';
import type { NameMatch } from '@/db/repositories';
import { useDuplicateNameWarning } from './useDuplicateNameWarning';

/**
 * The Add/Edit item dialogs' duplicate-name advisory (issue #99). Pins the three judgements the
 * hook makes — exact against similar, the item's own name excluded, and the blur gate that keeps
 * the message out of the way while a name is still being typed.
 */

let matches: NameMatch[] = [];
// The advisory's only data source; each test sets what already exists. Mocked rather than
// provided, so the harness needs no QueryClient — the same contract the Barcode field's test has.
vi.mock('../queries', () => ({ useNameMatches: (name: string) => ({ data: name ? matches : [] }) }));

beforeEach(() => {
  matches = [];
});
afterEach(cleanup);

function match(over: Partial<NameMatch> & { readonly name: string }): NameMatch {
  return { id: `id-${over.name}`, serialNo: null, exact: true, ...over };
}

/** A field wired exactly as the real editors wire it: the gate wraps change and blur. */
function renderField(initial = '', itemId?: string) {
  function Harness() {
    const [value, setValue] = useState(initial);
    const advisory = useDuplicateNameWarning(value, itemId);
    return (
      <FormField label="Name" warning={advisory.warning}>
        <Input
          data-testid="name"
          value={value}
          onChange={(e) => {
            advisory.onEdit();
            setValue(e.target.value);
          }}
          onBlur={advisory.onSettle}
        />
      </FormField>
    );
  }
  render(<Harness />);
  return screen.getByTestId('name');
}

function typeAndBlur(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}

describe('useDuplicateNameWarning', () => {
  it('says nothing when no item shares the name', () => {
    const input = renderField();
    typeAndBlur(input, 'Hammer');
    expect(screen.queryByRole('status')?.textContent ?? '').toBe('');
  });

  it('reports an exact match as an item that already exists', () => {
    matches = [match({ name: 'Socket screw' })];
    const input = renderField();
    typeAndBlur(input, 'socket screw');
    expect(screen.getByRole('status')).toHaveTextContent('already exists');
  });

  it('words a near match as a possibility rather than a fact', () => {
    matches = [match({ name: 'Socket screws', exact: false })];
    const input = renderField();
    typeAndBlur(input, 'Socket screw');
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Socket screws');
    expect(status).toHaveTextContent(/Check it isn’t the same thing/);
  });

  it('prefers the exact match when both kinds are present', () => {
    matches = [match({ name: 'Socket screw' }), match({ name: 'Socket screws', exact: false })];
    const input = renderField();
    typeAndBlur(input, 'Socket screw');
    expect(screen.getByRole('status')).toHaveTextContent('already exists');
  });

  it('never reports the item being edited against itself', () => {
    matches = [match({ name: 'Socket screw', id: 'self' })];
    const input = renderField('Socket screw', 'self');
    fireEvent.blur(input);
    expect(screen.queryByRole('status')?.textContent ?? '').toBe('');
  });

  it('judges a value the user did not type straight away, with no interaction', () => {
    matches = [match({ name: 'Socket screw', id: 'other' })];
    renderField('Socket screw', 'self');
    expect(screen.getByRole('status')).toHaveTextContent('already exists');
  });

  it('holds the advisory back while the name is still being typed', () => {
    matches = [match({ name: 'Socket screw' })];
    const input = renderField();
    fireEvent.change(input, { target: { value: 'Socket screw' } });
    expect(screen.queryByRole('status')?.textContent ?? '').toBe('');
    fireEvent.blur(input);
    expect(screen.getByRole('status')).toHaveTextContent('already exists');
  });

  it('clears the advisory again as soon as the user resumes editing', () => {
    matches = [match({ name: 'Socket screw' })];
    const input = renderField();
    typeAndBlur(input, 'Socket screw');
    expect(screen.getByRole('status')).toHaveTextContent('already exists');
    fireEvent.change(input, { target: { value: 'Socket screw x' } });
    expect(screen.queryByRole('status')?.textContent ?? '').toBe('');
  });
});
