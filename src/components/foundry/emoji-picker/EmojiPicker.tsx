import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { cn } from '@/lib/utils';
import { EMOJI_PICKER_SIZE_KEY } from '@/lib/storage-keys';
import { SearchIcon } from '@/components/icons';
import { Button } from '../button';
import { Input } from '../input';
import { Modal } from '../modal';
import { Tooltip } from '../tooltip';
import { InputClearButton } from '../input-clear-button';
import { useSearchEscapeToClear } from '../use-search-escape';
import { ALL_EMOJIS, EMOJI_GROUPS, type EmojiEntry } from './emoji-data';
import { emojiName, filterEmojis } from './emoji-search';
import { usePersistedSize, useResizeObserver } from './use-persisted-size';

/** The synthetic "All" group id — shows every emoji when no search is active. */
const ALL_GROUP_ID = 'all';

/** Default panel size — a comfortable browse area the user can grow or shrink. */
const DEFAULT_SIZE = { width: 560, height: 420 } as const;

export interface EmojiPickerProps {
  readonly open: boolean;
  /** Cancel — Escape (from an empty search / elsewhere), backdrop, Close or the Cancel button. */
  readonly onClose: () => void;
  /** Commit the chosen emoji (double-click, the Use button, or Enter). */
  readonly onSelect: (emoji: string) => void;
  /** Emoji to highlight initially; ignored when not in the catalogue. */
  readonly initialEmoji?: string | null;
  readonly title?: string;
}

/** Count of cells sharing the first cell's top edge — the live column count of the grid. */
function columnCount(grid: HTMLElement | null): number {
  const cells = grid?.children;
  if (!cells || cells.length === 0) return 1;
  const firstTop = (cells[0] as HTMLElement).offsetTop;
  let cols = 0;
  for (const cell of Array.from(cells)) {
    if ((cell as HTMLElement).offsetTop !== firstTop) break;
    cols += 1;
  }
  return Math.max(1, cols);
}

/**
 * Foundry EmojiPicker — an app-wide, searchable **Unicode-emoji** chooser (issue #83).
 * Distinct from the Lucide {@link import('../glyph-picker/GlyphPicker').GlyphPicker} icon
 * picker: this one picks a stored emoji *character* (e.g. 🔋), used anywhere a user marks
 * something with a glyph — first adopter is a category's card watermark.
 *
 * Layout (spec on the issue): a group **listview on the left** with a **search box above
 * it** that filters across every group; the **grid on the right** shows the selected
 * group, or the search matches while a query is present. Focus stays on the search box
 * (WAI-ARIA combobox + grid-of-options via `aria-activedescendant`); the arrow keys move
 * the highlight and Enter commits. Escape has two roles: with a non-empty search box it
 * *clears the filter* and keeps the dialog open; from an empty box it cancels. The whole
 * browse area is resizable and its size is remembered across opens.
 */
export function EmojiPicker({
  open,
  onClose,
  onSelect,
  initialEmoji,
  title = 'Choose an emoji',
}: EmojiPickerProps) {
  const baseId = useId();
  const listboxId = `${baseId}-grid`;
  const railId = `${baseId}-rail`;
  const optionId = (index: number) => `${baseId}-opt-${index}`;

  const [query, setQuery] = useState('');
  const [groupId, setGroupId] = useState<string>(ALL_GROUP_ID);
  const [selected, setSelected] = useState<string | null>(initialEmoji ?? null);

  const searchRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const railRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const [panelSize, persistSize] = usePersistedSize(EMOJI_PICKER_SIZE_KEY, DEFAULT_SIZE);
  const [panelEl, setPanelEl] = useState<HTMLElement | null>(null);
  useResizeObserver(panelEl, persistSize);

  const trimmed = query.trim();

  // When searching, matches win across every group; otherwise show the chosen group
  // ("All" = the whole catalogue).
  const visible: readonly EmojiEntry[] = useMemo(() => {
    if (trimmed.length > 0) return filterEmojis(query);
    if (groupId === ALL_GROUP_ID) return ALL_EMOJIS;
    return EMOJI_GROUPS.find((g) => g.id === groupId)?.emojis ?? [];
  }, [query, trimmed, groupId]);

  const activeIndex = selected ? visible.findIndex((e) => e.char === selected) : -1;

  // Escape clears a focused, non-empty search box (and only then) — the shared capture-phase
  // seam; from an empty box it falls through to Modal, which cancels.
  useSearchEscapeToClear(open, searchRef, () => setQuery(''));

  // Keep the highlighted cell in view as the selection moves (keyboard or filter change).
  useEffect(() => {
    if (activeIndex >= 0) optionRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const commit = (emoji: string | null) => {
    if (emoji) onSelect(emoji);
  };

  const moveTo = (index: number) => {
    if (visible.length === 0) return;
    const clamped = Math.max(0, Math.min(visible.length - 1, index));
    setSelected(visible[clamped]?.char ?? null);
  };

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const from = activeIndex < 0 ? 0 : activeIndex;
    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault();
        moveTo(activeIndex < 0 ? 0 : from + 1);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        moveTo(activeIndex < 0 ? 0 : from - 1);
        break;
      case 'ArrowDown':
        event.preventDefault();
        moveTo(activeIndex < 0 ? 0 : from + columnCount(gridRef.current));
        break;
      case 'ArrowUp':
        event.preventDefault();
        moveTo(activeIndex < 0 ? 0 : from - columnCount(gridRef.current));
        break;
      case 'Home':
        event.preventDefault();
        moveTo(0);
        break;
      case 'End':
        event.preventDefault();
        moveTo(visible.length - 1);
        break;
      case 'Enter':
        if (selected) {
          event.preventDefault();
          commit(selected);
        }
        break;
    }
  };

  // Roving-tabindex arrow navigation for the group listbox (WAI-ARIA listbox pattern):
  // Up/Down move between groups; Home/End jump to the ends. Choosing a group also clears any
  // active search so the group's own set is shown.
  const rail = [
    { id: ALL_GROUP_ID, label: 'All' },
    ...EMOJI_GROUPS.map((g) => ({ id: g.id, label: g.label })),
  ];
  const railIndex = Math.max(
    0,
    rail.findIndex((g) => g.id === groupId),
  );
  const chooseGroup = (id: string) => {
    setGroupId(id);
    setQuery('');
    setSelected(null);
  };
  const onRailKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    let next = railIndex;
    switch (event.key) {
      case 'ArrowDown':
        next = Math.min(rail.length - 1, railIndex + 1);
        break;
      case 'ArrowUp':
        next = Math.max(0, railIndex - 1);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = rail.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const target = rail[next];
    if (target) {
      chooseGroup(target.id);
      railRefs.current[next]?.focus();
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      initialFocusRef={searchRef}
      className="w-auto max-w-[95vw]"
      scrollBody={false}
    >
      <div className="flex min-h-0 flex-col gap-4">
        {/* The resizable browse area — a corner handle grows/shrinks it and the size is
            remembered across opens (issue #83). Min/max keep it usable and on-screen. */}
        <div
          ref={setPanelEl}
          style={{
            width: panelSize.width,
            height: panelSize.height,
            minWidth: 320,
            minHeight: 280,
            maxWidth: '90vw',
            maxHeight: '65vh',
          }}
          className="grid grid-cols-[10rem_1fr] gap-3 overflow-hidden [resize:both]"
        >
          {/* Left column: search box above the group listview. */}
          <div className="flex min-h-0 flex-col gap-2">
            <div className="relative">
              <SearchIcon
                className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                ref={searchRef}
                type="text"
                role="combobox"
                aria-label="Search emoji"
                aria-expanded
                aria-controls={listboxId}
                aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
                autoComplete="off"
                placeholder="Search…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={onSearchKeyDown}
                className="px-8"
              />
              {query.length > 0 ? (
                <div className="absolute right-1 top-1/2 -translate-y-1/2">
                  <Tooltip content="Clear the search and show every emoji again." openDelayMs={300}>
                    <InputClearButton label="Clear search" onClick={() => setQuery('')} />
                  </Tooltip>
                </div>
              ) : null}
            </div>

            {/* Group listview (WAI-ARIA listbox, roving tabindex). Disabled visually while a
                search is active — matches span every group, so the group choice is moot. */}
            <ul
              id={railId}
              role="listbox"
              aria-label="Emoji groups"
              className="dialog-scroll min-h-0 flex-1 space-y-0.5 overflow-y-auto pr-1"
            >
              {rail.map((group, index) => {
                const isActive = trimmed.length === 0 && group.id === groupId;
                return (
                  <li key={group.id}>
                    <button
                      ref={(el) => {
                        railRefs.current[index] = el;
                      }}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      tabIndex={index === railIndex ? 0 : -1}
                      onClick={() => chooseGroup(group.id)}
                      onKeyDown={onRailKeyDown}
                      className={cn(
                        'w-full truncate rounded-md px-2 py-1.5 text-left text-xs transition-colors outline-none',
                        'focus-visible:ring-2 focus-visible:ring-ring',
                        isActive
                          ? 'bg-primary/15 font-medium text-primary'
                          : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
                      )}
                    >
                      {group.label}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          {/* Right column: the emoji grid for the active group / search. */}
          <div className="flex min-h-0 flex-col gap-2">
            <p className="text-xs text-muted-foreground" aria-live="polite">
              {visible.length === 0 ? `No emoji match “${trimmed}”.` : `${visible.length} emoji`}
            </p>
            <div
              ref={gridRef}
              role="listbox"
              id={listboxId}
              aria-label="Emoji"
              className="dialog-scroll grid min-h-0 flex-1 grid-cols-[repeat(auto-fill,minmax(2.5rem,1fr))] content-start gap-1 overflow-y-auto py-0.5"
            >
              {visible.map((entry, index) => {
                const isSelected = entry.char === selected;
                return (
                  <button
                    key={`${entry.char}-${index}`}
                    ref={(el) => {
                      optionRefs.current[index] = el;
                    }}
                    id={optionId(index)}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    aria-label={entry.name}
                    title={entry.name}
                    tabIndex={-1}
                    onClick={() => setSelected(entry.char)}
                    onDoubleClick={() => commit(entry.char)}
                    className={cn(
                      'flex aspect-square items-center justify-center rounded-lg border border-transparent text-2xl transition-colors',
                      isSelected ? 'bg-primary/15 ring-2 ring-inset ring-primary' : 'hover:bg-secondary/60',
                    )}
                  >
                    <span aria-hidden>{entry.char}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 pt-1">
          <span className="flex min-w-0 items-center gap-2 truncate text-sm text-muted-foreground">
            {selected ? (
              <>
                <span aria-hidden className="text-xl">
                  {selected}
                </span>
                <span className="truncate">{emojiName(selected) ?? selected}</span>
              </>
            ) : (
              'No emoji selected'
            )}
          </span>
          <div className="flex shrink-0 gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="button" disabled={!selected} onClick={() => commit(selected)}>
              Use
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
