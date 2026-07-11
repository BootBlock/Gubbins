import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...props }: { children: React.ReactNode; to: string; [k: string]: unknown }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

import { Menu, MenuLink, MenuAction, MenuSeparator, MenuSub } from './menu';

afterEach(cleanup);

function open() {
  fireEvent.click(screen.getByRole('button', { name: 'Navigation' }));
}

describe('Menu — accessible menu button (spec §2.4.1)', () => {
  it('the trigger advertises a menu popup and toggles aria-expanded', () => {
    render(
      <Menu label="Navigation" trigger={<span>Menu</span>}>
        <MenuLink to="/inventory">Inventory</MenuLink>
      </Menu>,
    );
    const trigger = screen.getByRole('button', { name: 'Navigation' });
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
  });

  it('opens on click, renders items, and moves focus to the first item', () => {
    render(
      <Menu label="Navigation" trigger={<span>Menu</span>}>
        <MenuLink to="/inventory">Inventory</MenuLink>
        <MenuSeparator />
        <MenuLink to="/about">About</MenuLink>
      </Menu>,
    );
    open();
    expect(screen.getByRole('menu', { name: 'Navigation' })).toBeTruthy();
    const items = screen.getAllByRole('menuitem');
    expect(items).toHaveLength(2);
    expect(document.activeElement).toBe(items[0]);
  });

  it('ArrowDown/ArrowUp roam the items with wrap-around', () => {
    render(
      <Menu label="Navigation" trigger={<span>Menu</span>}>
        <MenuLink to="/a">A</MenuLink>
        <MenuLink to="/b">B</MenuLink>
      </Menu>,
    );
    open();
    const [a, b] = screen.getAllByRole('menuitem');
    const menu = screen.getByRole('menu');
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(b);
    fireEvent.keyDown(menu, { key: 'ArrowDown' }); // wraps
    expect(document.activeElement).toBe(a);
    fireEvent.keyDown(menu, { key: 'ArrowUp' }); // wraps back
    expect(document.activeElement).toBe(b);
  });

  it('Escape closes the menu and returns focus to the trigger', () => {
    render(
      <Menu label="Navigation" trigger={<span>Menu</span>}>
        <MenuLink to="/inventory">Inventory</MenuLink>
      </Menu>,
    );
    open();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Navigation' }));
  });

  it('a pointer-press outside dismisses the menu', () => {
    render(
      <>
        <Menu label="Navigation" trigger={<span>Menu</span>}>
          <MenuLink to="/inventory">Inventory</MenuLink>
        </Menu>
        <button type="button">elsewhere</button>
      </>,
    );
    open();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'elsewhere' }));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('MenuAction runs onSelect then closes; a disabled row does neither', () => {
    const onSelect = vi.fn();
    const onDisabled = vi.fn();
    render(
      <Menu label="Navigation" trigger={<span>Menu</span>}>
        <MenuAction onSelect={onSelect}>Export</MenuAction>
        <MenuAction onSelect={onDisabled} disabled>
          Import
        </MenuAction>
      </Menu>,
    );
    open();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Export' }));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).toBeNull();

    open();
    fireEvent.click(screen.getByText('Import'));
    expect(onDisabled).not.toHaveBeenCalled();
  });

  it('a disabled action is excluded from keyboard roaming', () => {
    render(
      <Menu label="Navigation" trigger={<span>Menu</span>}>
        <MenuAction onSelect={() => {}}>One</MenuAction>
        <MenuAction onSelect={() => {}} disabled>
          Two
        </MenuAction>
      </Menu>,
    );
    open();
    const menu = screen.getByRole('menu');
    // Only "One" is roamable, so ArrowDown wraps straight back to it.
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByText('One').closest('[role="menuitem"]'));
  });

  it('Tab closes the menu and returns focus to the trigger', () => {
    render(
      <Menu label="Navigation" trigger={<span>Menu</span>}>
        <MenuLink to="/inventory">Inventory</MenuLink>
      </Menu>,
    );
    open();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Tab' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Navigation' }));
  });
});

describe('MenuSub — nested submenu (issue #31)', () => {
  function renderWithSub(onCards = vi.fn(), onRows = vi.fn()) {
    render(
      <Menu label="Navigation" trigger={<span>Menu</span>}>
        <MenuAction onSelect={() => {}}>Top action</MenuAction>
        <MenuSub label="View">
          <MenuAction onSelect={onCards}>Cards</MenuAction>
          <MenuAction onSelect={onRows}>Rows</MenuAction>
        </MenuSub>
        <MenuSub label="Group by">
          <MenuAction onSelect={() => {}}>None</MenuAction>
          <MenuAction onSelect={() => {}}>Location</MenuAction>
        </MenuSub>
      </Menu>,
    );
    open();
  }

  it('the submenu trigger advertises a nested menu popup, collapsed until opened', () => {
    renderWithSub();
    const trigger = screen.getByRole('menuitem', { name: 'View' });
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('menuitem', { name: 'Cards' })).toBeNull();
  });

  it('opens the flyout on click and moves focus to its first item', () => {
    renderWithSub();
    fireEvent.click(screen.getByRole('menuitem', { name: 'View' }));
    const cards = screen.getByRole('menuitem', { name: 'Cards' });
    expect(cards).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'View' }).getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(cards);
  });

  it('ArrowRight opens the flyout; ArrowLeft closes it and returns focus to the trigger', () => {
    renderWithSub();
    const trigger = screen.getByRole('menuitem', { name: 'View' });
    fireEvent.keyDown(trigger, { key: 'ArrowRight' });
    const cards = screen.getByRole('menuitem', { name: 'Cards' });
    expect(document.activeElement).toBe(cards);
    // ArrowLeft on the flyout peels it back off, focus returns to the trigger row.
    fireEvent.keyDown(cards.closest('[role="menu"]')!, { key: 'ArrowLeft' });
    expect(screen.queryByRole('menuitem', { name: 'Cards' })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('selecting a flyout item runs its onSelect and closes the whole menu', () => {
    const onCards = vi.fn();
    renderWithSub(onCards);
    fireEvent.click(screen.getByRole('menuitem', { name: 'View' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Cards' }));
    expect(onCards).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('Escape peels off the open flyout first, then a second Escape closes the root menu', () => {
    renderWithSub();
    fireEvent.click(screen.getByRole('menuitem', { name: 'View' }));
    expect(screen.getByRole('menuitem', { name: 'Cards' })).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    // Flyout gone, root still open (its top action is still there).
    expect(screen.queryByRole('menuitem', { name: 'Cards' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Top action' })).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opening a sibling flyout closes the first (only one is open at a time)', () => {
    renderWithSub();
    fireEvent.click(screen.getByRole('menuitem', { name: 'View' }));
    expect(screen.getByRole('menuitem', { name: 'Cards' })).toBeTruthy();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Group by' }));
    expect(screen.queryByRole('menuitem', { name: 'Cards' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Location' })).toBeTruthy();
  });

  it('hovering the trigger opens the flyout for pointer users', () => {
    renderWithSub();
    fireEvent.pointerEnter(screen.getByRole('menuitem', { name: 'View' }), { pointerType: 'mouse' });
    expect(screen.getByRole('menuitem', { name: 'Rows' })).toBeTruthy();
  });
});

describe('Menu — selected-icon rendering', () => {
  it('MenuAction renders its icon normally, but a check glyph in place of it when selected', () => {
    const { rerender } = render(
      <Menu label="Navigation" trigger={<span>Menu</span>}>
        <MenuAction onSelect={() => {}} icon={<svg data-testid="row-icon" />}>
          Select items
        </MenuAction>
      </Menu>,
    );
    open();
    expect(screen.getByTestId('row-icon')).toBeTruthy();

    // When the row's mode is on, the leading slot shows a check instead of the icon.
    rerender(
      <Menu label="Navigation" trigger={<span>Menu</span>}>
        <MenuAction onSelect={() => {}} icon={<svg data-testid="row-icon" />} selected>
          Select items
        </MenuAction>
      </Menu>,
    );
    expect(screen.queryByTestId('row-icon')).toBeNull();
  });
});
