import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { Tooltip } from './tooltip';

afterEach(cleanup);

describe('Tooltip', () => {
  it('is hidden until hovered, then shows rendered markdown', async () => {
    render(
      <Tooltip content="Storage is **estimated** by the browser.">
        <span>info</span>
      </Tooltip>,
    );
    expect(screen.queryByRole('tooltip')).toBeNull();

    fireEvent.mouseEnter(screen.getByText('info'));
    const tip = await screen.findByRole('tooltip');
    expect(tip).toBeInTheDocument();
    expect(tip.querySelector('strong')?.textContent).toBe('estimated');
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
    await screen.findByRole('tooltip');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  });
});
