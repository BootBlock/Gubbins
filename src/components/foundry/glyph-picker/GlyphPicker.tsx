import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { cn } from '@/lib/utils';
import { SearchIcon } from '@/components/icons';
import { Button } from '../button';
import { Input } from '../input';
import { Modal } from '../modal';
import { useSearchEscapeToClear } from '../use-search-escape';
import { GLYPH_NAMES, getGlyphIcon, isGlyphName } from './glyph-registry';
import { filterGlyphNames, humanizeGlyphName } from './glyph-name';

export interface GlyphPickerProps {
  readonly open: boolean;
  /** Cancel — Escape (from empty search / elsewhere), backdrop, Close or the Cancel button. */
  readonly onClose: () => void;
  /** Commit the chosen glyph (double-click, the Use button, or Enter). */
  readonly onSelect: (glyph: string) => void;
  /** Glyph to highlight initially (canonical Lucide name); ignored when unknown. */
  readonly initialGlyph?: string | null;
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
 * Foundry GlyphPicker — an app-wide, searchable icon chooser over the full Lucide
 * catalogue (spec §2.4.1). Type to filter; the highlighted cell is tracked with
 * `aria-activedescendant` while focus stays on the search box (WAI-ARIA combobox +
 * grid-of-options). Choose a glyph by double-clicking it, single-clicking then pressing
 * Use, or moving with the arrow keys and pressing Enter.
 *
 * Escape has two roles: with a non-empty search box focused it *clears the filter* and
 * keeps the dialog open (intercepted in the capture phase so the enclosing {@link Modal}
 * never sees it); from an empty box — or anywhere else in the dialog — it cancels.
 *
 * Controlled: the caller mounts it when `open`, seeds `initialGlyph`, and reacts to
 * `onSelect` / `onClose`.
 */
export function GlyphPicker({
  open,
  onClose,
  onSelect,
  initialGlyph,
  title = 'Choose an icon',
}: GlyphPickerProps) {
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const optionId = (index: number) => `${baseId}-opt-${index}`;

  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(() =>
    isGlyphName(initialGlyph) ? initialGlyph : null,
  );

  const searchRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const filtered = useMemo(() => filterGlyphNames(GLYPH_NAMES, query), [query]);
  const activeIndex = selected ? filtered.indexOf(selected) : -1;

  // Escape clears a focused, non-empty search box (and only then) — the shared
  // capture-phase seam; from an empty box it falls through to Modal, which cancels.
  useSearchEscapeToClear(open, searchRef, () => setQuery(''));

  // Keep the highlighted cell in view as the selection moves (keyboard or filter change).
  useEffect(() => {
    if (activeIndex >= 0) optionRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const commit = (glyph: string | null) => {
    if (glyph) onSelect(glyph);
  };

  const moveTo = (index: number) => {
    if (filtered.length === 0) return;
    const clamped = Math.max(0, Math.min(filtered.length - 1, index));
    setSelected(filtered[clamped] ?? null);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
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
        moveTo(filtered.length - 1);
        break;
      case 'Enter':
        if (selected) {
          event.preventDefault();
          commit(selected);
        }
        break;
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      initialFocusRef={searchRef}
      className="max-w-xl"
      scrollBody={false}
    >
      <div className="flex min-h-0 flex-col gap-4">
        <div className="relative">
          <SearchIcon
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            ref={searchRef}
            type="text"
            role="combobox"
            aria-label="Search icons"
            aria-expanded
            aria-controls={listboxId}
            aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
            autoComplete="off"
            placeholder="Search icons…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            className="pl-9"
          />
        </div>

        <p className="text-xs text-muted-foreground" aria-live="polite">
          {filtered.length === 0
            ? `No icons match “${query.trim()}”.`
            : `${filtered.length} ${filtered.length === 1 ? 'icon' : 'icons'}`}
        </p>

        {/* The catalogue. Focus stays on the search box (combobox); each cell is an
            option addressed via aria-activedescendant, so cells are not tab stops.
            `content-visibility: auto` lets the browser skip painting off-screen cells,
            keeping a ~1,700-glyph grid smooth without virtualisation machinery. */}
        <div
          ref={gridRef}
          role="listbox"
          id={listboxId}
          aria-label="Icons"
          className="dialog-scroll grid max-h-[52vh] grid-cols-[repeat(auto-fill,minmax(3rem,1fr))] gap-1.5 py-1"
        >
          {filtered.map((name, index) => {
            const Icon = getGlyphIcon(name);
            const isSelected = name === selected;
            return (
              <button
                key={name}
                ref={(el) => {
                  optionRefs.current[index] = el;
                }}
                id={optionId(index)}
                type="button"
                role="option"
                aria-selected={isSelected}
                aria-label={humanizeGlyphName(name)}
                tabIndex={-1}
                style={{ contentVisibility: 'auto', containIntrinsicSize: '3rem' }}
                onClick={() => setSelected(name)}
                onDoubleClick={() => commit(name)}
                className={cn(
                  'flex aspect-square items-center justify-center rounded-lg border border-transparent text-muted-foreground transition-colors',
                  isSelected
                    ? 'bg-primary/15 text-primary ring-2 ring-inset ring-primary'
                    : 'hover:bg-secondary/60 hover:text-foreground',
                )}
              >
                {Icon ? <Icon className="size-5" aria-hidden /> : null}
              </button>
            );
          })}
        </div>

        <div className="flex items-center justify-between gap-3 pt-1">
          <span className="min-w-0 truncate text-sm text-muted-foreground">
            {selected ? humanizeGlyphName(selected) : 'No icon selected'}
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
