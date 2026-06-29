import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { Tooltip } from './tooltip';

afterEach(cleanup);

describe('Tooltip', () => {
  it('is hidden until hovered, then shows rendered markdown after the open delay', async () => {
    render(
      <Tooltip content="Storage is **estimated** by the browser.">
        <span>info</span>
      </Tooltip>,
    );
    expect(screen.queryByRole('tooltip')).toBeNull();

    fireEvent.mouseEnter(screen.getByText('info'));
    // Hover open is delayed, so it must not appear synchronously on enter.
    expect(screen.queryByRole('tooltip')).toBeNull();

    const tip = await screen.findByRole('tooltip', {}, { timeout: 2000 });
    expect(tip).toBeInTheDocument();
    expect(tip.querySelector('strong')?.textContent).toBe('estimated');
  });

  it('cancels the delayed open if the pointer leaves before the delay elapses', async () => {
    render(
      <Tooltip content="Should never appear.">
        <span>info</span>
      </Tooltip>,
    );
    const trigger = screen.getByText('info');
    fireEvent.mouseEnter(trigger);
    fireEvent.mouseLeave(trigger);

    // Wait past the open delay; the cancelled timer must not have opened it.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('opens immediately on keyboard focus (no hover delay)', async () => {
    render(
      <Tooltip content="Focus is immediate.">
        <span>focusable</span>
      </Tooltip>,
    );
    fireEvent.focus(screen.getByText('focusable').parentElement!);
    // Present right away, before any delay could elapse.
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
  });

  it('does not open on the focus that follows a pointer press (so the click is never stolen)', async () => {
    render(
      <Tooltip content="Should not pop on a mouse click.">
        <button type="button">toggle</button>
      </Tooltip>,
    );
    const trigger = screen.getByText('toggle').parentElement!;
    // Mouse press → focus, exactly as a real click does. The bubble must stay shut;
    // otherwise it can render over the trigger and steal the mouse-up.
    fireEvent.pointerDown(trigger, { pointerType: 'mouse' });
    fireEvent.focus(trigger);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('shows on keyboard focus and links the trigger via aria-describedby', async () => {
    render(
      <Tooltip content="Helpful text.">
        <span>trigger</span>
      </Tooltip>,
    );
    const trigger = screen.getByText('trigger').parentElement!;
    fireEvent.focus(trigger);
    const tip = await screen.findByRole('tooltip');
    expect(trigger).toHaveAttribute('aria-describedby', tip.id);
  });

  it('closes on Escape', async () => {
    render(
      <Tooltip content="Closes on escape.">
        <span>x</span>
      </Tooltip>,
    );
    fireEvent.mouseEnter(screen.getByText('x'));
    await screen.findByRole('tooltip', {}, { timeout: 2000 });
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  });
});
