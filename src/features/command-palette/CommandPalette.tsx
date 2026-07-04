/**
 * CommandPalette — a global Cmd/Ctrl-/ command palette (dashboard improvement #1).
 *
 * Mounted once at the app root. Opens on Cmd/Ctrl-/ (or from the dashboard hero's Search
 * trigger) and runs in one of two modes, chosen by what you type:
 *
 * - **Item search** (the default): searches items live as you type and, on selection, hands
 *   the chosen item's name to the Inventory screen (via {@link useInventoryEntry}) and
 *   navigates there — the inventory detail view is dialog state with no deep-linkable route,
 *   so "jump to item" lands the screen pre-filtered to it.
 * - **Screen jump** (`>` prefix): typing `>` turns the palette into a screen switcher over
 *   {@link NAV_DESTINATIONS}; picking one navigates straight to that route.
 *
 * Both modes are ordered by the shared weighted {@link rankFuzzy} matcher, so the closest
 * hit floats to the top and the matched characters are highlighted. The whole feature is
 * gated by the `dashboardCommandPalette` preference; when off, nothing renders and no
 * shortcut is bound.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Input, Modal, Spinner } from '@/components/foundry';
import { SearchIcon, PackageIcon, CloseIcon, ChevronRightIcon } from '@/components/icons';
import { cn } from '@/lib/utils';
import { rankFuzzy } from '@/lib/fuzzy';
import { NAV_DESTINATIONS, type NavDestination } from '@/components/nav/nav-destinations';
import { useEnabledFeatures } from '@/features/modules/useFeature';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useInventoryItems } from '@/features/inventory/queries';
import { useInventoryEntry } from '@/features/inventory/useInventoryEntry';
import { useCommandPaletteStore } from './useCommandPaletteStore';

/** Cap on results shown — a quick picker, not a full list (that's the Inventory screen). */
const MAX_RESULTS = 8;

/** The prefix that flips the palette from item search into screen-jump mode. */
const SCREEN_PREFIX = '>';

export function CommandPalette() {
  const enabled = usePreferencesStore((s) => s.dashboardCommandPalette);
  const open = useCommandPaletteStore((s) => s.open);
  const setOpen = useCommandPaletteStore((s) => s.setOpen);

  // Global shortcut: Cmd/Ctrl-/ toggles the palette. Bound only while the feature is on.
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '/') {
        e.preventDefault();
        useCommandPaletteStore.getState().toggle();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [enabled]);

  // If the feature is switched off while open, make sure it isn't left mounted.
  useEffect(() => {
    if (!enabled && open) setOpen(false);
  }, [enabled, open, setOpen]);

  if (!enabled || !open) return null;
  return <PaletteBody onClose={() => setOpen(false)} />;
}

/** A single row in the palette — either a screen destination or a matched item. */
type PaletteEntry =
  | { readonly kind: 'screen'; readonly dest: NavDestination; readonly positions: readonly number[] }
  | {
      readonly kind: 'item';
      readonly item: { readonly id: string; readonly name: string };
      readonly positions?: readonly number[];
    };

/** Stable DOM id for a row, used to wire `aria-activedescendant`. */
function optionId(entry: PaletteEntry): string {
  return entry.kind === 'screen' ? `cmdk-screen-${entry.dest.to}` : `cmdk-opt-${entry.item.id}`;
}

function PaletteBody({ onClose }: { readonly onClose: () => void }) {
  const navigate = useNavigate();
  const enabledFeatures = useEnabledFeatures();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [active, setActive] = useState(0);

  // Focus the input once open — after the Modal's own focus effect has run (it parks
  // focus on the dialog container), so a quick timeout reliably wins it back.
  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, []);

  // Screen mode is decided from the live query (a tiny client-side list — no need to wait).
  const leading = query.replace(/^\s+/, '');
  const isScreenMode = leading.startsWith(SCREEN_PREFIX);
  const screenQuery = isScreenMode ? leading.slice(SCREEN_PREFIX.length).trim() : '';

  // Debounce only the item search so each keystroke doesn't hit the worker.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 200);
    return () => clearTimeout(t);
  }, [query]);

  const itemSearch = isScreenMode ? '' : debounced;
  const hasItemQuery = itemSearch.length > 0;
  const itemsQuery = useInventoryItems(hasItemQuery ? { search: itemSearch } : {});
  const loading = hasItemQuery && itemsQuery.isPending;

  const entries = useMemo<readonly PaletteEntry[]>(() => {
    if (isScreenMode) {
      // Screen-jump only offers destinations whose feature is enabled; item search itself is
      // core inventory and is never gated (§3, Phase 2).
      const screens = NAV_DESTINATIONS.filter((d) => enabledFeatures.has(d.feature));
      return rankFuzzy(screens, screenQuery, (d) => d.label).map(({ item, match }) => ({
        kind: 'screen' as const,
        dest: item,
        positions: match.positions,
      }));
    }
    if (!hasItemQuery) return [];
    const rows = itemsQuery.data?.pages.flatMap((p) => p.rows) ?? [];
    // Re-rank the worker's hits by the fuzzy score so the closest name wins; keep any rows
    // that matched on another field (and so don't fuzzy-match the name) after them, rather
    // than dropping valid results.
    const ranked = rankFuzzy(rows, itemSearch, (r) => r.name);
    const matched = new Set(ranked.map((r) => r.item.id));
    const rest = rows
      .filter((r) => !matched.has(r.id))
      .map((item) => ({ item, positions: undefined as readonly number[] | undefined }));
    return [...ranked.map((r) => ({ item: r.item, positions: r.match.positions })), ...rest]
      .slice(0, MAX_RESULTS)
      .map(({ item, positions }) => ({ kind: 'item' as const, item, positions }));
  }, [isScreenMode, screenQuery, hasItemQuery, itemSearch, itemsQuery.data, enabledFeatures]);

  // Keep the active row in range as results change.
  useEffect(() => {
    setActive((i) => (entries.length === 0 ? 0 : Math.min(i, entries.length - 1)));
  }, [entries.length]);

  const select = (index: number) => {
    const entry = entries[index];
    if (!entry) return;
    onClose();
    if (entry.kind === 'screen') {
      void navigate({ to: entry.dest.to });
    } else {
      // Hand the item's name to the inventory screen and go there.
      useInventoryEntry.getState().requestSearch(entry.item.name);
      void navigate({ to: '/inventory' });
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (entries.length === 0 ? 0 : (i + 1) % entries.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (entries.length === 0 ? 0 : (i - 1 + entries.length) % entries.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      select(active);
    }
  };

  const listId = 'command-palette-results';
  const activeEntry = entries[active];
  return (
    <Modal open onClose={onClose} title="Command palette" className="max-w-xl">
      <div className="flex items-center gap-2 rounded-lg border border-border bg-input/40 px-3 [&_svg]:size-4 [&_svg]:text-muted-foreground">
        {isScreenMode ? <ChevronRightIcon aria-hidden /> : <SearchIcon aria-hidden />}
        <Input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={activeEntry ? optionId(activeEntry) : undefined}
          aria-label="Search items, or type a greater-than sign to jump to a screen"
          placeholder="Search items, or type > to jump to a screen…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          className="border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
          data-testid="command-palette-input"
        />
        {loading ? <Spinner className="size-4" /> : null}
        {query.length > 0 ? (
          <button
            type="button"
            onClick={() => {
              setQuery('');
              setDebounced('');
              setActive(0);
              inputRef.current?.focus();
            }}
            aria-label="Clear search"
            data-testid="command-palette-clear"
            className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <CloseIcon />
          </button>
        ) : null}
      </div>

      <ul
        id={listId}
        role="listbox"
        aria-label={isScreenMode ? 'Screen results' : 'Item results'}
        className="mt-3 max-h-80 space-y-1 overflow-y-auto"
      >
        {isScreenMode ? (
          entries.length === 0 ? (
            <li className="px-2 py-6 text-center text-sm text-muted-foreground">
              No screens match “{screenQuery}”.
            </li>
          ) : (
            entries.map((entry, index) =>
              entry.kind === 'screen' ? (
                <EntryRow
                  key={entry.dest.to}
                  id={optionId(entry)}
                  active={index === active}
                  onSelect={() => select(index)}
                  onHover={() => setActive(index)}
                  icon={<entry.dest.Icon aria-hidden />}
                  label={entry.dest.label}
                  positions={entry.positions}
                  testid="command-palette-screen"
                />
              ) : null,
            )
          )
        ) : !hasItemQuery ? (
          <li className="px-2 py-6 text-center text-sm text-muted-foreground">
            Start typing to find an item by name.
          </li>
        ) : loading ? (
          <li className="px-2 py-6 text-center text-sm text-muted-foreground">Searching…</li>
        ) : entries.length === 0 ? (
          <li className="px-2 py-6 text-center text-sm text-muted-foreground">
            No items match “{debounced}”.
          </li>
        ) : (
          entries.map((entry, index) =>
            entry.kind === 'item' ? (
              <EntryRow
                key={entry.item.id}
                id={optionId(entry)}
                active={index === active}
                onSelect={() => select(index)}
                onHover={() => setActive(index)}
                icon={<PackageIcon aria-hidden />}
                label={entry.item.name}
                positions={entry.positions}
                testid="command-palette-result"
              />
            ) : null,
          )
        )}
      </ul>

      <p
        data-testid="command-palette-help"
        className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border pt-2 text-xs text-muted-foreground"
      >
        <span className="flex items-center gap-1">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd>
          to move
        </span>
        <span className="flex items-center gap-1">
          <Kbd>↵</Kbd>
          to select
        </span>
        <span className="flex items-center gap-1">
          <Kbd>Esc</Kbd>
          to close
        </span>
        <span className="ml-auto flex items-center gap-1">
          Type <Kbd>&gt;</Kbd> to jump to a screen
        </span>
      </p>
    </Modal>
  );
}

/** One selectable row, shared by both modes; highlights the fuzzily-matched characters. */
function EntryRow({
  id,
  active,
  onSelect,
  onHover,
  icon,
  label,
  positions,
  testid,
}: {
  readonly id: string;
  readonly active: boolean;
  readonly onSelect: () => void;
  readonly onHover: () => void;
  readonly icon: ReactNode;
  readonly label: string;
  readonly positions?: readonly number[];
  readonly testid: string;
}) {
  return (
    <li>
      <button
        type="button"
        id={id}
        role="option"
        aria-selected={active}
        onClick={onSelect}
        onMouseMove={onHover}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground',
          active ? 'bg-primary/15 text-foreground' : 'text-muted-foreground',
        )}
        data-testid={testid}
      >
        {icon}
        <span className="truncate font-medium text-foreground">
          <Highlight text={label} positions={positions} />
        </span>
      </button>
    </li>
  );
}

/** Renders `text`, tinting the characters at `positions` so the match is visible. */
function Highlight({ text, positions }: { readonly text: string; readonly positions?: readonly number[] }) {
  if (!positions || positions.length === 0) return <>{text}</>;
  const set = new Set(positions);
  return (
    <>
      {Array.from(text).map((ch, i) =>
        set.has(i) ? (
          <mark key={i} className="bg-transparent font-semibold text-primary">
            {ch}
          </mark>
        ) : (
          <span key={i}>{ch}</span>
        ),
      )}
    </>
  );
}

/** A small keyboard-cap glyph for the help footer. */
function Kbd({ children }: { readonly children: ReactNode }) {
  return (
    <kbd className="rounded border border-border bg-card px-1 py-0.5 font-mono text-[10px] font-medium text-muted-foreground">
      {children}
    </kbd>
  );
}
