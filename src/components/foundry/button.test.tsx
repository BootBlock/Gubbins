import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

import { Button } from './button';
import { MenuAction } from './menu-action';

afterEach(cleanup);

describe('Button — the plain control', () => {
  it('renders a native button and fires onClick', () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);
    const btn = screen.getByRole('button', { name: 'Save' });
    expect(btn.tagName).toBe('BUTTON');
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('with `asChild`, styles the child element while keeping it its own tag', () => {
    render(
      <Button asChild variant="primary">
        <a href="/inventory">Open inventory</a>
      </Button>,
    );
    const link = screen.getByRole('link', { name: 'Open inventory' });
    // Still an anchor (navigable), now wearing the primary variant styling.
    expect(link.tagName).toBe('A');
    expect(link.className).toContain('bg-primary');
    // No standalone chevron trigger when there is no menu.
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('Button — split button (primary action fused to a dropdown, spec §2.4.1)', () => {
  it('runs the primary action without opening the menu', () => {
    const onPrimary = vi.fn();
    render(
      <Button
        onClick={onPrimary}
        menuLabel="More add-item actions"
        menu={<MenuAction onSelect={() => {}}>Import…</MenuAction>}
      >
        Add item
      </Button>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add item' }));
    expect(onPrimary).toHaveBeenCalledTimes(1);
    // The menu stays shut — the secondary action is not in the tree.
    expect(screen.queryByRole('menuitem')).toBeNull();
  });

  it('squares off the primary’s inner edge so both halves read as one pill', () => {
    render(
      <Button menuLabel="More add-item actions" menu={<MenuAction onSelect={() => {}}>Import…</MenuAction>}>
        Add item
      </Button>,
    );
    expect(screen.getByRole('button', { name: 'Add item' }).className).toContain('rounded-r-none');
  });

  it('opens the labelled dropdown from the attached chevron and runs a secondary action', () => {
    const onImport = vi.fn();
    render(
      <Button
        menuLabel="More add-item actions"
        menuTriggerProps={{ 'data-testid': 'add-menu' }}
        menu={
          <MenuAction onSelect={onImport} data-testid="import">
            Import…
          </MenuAction>
        }
      >
        Add item
      </Button>,
    );
    const trigger = screen.getByRole('button', { name: 'More add-item actions' });
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    fireEvent.click(screen.getByTestId('add-menu'));
    expect(screen.getByRole('menu', { name: 'More add-item actions' })).toBeTruthy();
    fireEvent.click(screen.getByTestId('import'));
    expect(onImport).toHaveBeenCalledTimes(1);
  });

  it('supports a `Link`-style anchor primary via `asChild`', () => {
    render(
      <Button
        asChild
        menuLabel="More add-item actions"
        menu={<MenuAction onSelect={() => {}}>Import…</MenuAction>}
      >
        <a href="/inventory">Add item</a>
      </Button>,
    );
    const primary = screen.getByRole('link', { name: 'Add item' });
    expect(primary.tagName).toBe('A');
    expect(primary.className).toContain('rounded-r-none');
    // The chevron trigger is still a real button beside the anchor primary.
    expect(screen.getByRole('button', { name: 'More add-item actions' })).toBeTruthy();
  });
});
