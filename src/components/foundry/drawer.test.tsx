/**
 * Component tests for the Foundry {@link Drawer} (issue #147).
 *
 * The drawer holds a master pane that no longer fits beside its detail pane, so its job is to
 * stay a *fully* modal dialog while it is open — every route out (Escape, backdrop, Close) has
 * to work, and it has to stack correctly with the dialogs its content opens. The focus/Escape
 * machinery is shared with {@link Modal} via `useDialogBehaviour`, so this suite covers the
 * drawer's own contract plus enough of that shared contract to catch a regression in the
 * extraction itself.
 */
import { useState } from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { Drawer } from './drawer';
import { Modal } from './modal';

afterEach(cleanup);

describe('Drawer — dialog semantics', () => {
  it('renders nothing while closed', () => {
    render(
      <Drawer open={false} onClose={() => {}} title="Locations">
        <p>Tree</p>
      </Drawer>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('is a modal dialog named by its title, with the title also shown as its heading', () => {
    render(
      <Drawer open onClose={() => {}} title="Locations">
        <p>Tree</p>
      </Drawer>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Locations' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(screen.getByRole('heading', { name: 'Locations' })).toBeTruthy();
  });

  it('parks initial focus on the container so the drawer is announced', () => {
    render(
      <Drawer open onClose={() => {}} title="Locations">
        <button>Shelf A</button>
      </Drawer>,
    );
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
  });
});

describe('Drawer — every route out works', () => {
  /** One end of a pointer gesture, as a real pointing device reports it. */
  const POINTER = { pointerId: 1, isPrimary: true, button: 0 };

  /** Renders a drawer that actually unmounts on close, so we assert the real user outcome. */
  function Harness() {
    const [open, setOpen] = useState(true);
    return (
      <Drawer open={open} onClose={() => setOpen(false)} title="Locations">
        <button>Shelf A</button>
      </Drawer>
    );
  }

  it('closes on Escape', async () => {
    render(<Harness />);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('closes on the Close button', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('closes on a backdrop tap — the gesture a phone user reaches for first', async () => {
    render(<Harness />);
    const backdrop = screen.getByRole('dialog').firstElementChild;
    expect(backdrop).toBeTruthy();
    fireEvent.pointerDown(backdrop!, POINTER);
    fireEvent.pointerUp(backdrop!, POINTER);
    fireEvent.click(backdrop!, POINTER);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('closes on a backdrop tap that rolls onto the panel as the finger lifts (#614)', async () => {
    // The strip of backdrop left beside the panel is the whole tap target on a phone, so a tap
    // that ends a few pixels inside the panel still has to dismiss — the browser dispatches
    // that click on the container, where a backdrop-only handler never saw it.
    render(<Harness />);
    const dialog = screen.getByRole('dialog');
    fireEvent.pointerDown(dialog.firstElementChild!, POINTER);
    fireEvent.pointerUp(screen.getByRole('button', { name: 'Shelf A' }), POINTER);
    fireEvent.click(dialog, POINTER);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('Drawer — shares the modal stack with Modal', () => {
  /**
   * The drawer, with the "New location" dialog its content can open on top. The nested dialog
   * mounts on demand rather than up front, which is both what the screen does and what the LIFO
   * stack requires: React runs child effects before parent ones, so a dialog rendered in the
   * same commit as its parent would register *underneath* it.
   */
  function Stack() {
    const [drawerOpen, setDrawerOpen] = useState(true);
    const [modalOpen, setModalOpen] = useState(false);
    return (
      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} title="Locations">
        <button onClick={() => setModalOpen(true)}>Add location</button>
        {modalOpen ? (
          <Modal open onClose={() => setModalOpen(false)} title="New location">
            <button>Create</button>
          </Modal>
        ) : null}
      </Drawer>
    );
  }

  it('Escape closes a dialog opened from the drawer first, leaving the drawer open', async () => {
    render(<Stack />);
    fireEvent.click(screen.getByRole('button', { name: 'Add location' }));
    expect(screen.getByRole('dialog', { name: 'New location' })).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New location' })).toBeNull());
    // The drawer beneath survives — one Escape must not collapse the whole stack.
    expect(screen.getByRole('dialog', { name: 'Locations' })).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Locations' })).toBeNull());
  });

  it('keeps the body scroll lock while the drawer is still open beneath a nested dialog', async () => {
    render(<Stack />);
    fireEvent.click(screen.getByRole('button', { name: 'Add location' }));
    expect(document.body.style.overflow).toBe('hidden');

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New location' })).toBeNull());
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('restores focus to the trigger that opened it', async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Locations</button>
          <Drawer open={open} onClose={() => setOpen(false)} title="Locations">
            <button>Shelf A</button>
          </Drawer>
        </>
      );
    }
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Locations' });
    trigger.focus();
    fireEvent.click(trigger);
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
