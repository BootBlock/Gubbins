import { useRef, useState } from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { Modal } from './modal';

afterEach(cleanup);

// A nested dialog always opens *after* its parent is mounted (a control inside the parent
// opens it), so this harness opens it via a click — matching the real flow the modal stack is
// ordered by. Shared by the stack tests below, which cover both routes out of a stacked
// dialog: Escape and a backdrop tap.
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

  it('treats a roving-tabindex radiogroup as a single Tab stop (skips tabindex=-1 radios)', () => {
    render(
      <Modal open onClose={() => {}} title="Set up">
        <div role="radiogroup" aria-label="Presets">
          <button role="radio" aria-checked tabIndex={0}>
            A
          </button>
          <button role="radio" aria-checked={false} tabIndex={-1}>
            B
          </button>
          <button role="radio" aria-checked={false} tabIndex={-1}>
            C
          </button>
        </div>
        <button>Confirm</button>
      </Modal>,
    );
    const checkedRadio = screen.getByRole('radio', { name: 'A' });
    const confirm = screen.getByRole('button', { name: 'Confirm' });

    // Tab off the checked radio jumps straight to Confirm — the unchecked radios
    // (tabindex="-1") are not individual Tab stops, so the group is one stop.
    checkedRadio.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(confirm);
  });

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

  it('caps the panel height and scrolls the body internally so a tall footer stays reachable', () => {
    render(
      <Modal open onClose={() => {}} title="Edit location">
        <div>
          <p>Field</p>
          <button>Delete</button>
        </div>
      </Modal>,
    );
    // The panel (Surface) is a flex column with a viewport-relative max height, so an
    // over-tall dialog can never overflow the screen and strand its footer.
    const panel = screen.getByRole('heading', { name: 'Edit location' }).closest('div')
      ?.parentElement?.parentElement;
    expect(panel?.className).toContain('flex');
    expect(panel?.className).toContain('flex-col');
    expect(panel?.className).toContain('max-h-[calc(100dvh-2rem)]');

    // The header (title + Close) is a non-shrinking sibling of the scroll region — it stays
    // pinned while the body scrolls, rather than being wrapped by the scroller.
    const header = screen.getByRole('heading', { name: 'Edit location' }).closest('div')?.parentElement;
    expect(header?.className).toContain('shrink-0');

    // The children live in a distinct `dialog-scroll` region (overflow-y auto, with its
    // scrollbar bled into the Surface padding) whose min-h-0 lets it shrink below content
    // height so scrolling actually engages.
    const body = screen.getByText('Field').closest('div')?.parentElement;
    expect(body?.className).toContain('dialog-scroll');
    expect(body?.className).toContain('min-h-0');
    // …and that scroll region is a sibling of the header, not its ancestor.
    expect(body?.previousElementSibling).toBe(header);
  });

  it('lets a caller className override the default max-width (tailwind-merge)', () => {
    render(
      <Modal open onClose={() => {}} title="Wide" className="max-w-xl">
        <button>OK</button>
      </Modal>,
    );
    const panel = screen.getByRole('heading', { name: 'Wide' }).closest('div')?.parentElement?.parentElement;
    expect(panel?.className).toContain('max-w-xl');
    expect(panel?.className).not.toContain('max-w-lg');
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

describe('Modal — dismissing by tapping the backdrop (#614)', () => {
  /** A dialog that really unmounts on close, so each gesture is judged on the user's outcome. */
  function Harness() {
    const [open, setOpen] = useState(true);
    return (
      <Modal open={open} onClose={() => setOpen(false)} title="Add item">
        <input aria-label="Name" />
      </Modal>
    );
  }

  /** The backdrop is the dialog container's first child — the dimmed layer behind the panel. */
  function backdropOf(): Element {
    const backdrop = screen.getByRole('dialog').firstElementChild;
    expect(backdrop).toBeTruthy();
    return backdrop!;
  }

  /** One end of a pointer gesture, as a real pointing device reports it. */
  function pointer(overrides: Record<string, unknown> = {}) {
    return { pointerId: 1, isPrimary: true, button: 0, ...overrides };
  }

  /** A click a pointer actually made: `detail` counts the clicks of the press behind it. */
  const POINTER_CLICK = { detail: 1 };
  /** The click Enter or Space synthesises on a focused control — no press behind it. */
  const KEYBOARD_CLICK = { detail: 0 };

  /**
   * Play a full press → release → click, the way a browser dispatches one. The click lands on
   * the nearest common ancestor of the two ends, so a gesture that starts on the backdrop and
   * lifts on the panel is clicked on the *container* — which is the whole bug.
   */
  function gesture(press: Element, release: Element = press, init: Record<string, unknown> = {}) {
    const clickTarget = press === release ? press : screen.getByRole('dialog');
    fireEvent.pointerDown(press, pointer(init));
    fireEvent.pointerUp(release, pointer(init));
    fireEvent.click(clickTarget, { ...pointer(init), ...POINTER_CLICK });
  }

  it('closes on a tap that presses and releases on the backdrop', async () => {
    render(<Harness />);
    gesture(backdropOf());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('closes on a tap that rolls off the backdrop onto the panel as the finger lifts', async () => {
    render(<Harness />);
    gesture(backdropOf(), screen.getByLabelText('Name'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('stays open when a press inside the panel is dragged out onto the backdrop', async () => {
    // Selecting text in a field and releasing outside must not close the dialog under it.
    render(<Harness />);
    gesture(screen.getByLabelText('Name'), backdropOf());
    expect(screen.queryByRole('dialog')).not.toBeNull();
  });

  it('stays open when a click begins and ends inside the panel', async () => {
    render(<Harness />);
    gesture(screen.getByLabelText('Name'));
    expect(screen.queryByRole('dialog')).not.toBeNull();
  });

  it('does not let an abandoned press be cashed in by a later keyboard activation', async () => {
    // Press the backdrop and let go past the edge of the screen: the press is spent but no
    // click ever arrives for it. Activating a control with Enter afterwards synthesises a
    // click with no press behind it, and that must not collect the dismissal left lying there.
    render(<Harness />);
    fireEvent.pointerDown(backdropOf(), pointer());
    fireEvent.click(screen.getByLabelText('Name'), KEYBOARD_CLICK);
    expect(screen.queryByRole('dialog')).not.toBeNull();
  });

  it('does not let a right-press on the backdrop be cashed in by a later click', async () => {
    // A right-press opens the context menu and sends no click at all, so it would otherwise
    // sit armed for whatever click reached the dialog next.
    render(<Harness />);
    const backdrop = backdropOf();
    fireEvent.pointerDown(backdrop, pointer({ button: 2 }));
    fireEvent.pointerUp(backdrop, pointer({ button: 2 }));
    fireEvent.click(screen.getByLabelText('Name'), KEYBOARD_CLICK);
    expect(screen.queryByRole('dialog')).not.toBeNull();
  });

  it('ignores a non-primary pointer — the second finger of a pinch', async () => {
    render(<Harness />);
    const backdrop = backdropOf();
    gesture(backdrop, backdrop, { pointerId: 2, isPrimary: false });
    expect(screen.queryByRole('dialog')).not.toBeNull();
  });

  it('closes only the topmost dialog of a stack', async () => {
    render(<StackHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'Open nested' }));
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Add location' })).toBeTruthy());

    // The nested dialog's own backdrop covers its parent's, so a tap there dismisses it alone.
    const nestedBackdrop = screen.getByRole('dialog', { name: 'Add location' }).firstElementChild!;
    fireEvent.pointerDown(nestedBackdrop, pointer());
    fireEvent.pointerUp(nestedBackdrop, pointer());
    fireEvent.click(nestedBackdrop, { ...pointer(), ...POINTER_CLICK });

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add location' })).toBeNull());
    expect(screen.getByRole('dialog', { name: 'Add item' })).toBeTruthy();
  });
});
