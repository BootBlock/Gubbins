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
