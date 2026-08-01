import { useState } from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { RailModal, type RailTab } from './rail-modal';

afterEach(cleanup);

/**
 * A panel that holds a draft nobody has saved — the shape every facet editor in the item
 * dialog has, and the thing a tab switch used to destroy (#576). Uncontrolled on purpose:
 * the state lives *inside* the panel, so it can only survive if the panel does.
 */
function DraftPanel({ name }: { name: string }) {
  const [text, setText] = useState('');
  return <input aria-label={`${name} draft`} value={text} onChange={(e) => setText(e.target.value)} />;
}

const TABS: readonly RailTab[] = [
  { id: 'details', label: 'Details', icon: <span />, content: <DraftPanel name="Details" /> },
  { id: 'media', label: 'Media', icon: <span />, content: <DraftPanel name="Media" /> },
];

function Harness({ keepPanelsMounted = false }: { keepPanelsMounted?: boolean }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button onClick={() => setOpen(true)}>Reopen</button>
      <RailModal
        open={open}
        onClose={() => setOpen(false)}
        title="Item"
        railAriaLabel="Item sections"
        idPrefix="item"
        tabs={TABS}
        keepPanelsMounted={keepPanelsMounted}
      />
    </>
  );
}

const railTab = (label: string) => screen.getByRole('tab', { name: label });
const panelFor = (id: string) => document.getElementById(`item-panel-${id}`)!;

describe('RailModal — switching tabs', () => {
  it('unmounts the previous panel by default, so a rail owns no state it did not ask for', () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('Details draft'), { target: { value: 'NE555P' } });

    fireEvent.click(railTab('Media'));
    expect(screen.queryByLabelText('Details draft')).toBeNull();

    fireEvent.click(railTab('Details'));
    // Re-mounted from scratch — the historical behaviour, kept for panels that own a live
    // resource (a camera preview) and should stop when you leave them.
    expect(screen.getByLabelText<HTMLInputElement>('Details draft').value).toBe('');
  });

  it('keeps a visited panel’s draft across a trip to another tab and back (#576)', () => {
    render(<Harness keepPanelsMounted />);
    fireEvent.change(screen.getByLabelText('Details draft'), { target: { value: 'NE555P' } });

    fireEvent.click(railTab('Media'));
    fireEvent.click(railTab('Details'));

    expect(screen.getByLabelText<HTMLInputElement>('Details draft').value).toBe('NE555P');
  });

  it('hides the kept panel and marks it inert, so it neither shows nor swallows Tab', () => {
    render(<Harness keepPanelsMounted />);
    fireEvent.click(railTab('Media'));

    const details = panelFor('details');
    const media = panelFor('media');
    // Still in the tree (that is the point), but `display: none` and out of the focus trap —
    // `foundry/focus-trap` skips inert subtrees, so Tab never parks on an unreachable control.
    expect(details.className).toContain('hidden');
    expect(details.hasAttribute('inert')).toBe(true);
    expect(media.className).not.toContain('hidden');
    expect(media.hasAttribute('inert')).toBe(false);
  });

  it('mounts a panel on first visit rather than all of them up front', () => {
    render(<Harness keepPanelsMounted />);
    // Media has never been shown, so its content has never run.
    expect(screen.queryByLabelText('Media draft')).toBeNull();

    fireEvent.click(railTab('Media'));
    expect(screen.getByLabelText('Media draft')).not.toBeNull();
  });

  it('keeps each panel’s ARIA wiring pointing at its own rail tab', () => {
    render(<Harness keepPanelsMounted />);
    fireEvent.click(railTab('Media'));

    for (const id of ['details', 'media']) {
      expect(panelFor(id).getAttribute('aria-labelledby')).toBe(`item-tab-${id}`);
    }
    // Only the shown tab is selected, whatever else is still mounted behind it.
    expect(railTab('Media').getAttribute('aria-selected')).toBe('true');
    expect(railTab('Details').getAttribute('aria-selected')).toBe('false');
  });

  it('forgets what was visited when the dialog closes, so a reopen starts clean', () => {
    render(<Harness keepPanelsMounted />);
    fireEvent.change(screen.getByLabelText('Details draft'), { target: { value: 'NE555P' } });
    fireEvent.click(railTab('Media'));

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }));
    // The rail reopens on the section it was left on, and nothing else is carried over: a
    // reopened dialog is a fresh edit, and the previous one's draft must not still be in it.
    expect(screen.queryByLabelText('Details draft')).toBeNull();
    fireEvent.click(railTab('Details'));
    expect(screen.getByLabelText<HTMLInputElement>('Details draft').value).toBe('');
  });

  it('shows only the selected panel’s content to a reader of the visible dialog', () => {
    render(<Harness keepPanelsMounted />);
    fireEvent.click(railTab('Media'));

    // The Media panel is the one bearing content; Details is present but hidden, so a query
    // scoped to the shown panel finds exactly one draft field.
    expect(within(panelFor('media')).getByLabelText('Media draft')).not.toBeNull();
    expect(within(panelFor('media')).queryByLabelText('Details draft')).toBeNull();
  });
});
