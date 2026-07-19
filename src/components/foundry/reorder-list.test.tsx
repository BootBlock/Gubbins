import { describe, it, expect, vi, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ReorderList, type ReorderListItem } from './reorder-list';

afterEach(cleanup);

const ITEMS: ReorderListItem[] = [
  { id: 'location', label: 'Location', name: 'Location', visible: true },
  { id: 'category', label: 'Category', name: 'Category', visible: true },
  { id: 'condition', label: 'Condition', name: 'Condition', visible: false },
];

function renderList(overrides: Partial<React.ComponentProps<typeof ReorderList>> = {}) {
  const onMove = vi.fn();
  const onToggleVisible = vi.fn();
  render(
    <ReorderList
      items={ITEMS}
      onMove={onMove}
      onToggleVisible={onToggleVisible}
      aria-label="Card fields"
      {...overrides}
    />,
  );
  return { onMove, onToggleVisible };
}

describe('ReorderList', () => {
  it('names the list and renders each row', () => {
    renderList();
    expect(screen.getByRole('list', { name: 'Card fields' })).not.toBeNull();
    expect(screen.getByTestId('reorder-row-location')).not.toBeNull();
    expect(screen.getByTestId('reorder-row-category')).not.toBeNull();
  });

  it('disables move-up on the first row and move-down on the last', () => {
    renderList();
    expect((screen.getByTestId('reorder-up-location') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('reorder-down-location') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId('reorder-down-condition') as HTMLButtonElement).disabled).toBe(true);
  });

  it('calls onMove with the direction', () => {
    const { onMove } = renderList();
    fireEvent.click(screen.getByTestId('reorder-down-location'));
    expect(onMove).toHaveBeenCalledWith('location', 'down');
    fireEvent.click(screen.getByTestId('reorder-up-category'));
    expect(onMove).toHaveBeenCalledWith('category', 'up');
  });

  it('labels and fires the visibility toggle with the flipped value', () => {
    const { onToggleVisible } = renderList();
    // A visible row offers "Hide"; a hidden row offers "Show".
    expect(screen.getByRole('button', { name: 'Hide Location' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Show Condition' })).not.toBeNull();
    fireEvent.click(screen.getByTestId('reorder-toggle-location'));
    expect(onToggleVisible).toHaveBeenCalledWith('location', false);
    fireEvent.click(screen.getByTestId('reorder-toggle-condition'));
    expect(onToggleVisible).toHaveBeenCalledWith('condition', true);
  });

  it('renders no visibility toggle when items carry no `visible` flag', () => {
    render(
      <ReorderList
        items={[{ id: 'a', label: 'A', name: 'A' }]}
        onMove={vi.fn()}
        aria-label="Plain reorder"
      />,
    );
    expect(screen.queryByTestId('reorder-toggle-a')).toBeNull();
  });
});

/** A controlled harness that actually applies moves, so focus-follow can be exercised. */
function Harness({ initial }: { initial: ReorderListItem[] }) {
  const [items, setItems] = useState(initial);
  return (
    <ReorderList
      aria-label="Fields"
      items={items}
      onMove={(id, dir) =>
        setItems((prev) => {
          const i = prev.findIndex((x) => x.id === id);
          const j = dir === 'up' ? i - 1 : i + 1;
          if (j < 0 || j >= prev.length) return prev;
          const next = prev.slice();
          [next[i], next[j]] = [next[j], next[i]];
          return next;
        })
      }
    />
  );
}

const plain = (id: string): ReorderListItem => ({ id, label: id, name: id });

describe('ReorderList — keyboard focus follows a moved row', () => {
  it('keeps focus on the same-direction button while it stays enabled', () => {
    render(<Harness initial={[plain('a'), plain('b'), plain('c')]} />);
    // Move 'a' down: it lands in the middle, so its move-down button is still enabled and keeps focus.
    fireEvent.click(screen.getByTestId('reorder-down-a'));
    expect(document.activeElement).toBe(screen.getByTestId('reorder-down-a'));
  });

  it('re-homes focus to the opposite button when the row reaches an end (pressed button disables)', () => {
    render(<Harness initial={[plain('a'), plain('b')]} />);
    // Move 'a' down: it becomes last, so move-down disables — focus falls to its move-up button.
    fireEvent.click(screen.getByTestId('reorder-down-a'));
    const downA = screen.getByTestId('reorder-down-a') as HTMLButtonElement;
    expect(downA.disabled).toBe(true);
    expect(document.activeElement).toBe(screen.getByTestId('reorder-up-a'));
  });
});

describe('ReorderList — announces the new position', () => {
  it('speaks the row and its new place after an applied move', () => {
    render(<Harness initial={[plain('a'), plain('b'), plain('c')]} />);
    fireEvent.click(screen.getByTestId('reorder-down-a'));
    expect(screen.getByRole('status').textContent).toBe('a moved to position 2 of 3');
    fireEvent.click(screen.getByTestId('reorder-down-a'));
    expect(screen.getByRole('status').textContent).toBe('a moved to position 3 of 3');
  });

  it('stays silent when the caller does not apply the move', () => {
    // An uncontrolled list: `onMove` is a spy, so the order never changes.
    renderList();
    fireEvent.click(screen.getByTestId('reorder-down-location'));
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('does not carry a declined move over to the next unrelated re-render', () => {
    // The caller ignores `onMove`, but still re-renders with a fresh array (a sibling state
    // change). The declined press must not resurface as an announcement — or a focus jump —
    // once that unrelated update lands.
    function Declining() {
      const [n, setN] = useState(0);
      return (
        <>
          <button type="button" data-testid="bump" onClick={() => setN(n + 1)}>
            bump {n}
          </button>
          <ReorderList aria-label="Fields" items={[plain('a'), plain('b')]} onMove={() => {}} />
        </>
      );
    }
    render(<Declining />);
    fireEvent.click(screen.getByTestId('reorder-down-a'));
    fireEvent.click(screen.getByTestId('bump'));
    expect(screen.getByRole('status').textContent).toBe('');
    // Focus is left exactly where the caller put it, not yanked onto the un-moved row.
    expect(document.activeElement).toBe(document.body);
  });

  it('mounts the live region up front so the first announcement is spoken', () => {
    // Screen readers only watch regions that already existed — the container must pre-exist
    // and only its content change.
    renderList();
    expect(screen.getByRole('status')).not.toBeNull();
  });
});
