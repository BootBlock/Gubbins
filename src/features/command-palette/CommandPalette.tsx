/**
 * CommandPalette — a global Cmd/Ctrl-K "jump to item" search (dashboard improvement #1).
 *
 * Mounted once at the app root. Opens on Cmd/Ctrl-K (or from the dashboard hero's Search
 * trigger), searches items live as you type, and on selection hands the chosen item's name
 * to the Inventory screen (via {@link useInventoryEntry}) and navigates there — the
 * inventory detail view is dialog state with no deep-linkable route, so "jump to item"
 * lands the screen pre-filtered to it. The whole feature is gated by the
 * `dashboardCommandPalette` preference; when off, nothing renders and no shortcut is bound.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Input, Modal, Spinner } from '@/components/foundry';
import { SearchIcon, PackageIcon, CloseIcon } from '@/components/icons';
import { cn } from '@/lib/utils';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useInventoryItems } from '@/features/inventory/queries';
import { useInventoryEntry } from '@/features/inventory/useInventoryEntry';
import { useCommandPaletteStore } from './useCommandPaletteStore';

/** Cap on results shown — a quick picker, not a full list (that's the Inventory screen). */
const MAX_RESULTS = 8;

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

function PaletteBody({ onClose }: { readonly onClose: () => void }) {
  const navigate = useNavigate();
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

  // Debounce so each keystroke doesn't hit the worker; trims so blank space never searches.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 200);
    return () => clearTimeout(t);
  }, [query]);

  const hasQuery = debounced.length > 0;
  const itemsQuery = useInventoryItems(hasQuery ? { search: debounced } : {});
  const results = useMemo(
    () => (hasQuery ? (itemsQuery.data?.pages.flatMap((p) => p.rows) ?? []).slice(0, MAX_RESULTS) : []),
    [hasQuery, itemsQuery.data],
  );
  const loading = hasQuery && itemsQuery.isPending;

  // Keep the active row in range as results change.
  useEffect(() => {
    setActive((i) => (results.length === 0 ? 0 : Math.min(i, results.length - 1)));
  }, [results.length]);

  const select = (index: number) => {
    const item = results[index];
    if (!item) return;
    // Hand the item's name to the inventory screen and go there.
    useInventoryEntry.getState().requestSearch(item.name);
    onClose();
    void navigate({ to: '/inventory' });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (results.length === 0 ? 0 : (i + 1) % results.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (results.length === 0 ? 0 : (i - 1 + results.length) % results.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      select(active);
    }
  };

  const listId = 'command-palette-results';
  return (
    <Modal open onClose={onClose} title="Search items" className="max-w-xl">
      <div className="flex items-center gap-2 rounded-lg border border-border bg-input/40 px-3 [&_svg]:size-4 [&_svg]:text-muted-foreground">
        <SearchIcon aria-hidden />
        <Input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={results[active] ? `cmdk-opt-${results[active].id}` : undefined}
          aria-label="Search items by name"
          placeholder="Search items by name…"
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
            className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <CloseIcon />
          </button>
        ) : null}
      </div>

      <ul id={listId} role="listbox" aria-label="Item results" className="mt-3 max-h-80 space-y-1 overflow-y-auto">
        {!hasQuery ? (
          <li className="px-2 py-6 text-center text-sm text-muted-foreground">
            Start typing to find an item by name.
          </li>
        ) : loading ? (
          <li className="px-2 py-6 text-center text-sm text-muted-foreground">Searching…</li>
        ) : results.length === 0 ? (
          <li className="px-2 py-6 text-center text-sm text-muted-foreground">
            No items match “{debounced}”.
          </li>
        ) : (
          results.map((item, index) => (
            <li key={item.id}>
              <button
                type="button"
                id={`cmdk-opt-${item.id}`}
                role="option"
                aria-selected={index === active}
                onClick={() => select(index)}
                onMouseMove={() => setActive(index)}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground',
                  index === active ? 'bg-primary/15 text-foreground' : 'text-muted-foreground',
                )}
                data-testid="command-palette-result"
              >
                <PackageIcon aria-hidden />
                <span className="truncate font-medium text-foreground">{item.name}</span>
              </button>
            </li>
          ))
        )}
      </ul>
    </Modal>
  );
}
