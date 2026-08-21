import { useRef, useState } from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { Modal } from './modal';
import { useReportUnsavedChanges } from './unsaved-changes';
import { useDialogIsBusy, useReportDialogBusy } from './dialog-busy';

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
    // The panel (Surface) is a flex column with a viewport-relative max height (less the
    // frame's gutter and the device's own safe-area insets), so an over-tall dialog can
    // never overflow the screen and strand its footer.
    const panel = screen.getByRole('heading', { name: 'Edit location' }).closest('div')
      ?.parentElement?.parentElement;
    expect(panel?.className).toContain('flex');
    expect(panel?.className).toContain('flex-col');
    expect(panel?.className).toContain('max-h-safe-dialog');

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

describe('Modal — guarding unsaved work on dismissal (#576)', () => {
  /** Stands in for a facet editor holding a draft: it reports, and renders nothing itself. */
  function Editor({ unsaved, label }: { unsaved: boolean; label: string }) {
    useReportUnsavedChanges(unsaved);
    return <span>{label}</span>;
  }

  /**
   * A dialog that really unmounts on close, holding one editor whose draft can be saved (the
   * editor stops reporting) or torn down (it unmounts) from inside the dialog — the two ways a
   * dirty dialog becomes clean in the app.
   */
  function Harness({ initiallyUnsaved = true }: { initiallyUnsaved?: boolean }) {
    const [open, setOpen] = useState(true);
    const [unsaved, setUnsaved] = useState(initiallyUnsaved);
    const [mounted, setMounted] = useState(true);
    return (
      <Modal open={open} onClose={() => setOpen(false)} title="Item details">
        {mounted ? <Editor unsaved={unsaved} label="Draft" /> : null}
        <button onClick={() => setUnsaved(false)}>Save details</button>
        <button onClick={() => setMounted(false)}>Unmount editor</button>
      </Modal>
    );
  }

  const prompt = () => screen.queryByRole('dialog', { name: 'Discard unsaved changes?' });
  const itemDialog = () => screen.queryByRole('dialog', { name: 'Item details' });
  /** The backdrop is the dialog container's first child — the dimmed layer behind the panel. */
  const backdropOf = (dialog: Element) => dialog.firstElementChild!;

  it('asks before Escape throws a draft away, leaving the dialog and its work up', async () => {
    render(<Harness />);
    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => expect(prompt()).not.toBeNull());
    // The editor is still mounted behind the question, so nothing has been lost yet.
    expect(itemDialog()).not.toBeNull();
    expect(screen.getByText('Draft')).toBeTruthy();
  });

  it('keeps the work when the question is answered "Keep editing"', async () => {
    render(<Harness />);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(prompt()).not.toBeNull());

    fireEvent.click(screen.getByTestId('unsaved-keep-editing'));
    await waitFor(() => expect(prompt()).toBeNull());
    expect(itemDialog()).not.toBeNull();
  });

  it('closes the dialog only once the discard is confirmed', async () => {
    render(<Harness />);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(prompt()).not.toBeNull());

    fireEvent.click(screen.getByTestId('unsaved-discard'));
    await waitFor(() => expect(itemDialog()).toBeNull());
    expect(prompt()).toBeNull();
  });

  it('dismissing the question itself keeps the draft, rather than answering "discard"', async () => {
    render(<Harness />);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(prompt()).not.toBeNull());

    // Escape again is aimed at the question (the topmost dialog), and the safe reading of it
    // is "leave me alone" — not "yes, throw the work away".
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(prompt()).toBeNull());
    expect(itemDialog()).not.toBeNull();
  });

  it('asks on the Close button too, not just Escape', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    await waitFor(() => expect(prompt()).not.toBeNull());
    expect(itemDialog()).not.toBeNull();
  });

  it('asks on a backdrop tap too', async () => {
    render(<Harness />);
    const backdrop = backdropOf(itemDialog()!);
    const pointer = { pointerId: 1, isPrimary: true, button: 0 };
    fireEvent.pointerDown(backdrop, pointer);
    fireEvent.pointerUp(backdrop, pointer);
    fireEvent.click(backdrop, { ...pointer, detail: 1 });

    await waitFor(() => expect(prompt()).not.toBeNull());
    expect(itemDialog()).not.toBeNull();
  });

  it('closes straight away when nothing inside reports unsaved work', async () => {
    render(<Harness initiallyUnsaved={false} />);
    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => expect(itemDialog()).toBeNull());
    expect(prompt()).toBeNull();
  });

  it('stops asking once the editor reports the draft saved', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Save details' }));

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(itemDialog()).toBeNull());
    expect(prompt()).toBeNull();
  });

  it('retracts an editor’s report when it unmounts, so a stale draft never wedges the dialog', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Unmount editor' }));

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(itemDialog()).toBeNull());
    expect(prompt()).toBeNull();
  });

  it('counts every editor separately, so one clean editor cannot speak for a dirty one', async () => {
    function TwoEditors() {
      const [open, setOpen] = useState(true);
      const [firstUnsaved, setFirstUnsaved] = useState(true);
      return (
        <Modal open={open} onClose={() => setOpen(false)} title="Item details">
          <Editor unsaved={firstUnsaved} label="First" />
          <Editor unsaved={false} label="Second" />
          <button onClick={() => setFirstUnsaved(false)}>Save first</button>
        </Modal>
      );
    }
    render(<TwoEditors />);

    // The clean second editor reported first-and-last on mount; that must not clear the
    // first editor's report, which is what a shared boolean would have done.
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(prompt()).not.toBeNull());
    fireEvent.click(screen.getByTestId('unsaved-keep-editing'));
    await waitFor(() => expect(prompt()).toBeNull());

    // With the only dirty editor saved, the dialog closes without a question.
    fireEvent.click(screen.getByRole('button', { name: 'Save first' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(itemDialog()).toBeNull());
  });
});

describe('Modal — refusing a dismissal while work is in flight (#654)', () => {
  const dialog = () => screen.queryByRole('dialog', { name: 'Restore backup' });
  const closeButton = () => screen.getByRole('button', { name: 'Close' });
  const announcement = () => screen.queryByTestId('dialog-dismiss-blocked')?.textContent ?? null;
  const start = () => fireEvent.click(screen.getByRole('button', { name: 'Start' }));
  const finish = () => fireEvent.click(screen.getByRole('button', { name: 'Finish' }));

  /** Press → release → click on the backdrop, the gesture `backdrop-dismiss.ts` acts on. */
  function tapBackdrop() {
    const backdrop = dialog()!.firstElementChild!;
    const pointer = { pointerId: 1, isPrimary: true, button: 0 };
    fireEvent.pointerDown(backdrop, pointer);
    fireEvent.pointerUp(backdrop, pointer);
    fireEvent.click(backdrop, { ...pointer, detail: 1 });
  }

  /** A dialog that really unmounts on close, driving the frame's own `busy` prop. */
  function PropHarness() {
    const [open, setOpen] = useState(true);
    const [busy, setBusy] = useState(false);
    return (
      <Modal open={open} onClose={() => setOpen(false)} title="Restore backup" busy={busy}>
        <button onClick={() => setBusy(true)}>Start</button>
        <button onClick={() => setBusy(false)}>Finish</button>
      </Modal>
    );
  }

  /** Stands in for a panel below the frame — the restore panel, the import workbench. */
  function Panel({ busy }: { busy: boolean }) {
    useReportDialogBusy(busy);
    return <span>Working: {String(busy)}</span>;
  }

  /** The same dialog, but with the flag held in a descendant that reports it upward. */
  function ReportingHarness() {
    const [open, setOpen] = useState(true);
    const [busy, setBusy] = useState(false);
    const [mounted, setMounted] = useState(true);
    return (
      <Modal open={open} onClose={() => setOpen(false)} title="Restore backup">
        {mounted ? <Panel busy={busy} /> : null}
        <button onClick={() => setBusy(true)}>Start</button>
        <button onClick={() => setBusy(false)}>Finish</button>
        <button onClick={() => setMounted(false)}>Unmount panel</button>
      </Modal>
    );
  }

  it('refuses Escape while the work is running, and obeys it once the work lands', async () => {
    render(<PropHarness />);
    start();

    fireEvent.keyDown(document, { key: 'Escape' });
    // Still up: the operation is not tied to this component, so closing would only hide it.
    expect(dialog()).not.toBeNull();

    finish();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(dialog()).toBeNull());
  });

  it('refuses a backdrop tap while the work is running', async () => {
    render(<PropHarness />);
    start();

    tapBackdrop();
    expect(dialog()).not.toBeNull();

    finish();
    tapBackdrop();
    await waitFor(() => expect(dialog()).toBeNull());
  });

  it('disables the ✕ while the work is running, so the refusal is visible before it is pressed', () => {
    render(<PropHarness />);
    expect(closeButton()).not.toBeDisabled();

    start();
    expect(closeButton()).toBeDisabled();

    finish();
    expect(closeButton()).not.toBeDisabled();
  });

  it('says why a refused dismissal did nothing, rather than leaving Escape a dead key', async () => {
    render(<PropHarness />);
    // An idle dialog carries no region of its own, so it never crowds the announcements its own
    // body makes.
    expect(announcement()).toBeNull();

    // It appears — empty — as soon as there is something to refuse, which is a commit ahead of
    // any refusal: a region inserted along with its message is often never announced.
    start();
    expect(announcement()).toBe('');

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(announcement()).toContain('can’t be closed'));

    // And it goes away again the moment leaving is allowed.
    finish();
    await waitFor(() => expect(announcement()).toBeNull());
  });

  it('starts each spell of work silent, so a second one never re-speaks the first’s refusal', async () => {
    // Several dialogs run one operation after another behind a single opening — each maintenance
    // task, a backup and then a restore. A refusal counted during the first would put the message
    // into the region at the instant the second mounts it: a refusal nobody made, announced by a
    // region that came into existence already holding it.
    render(<PropHarness />);
    start();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(announcement()).toContain('can’t be closed'));
    finish();

    start();
    expect(announcement()).toBe('');
  });

  it('pulls focus back inside when work starts with nothing in the dialog focused', () => {
    render(<PropHarness />);
    // What a browser leaves behind when the control under the user's finger is disabled: it
    // blurs the element, dropping focus to <body> — outside the dialog, outside its Tab trap,
    // and nowhere a screen reader can describe. Reproduced directly, because the test DOM does
    // not blur a focused element on `disabled` the way a real browser does, so pressing the ✕
    // and going busy would leave focus exactly where it started and assert nothing.
    closeButton().focus();
    (document.activeElement as HTMLElement).blur();
    expect(dialog()!.contains(document.activeElement)).toBe(false);

    start();
    expect(document.activeElement).toBe(dialog());
  });

  it('holds the frame for a panel below it, which is where the flag usually lives', async () => {
    render(<ReportingHarness />);
    start();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(dialog()).not.toBeNull();
    expect(closeButton()).toBeDisabled();

    finish();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(dialog()).toBeNull());
  });

  it('retracts a panel’s report when it unmounts, so nothing can wedge the dialog shut', async () => {
    render(<ReportingHarness />);
    start();
    fireEvent.click(screen.getByRole('button', { name: 'Unmount panel' }));

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(dialog()).toBeNull());
  });

  it('publishes the answer to controls inside the dialog, so a tab rail agrees with the frame', () => {
    // A rail that swapped panels mid-operation would unmount the one holding the work as
    // surely as closing the dialog would, so it reads the frame's answer rather than its own.
    function RailHarness() {
      const [busy, setBusy] = useState(false);
      return (
        <Modal open onClose={() => {}} title="Restore backup" busy={busy}>
          <Tab />
          <button onClick={() => setBusy(true)}>Start</button>
          <button onClick={() => setBusy(false)}>Finish</button>
        </Modal>
      );
    }
    function Tab() {
      const busy = useDialogIsBusy();
      return (
        <button role="tab" disabled={busy}>
          Create backup
        </button>
      );
    }
    render(<RailHarness />);
    const tab = screen.getByRole('tab', { name: 'Create backup' });
    expect(tab).not.toBeDisabled();

    start();
    expect(tab).toBeDisabled();

    finish();
    expect(tab).not.toBeDisabled();
  });

  it('refuses outright rather than offering to discard, when the dialog is also holding a draft', async () => {
    function DirtyAndBusy() {
      const [open, setOpen] = useState(true);
      const [busy, setBusy] = useState(false);
      return (
        <Modal open={open} onClose={() => setOpen(false)} title="Restore backup" busy={busy}>
          <Draft />
          <button onClick={() => setBusy(true)}>Start</button>
          <button onClick={() => setBusy(false)}>Finish</button>
        </Modal>
      );
    }
    function Draft() {
      useReportUnsavedChanges(true);
      return <span>Draft</span>;
    }
    render(<DirtyAndBusy />);
    start();

    fireEvent.keyDown(document, { key: 'Escape' });
    // "Discard" is an answer the frame could not honour — it would not stop the work, only
    // hide the outcome — so the question is never asked while something is running.
    await waitFor(() => expect(announcement()).toContain('can’t be closed'));
    expect(screen.queryByRole('dialog', { name: 'Discard unsaved changes?' })).toBeNull();
    expect(dialog()).not.toBeNull();

    // Once the work lands the ordinary unsaved-work guard takes over again.
    finish();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Discard unsaved changes?' })).not.toBeNull(),
    );
  });
});
