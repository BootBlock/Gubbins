import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { Tooltip } from './tooltip';

afterEach(cleanup);

/** A mouse hover enter — the only pointer type that opens the tooltip on dwell. */
function mouseEnter(el: Element) {
  fireEvent.pointerEnter(el, { pointerType: 'mouse' });
}
function mouseLeave(el: Element) {
  fireEvent.pointerLeave(el, { pointerType: 'mouse' });
}

describe('Tooltip', () => {
  it('is hidden until hovered, then shows rendered markdown after the open delay', async () => {
    render(
      <Tooltip content="Storage is **estimated** by the browser.">
        <span>info</span>
      </Tooltip>,
    );
    expect(screen.queryByRole('tooltip')).toBeNull();

    mouseEnter(screen.getByText('info'));
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
    mouseEnter(trigger);
    mouseLeave(trigger);

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

  it('wraps content in a vertical scroll region so tall help never overflows the viewport', async () => {
    render(
      <Tooltip content="Lots of documentation.">
        <span>info</span>
      </Tooltip>,
    );
    fireEvent.focus(screen.getByText('info').parentElement!);
    const tip = await screen.findByRole('tooltip');
    const scroller = tip.querySelector('.overflow-y-auto');
    expect(scroller).not.toBeNull();
    expect(scroller?.textContent).toContain('Lots of documentation.');
  });

  it('fades the scroll edges only where there is off-screen content', async () => {
    render(
      <Tooltip content="Lots and lots of documentation that overflows.">
        <span>info</span>
      </Tooltip>,
    );
    fireEvent.focus(screen.getByText('info').parentElement!);
    const tip = await screen.findByRole('tooltip');
    const scroller = tip.querySelector('.overflow-y-auto') as HTMLElement;

    // happy-dom reports zero layout, so the region starts un-masked (nothing to scroll).
    expect(scroller.style.maskImage).toBeFalsy();

    // Simulate an overflowing region scrolled to the middle: both edges should fade.
    Object.defineProperty(scroller, 'scrollHeight', { value: 500, configurable: true });
    Object.defineProperty(scroller, 'clientHeight', { value: 200, configurable: true });
    Object.defineProperty(scroller, 'scrollTop', { value: 100, configurable: true });
    fireEvent.scroll(scroller);
    expect(scroller.style.maskImage).toContain('linear-gradient');
    expect(scroller.style.maskImage).toContain('transparent');
  });

  it('gives a larger size tier a firm width so tables get room', async () => {
    render(
      <Tooltip content="Wide table content." size="lg">
        <span>info</span>
      </Tooltip>,
    );
    fireEvent.focus(screen.getByText('info').parentElement!);
    const tip = await screen.findByRole('tooltip');
    // `lg` takes a firm width (clamped to the viewport) rather than a max-width ceiling the
    // content would never reach, so a table is not squeezed to the intro line's width.
    expect(tip.className).toContain('w-[28rem]');
    expect(tip.className).toContain('max-w-[calc(100vw-1rem)]');
  });

  it('closes on Escape', async () => {
    render(
      <Tooltip content="Closes on escape.">
        <span>x</span>
      </Tooltip>,
    );
    mouseEnter(screen.getByText('x'));
    await screen.findByRole('tooltip', {}, { timeout: 2000 });
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  });

  it('does not open on a synthesised touch pointer-enter (no sticky-hover bubble)', async () => {
    render(
      <Tooltip content="Should never appear on touch hover.">
        <span>info</span>
      </Tooltip>,
    );
    // A tap on touch synthesises pointerenter; it must not schedule the hover open, else
    // the bubble pops up over the control the finger just pressed.
    fireEvent.pointerEnter(screen.getByText('info'), { pointerType: 'touch' });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('lets a touch tap flow through a control-wrapping trigger without opening the bubble', () => {
    let clicks = 0;
    render(
      <Tooltip content="Supplementary help for a real control.">
        <button type="button" onClick={() => (clicks += 1)}>
          Toggle
        </button>
      </Tooltip>,
    );
    const button = screen.getByRole('button', { name: 'Toggle' });
    // A tap on a trigger that wraps its own <button> belongs to the button: the tooltip must
    // stay shut so it can't cover the control and swallow the tap.
    fireEvent.pointerDown(button, { pointerType: 'touch' });
    fireEvent.click(button);
    expect(clicks).toBe(1);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('opens on a touch tap of a passive help badge (its only route to the help)', async () => {
    render(
      <Tooltip content="What this pill means.">
        <span>badge</span>
      </Tooltip>,
    );
    // A passive trigger with no interactive descendant is a help affordance; tapping it is
    // the only way to reach its tooltip on a touch device, so it toggles open.
    fireEvent.pointerDown(screen.getByText('badge'), { pointerType: 'touch' });
    expect(await screen.findByRole('tooltip')).toBeInTheDocument();
  });

  it('honours an explicit openOnTap=false even on a passive trigger', () => {
    render(
      <Tooltip content="Never on tap." openOnTap={false}>
        <span>badge</span>
      </Tooltip>,
    );
    fireEvent.pointerDown(screen.getByText('badge'), { pointerType: 'touch' });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
