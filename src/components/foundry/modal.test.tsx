import { useRef, useState } from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { Modal } from './modal';

afterEach(cleanup);

describe('Modal — accessible focus management', () => {
  it('moves focus into the dialog when it opens', () => {
    render(
      <Modal open onClose={() => {}} title="Settings">
        <button>Save</button>
      </Modal>,
    );
    // Initial focus parks on the dialog container so the title is announced.
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
  });

  it('moves initial focus to initialFocusRef when provided (type-first dialogs)', () => {
    function Harness() {
      const inputRef = useRef<HTMLInputElement>(null);
      return (
        <Modal open onClose={() => {}} title="Add location" initialFocusRef={inputRef}>
          <input ref={inputRef} aria-label="Name" />
        </Modal>
      );
    }
    render(<Harness />);
    // Focus lands directly in the Name field, ready to type — not on the container.
    expect(document.activeElement).toBe(screen.getByLabelText('Name'));
  });

  it('traps Tab within the dialog, wrapping off the last control to the first', () => {
    render(
      <Modal open onClose={() => {}} title="Settings">
        <button>First</button>
        <button>Last</button>
      </Modal>,
    );
    const close = screen.getByRole('button', { name: 'Close' });
    const last = screen.getByRole('button', { name: 'Last' });

    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    // Forward off the final control wraps back to the first focusable (Close).
    expect(document.activeElement).toBe(close);
  });

  it('traps Shift+Tab within the dialog, wrapping off the first control to the last', () => {
    render(
      <Modal open onClose={() => {}} title="Settings">
        <button>First</button>
        <button>Last</button>
      </Modal>,
    );
    const close = screen.getByRole('button', { name: 'Close' });
    const last = screen.getByRole('button', { name: 'Last' });

    close.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  // A nested dialog always opens *after* its parent is mounted (a control inside the
  // parent opens it), so these harnesses open it via a click — matching the real flow
  // the modal stack is ordered by.
  function StackHarness() {
    const [parentOpen, setParentOpen] = useState(true);
    const [nestedOpen, setNestedOpen] = useState(false);
    return (
      <Modal open={parentOpen} onClose={() => setParentOpen(false)} title="Add item">
        <button onClick={() => setNestedOpen(true)}>Open nested</button>
        {nestedOpen ? (
          <Modal open onClose={() => setNestedOpen(false)} title="Add location">
            <button>Nested control</button>
          </Modal>
        ) : null}
      </Modal>
    );
  }

  it('Escape closes only the topmost dialog of a stack, then the parent', async () => {
    render(<StackHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'Open nested' }));
    expect(screen.getByRole('dialog', { name: 'Add location' })).toBeTruthy();

    // First Escape dismisses the nested dialog — the parent (and whatever the user
    // typed into it) survives.
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add location' })).toBeNull());
    expect(screen.getByRole('dialog', { name: 'Add item' })).toBeTruthy();

    // A second Escape now reaches the parent.
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add item' })).toBeNull());
  });

  it('keeps the body scroll lock while a parent dialog remains open', async () => {
    render(<StackHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'Open nested' }));
    expect(document.body.style.overflow).toBe('hidden');

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add location' })).toBeNull());
    // The parent still holds the lock; only the last modal releases it.
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('restores focus to the opener when the dialog closes', async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Open</button>
          <Modal open={open} onClose={() => setOpen(false)} title="Settings">
            <button>Inside</button>
          </Modal>
        </>
      );
    }
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open' });
    opener.focus();
    fireEvent.click(opener);

    // Dialog took focus on open.
    expect(document.activeElement).toBe(screen.getByRole('dialog'));

    fireEvent.keyDown(document, { key: 'Escape' });
    // On close, focus returns to the control that opened it.
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
});
