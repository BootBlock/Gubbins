import { useContext, type ReactNode } from 'react';
import { CheckIcon } from '@/components/icons';
import { MENU_ITEM_CLASS, MenuContext } from './menu-context';

export interface MenuActionProps {
  readonly icon?: ReactNode;
  readonly children: ReactNode;
  readonly onSelect: () => void;
  readonly disabled?: boolean;
  /** Renders a leading check, for menu rows that toggle a mode on/off. */
  readonly selected?: boolean;
  /**
   * Promotes the row to a selectable choice so assistive tech is told its state, not just
   * shown a check glyph: `'radio'` for one-of-many (a `menuitemradio` — a view mode, a
   * grouping axis) and `'checkbox'` for an independent on/off (a `menuitemcheckbox`). Either
   * exposes `aria-checked` reflecting {@link selected}. Omit for a plain command row, which
   * stays a bare `menuitem` with no checked state (so existing call sites are unchanged).
   */
  readonly selectionRole?: 'radio' | 'checkbox';
  /** Optional trailing adornment (e.g. a keyboard accelerator), as {@link MenuLink} takes. */
  readonly trailing?: ReactNode;
  readonly 'data-testid'?: string;
}

/** A button menu row. Runs `onSelect` then closes the menu. */
export function MenuAction({
  icon,
  children,
  onSelect,
  disabled,
  selected,
  selectionRole,
  trailing,
  ...rest
}: MenuActionProps) {
  const ctx = useContext(MenuContext);
  const role =
    selectionRole === 'radio'
      ? 'menuitemradio'
      : selectionRole === 'checkbox'
        ? 'menuitemcheckbox'
        : 'menuitem';
  return (
    <button
      type="button"
      role={role}
      tabIndex={-1}
      aria-disabled={disabled || undefined}
      aria-checked={selectionRole ? Boolean(selected) : undefined}
      className={MENU_ITEM_CLASS}
      onClick={() => {
        if (disabled) return;
        onSelect();
        ctx?.close();
      }}
      {...rest}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        {selected ? <CheckIcon /> : icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing}
    </button>
  );
}
