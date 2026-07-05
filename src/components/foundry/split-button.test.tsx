import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

import { SplitButton } from './split-button';
import { Button } from './button';
import { MenuAction } from './menu';

afterEach(cleanup);

describe('SplitButton — primary action fused to a dropdown (spec §2.4.1)', () => {
  it('runs the primary action without opening the menu', () => {
    const onPrimary = vi.fn();
    render(
      <SplitButton menuLabel="More add-item actions" primary={<Button onClick={onPrimary}>Add item</Button>}>
        <MenuAction onSelect={() => {}}>Import…</MenuAction>
      </SplitButton>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add item' }));
    expect(onPrimary).toHaveBeenCalledTimes(1);
    // The menu stays shut — the secondary action is not in the tree.
    expect(screen.queryByRole('menuitem')).toBeNull();
  });

  it('squares off the primary’s inner edge so both halves read as one pill', () => {
    render(
      <SplitButton menuLabel="More add-item actions" primary={<Button>Add item</Button>}>
        <MenuAction onSelect={() => {}}>Import…</MenuAction>
      </SplitButton>,
    );
    expect(screen.getByRole('button', { name: 'Add item' }).className).toContain('rounded-r-none');
  });

  it('opens the labelled dropdown from the attached chevron and runs a secondary action', () => {
    const onImport = vi.fn();
    render(
      <SplitButton
        menuLabel="More add-item actions"
        triggerProps={{ 'data-testid': 'add-menu' }}
        primary={<Button>Add item</Button>}
      >
        <MenuAction onSelect={onImport} data-testid="import">
          Import…
        </MenuAction>
      </SplitButton>,
    );
    const trigger = screen.getByRole('button', { name: 'More add-item actions' });
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    fireEvent.click(screen.getByTestId('add-menu'));
    expect(screen.getByRole('menu', { name: 'More add-item actions' })).toBeTruthy();
    fireEvent.click(screen.getByTestId('import'));
    expect(onImport).toHaveBeenCalledTimes(1);
  });
});
