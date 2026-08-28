/**
 * CommandPalette — a global Cmd/Ctrl-/ command palette (dashboard improvement #1).
 *
 * Mounted once at the app root. Opens on Cmd/Ctrl-/ (or from the dashboard hero's Search
 * trigger) and runs in one of two modes, chosen by what you type:
 *
 * - **Item search** (the default): searches items live as you type and, on selection, navigates
 *   to `/inventory?q=<name>` — the inventory detail view is dialog state with no deep-linkable
 *   route, so "jump to item" lands the screen pre-filtered to it.
 * - **Screen jump** (`>` prefix): typing `>` turns the palette into a screen switcher over
 *   {@link PALETTE_DESTINATIONS} — every nav screen plus the off-nav ones (the Reports
 *   sub-screens and the Modules manager); picking one navigates straight to that route.
 *
 * Both modes are ordered by the shared weighted {@link rankFuzzy} matcher, so the closest
 * hit floats to the top and the matched characters are highlighted. The whole feature is
 * gated by the `dashboardCommandPalette` preference; when off, nothing renders and no
 * shortcut is bound.
 *
 * **Item search reads by relevance, not alphabetically** (issue #629). The palette shows at most
 * {@link MAX_RESULTS} rows, so which rows it *ranks* decides what it can ever offer. Reading one
 * page of the ordinary item list gave it the alphabetically-first fifty matches, and a query
 * matching more than that could leave the item literally named after the query outside the pool
 * entirely — present in the database, absent from the palette, with nothing on screen to say so.
 * It reads {@link useItemRelevanceSearch} instead: the closest matches over the *whole* match set,
 * plus how many matched. So `rankFuzzy` now re-ranks the best candidates rather than the
 * alphabetically first ones, and a final row discloses the rest rather than letting a full list
 * imply there is nothing else.
 *
 * **Quick actions** (find → act): once an item is surfaced you can act on it without leaving
 * the palette — mirroring the scanner's scan→act card. Enter still opens the item (the
 * unchanged default); a secondary affordance (ArrowRight from the input, or the row's chevron
 * for pointer users) opens an inline {@link ItemActions} panel over the highlighted item with
 * the same tracking-mode-adaptive controls the item card offers: ± adjust (active DISCRETE,
 * non-unlimited only), move to a location, check out (gated by the Contacts module), and open
 * details. Escape / the Back control returns to the results; typing again resumes searching.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Button, Input, Kbd, LiveRegion, Modal, Select, Spinner } from '@/components/foundry';
import {
  SearchIcon,
  PackageIcon,
  CloseIcon,
  ChevronRightIcon,
  ChevronLeftIcon,
  MoveIcon,
  CheckoutIcon,
  EditIcon,
} from '@/components/icons';
import { cn } from '@/lib/utils';
import { inventorySearchFor } from '@/features/inventory/view-params';
import { rankFuzzy } from '@/lib/fuzzy';
import { PALETTE_DESTINATIONS, type PaletteDestination } from '@/components/nav/nav-destinations';
import { useHotkeyHints } from '@/features/hotkeys/useHotkeyHints';
import { useSettingsDialog } from '@/features/settings/useSettingsDialog';
import { useEnabledFeatures, useFeature } from '@/features/modules/useFeature';
import { usePermission, usePermissionCheck } from '@/features/users/usePermission';
import { useErrorMessage } from '@/features/errors';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useItemRelevanceSearch, useItem, useLocations } from '@/features/inventory/queries';
import { useT } from '@/features/i18n';
import { useMoveItem } from '@/features/inventory/mutations';
import { useCheckoutItem } from '@/features/contacts/contacts';
import { QuantityStepper } from '@/features/inventory/components/QuantityStepper';
import { isUnlimited } from '@/features/inventory/unlimited';
import { useCommandPaletteStore } from './useCommandPaletteStore';

/** Cap on results shown — a quick picker, not a full list (that's the Inventory screen). */
const MAX_RESULTS = 8;

/**
 * How many of the closest matches the client re-ranks before picking the rows it shows.
 *
 * The database already returns these best-first, so the pool is a *refinement* window, not the
 * search itself: it gives `rankFuzzy` enough candidates to promote an exact name match that BM25
 * scored a little below a longer one, without shipping a page of rows nobody will see. Widening it
 * cannot rescue an item the relevance ordering ranked below the pool — that is what the disclosure
 * row is for.
 */
const SEARCH_POOL = 50;

/** The prefix that flips the palette from item search into screen-jump mode. */
const SCREEN_PREFIX = '>';

export function CommandPalette() {
  const enabled = usePreferencesStore((s) => s.dashboardCommandPalette);
  const open = useCommandPaletteStore((s) => s.open);
  const setOpen = useCommandPaletteStore((s) => s.setOpen);

  // The Ctrl-/ shortcut is no longer bound here: it is a registered global hotkey like every
  // other shortcut (issue #32), so it is rebindable, respects the modal stack, and lives in the
  // one place a key press becomes an app action. See `features/hotkeys`.

  // If the feature is switched off while open, make sure it isn't left mounted.
  useEffect(() => {
    if (!enabled && open) setOpen(false);
  }, [enabled, open, setOpen]);

  if (!enabled || !open) return null;
  return <PaletteBody onClose={() => setOpen(false)} />;
}

/**
 * A single row in the palette — a screen destination, a matched item, or the final row that says
 * how many items matched altogether and hands the query to the Inventory screen (issue #629).
 */
type PaletteEntry =
  | { readonly kind: 'screen'; readonly dest: PaletteDestination; readonly positions: readonly number[] }
  | {
      readonly kind: 'item';
      readonly item: { readonly id: string; readonly name: string };
      readonly positions?: readonly number[];
    }
  | { readonly kind: 'all'; readonly total: number };

/** Stable DOM id for a row, used to wire `aria-activedescendant`. */
function optionId(entry: PaletteEntry): string {
  if (entry.kind === 'screen') return `cmdk-screen-${entry.dest.to}`;
  return entry.kind === 'all' ? 'cmdk-see-all' : `cmdk-opt-${entry.item.id}`;
}

function PaletteBody({ onClose }: { readonly onClose: () => void }) {
  const navigate = useNavigate();
  const openSettings = useSettingsDialog((s) => s.openSettings);
  const enabledFeatures = useEnabledFeatures();
  const allows = usePermissionCheck();
  const hints = useHotkeyHints();
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [active, setActive] = useState(0);
  // The item whose quick-actions panel is open (find → act), or null while browsing. Holds
  // the id + name so the panel can render immediately while its full record loads.
  const [acting, setActing] = useState<{ readonly id: string; readonly name: string } | null>(null);

  // Focus the input once open — after the Modal's own focus effect has run (it parks
  // focus on the dialog container), so a quick timeout reliably wins it back.
  useEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, []);

  // Screen mode is decided from the live query (a tiny client-side list — no need to wait).
  const leading = query.replace(/^\s+/, '');
  const isScreenMode = leading.startsWith(SCREEN_PREFIX);
  const screenQuery = isScreenMode ? leading.slice(SCREEN_PREFIX.length).trim() : '';

  // Debounce only the item search so each keystroke doesn't hit the worker.
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 200);
    return () => clearTimeout(timer);
  }, [query]);

  // Typing again dismisses any open action panel and returns to browsing the results.
  useEffect(() => {
    setActing(null);
  }, [query]);

  // Item search answers only for a session that may read items (issue #522). The palette is
  // reachable from every screen, including the ones a restricted role *can* open, so leaving it
  // ungated would hand back the item records the guard just refused at `/inventory` — a
  // different case from "a screen you can open shows everything on it".
  const mayReadItems = usePermission('items:read');
  const itemSearch = isScreenMode || !mayReadItems ? '' : debounced;
  const hasItemQuery = itemSearch.length > 0;
  const itemsQuery = useItemRelevanceSearch(itemSearch, SEARCH_POOL, hasItemQuery);
  const loading = hasItemQuery && itemsQuery.isPending;

  const entries = useMemo<readonly PaletteEntry[]>(() => {
    if (isScreenMode) {
      // Screen-jump only offers destinations whose feature is enabled *and* whose read
      // permission this session holds (an entry declaring neither is always kept); item search
      // itself is core inventory and is never gated (§3, Phase 2, issue #522).
      const screens = PALETTE_DESTINATIONS.filter(
        (d) => (d.feature === undefined || enabledFeatures.has(d.feature)) && allows(d.permission),
      );
      return rankFuzzy(screens, screenQuery, (d) => d.label).map(({ item, match }) => ({
        kind: 'screen' as const,
        dest: item,
        positions: match.positions,
      }));
    }
    if (!hasItemQuery) return [];
    const rows = itemsQuery.data?.rows ?? [];
    const total = itemsQuery.data?.total ?? 0;
    // Re-rank the worker's hits by the fuzzy score so the closest name wins; keep any rows
    // that matched on another field (and so don't fuzzy-match the name) after them, rather
    // than dropping valid results.
    const ranked = rankFuzzy(rows, itemSearch, (r) => r.name);
    const matched = new Set(ranked.map((r) => r.item.id));
    const rest = rows
      .filter((r) => !matched.has(r.id))
      .map((item) => ({ item, positions: undefined as readonly number[] | undefined }));
    // Say what is being left out. Without that last row, a full list reads as "there are this
    // many", and the user's reasonable conclusion when their item isn't among them is that it
    // isn't there. It costs one item row rather than a ninth: the list is a fixed-height scroller,
    // so a row appended past the bottom would sit exactly where nobody looks.
    const capped = total > MAX_RESULTS;
    const shown: PaletteEntry[] = [
      ...ranked.map((r) => ({ item: r.item, positions: r.match.positions })),
      ...rest,
    ]
      .slice(0, capped ? MAX_RESULTS - 1 : MAX_RESULTS)
      .map(({ item, positions }) => ({ kind: 'item' as const, item, positions }));
    if (capped) shown.push({ kind: 'all', total });
    return shown;
  }, [isScreenMode, screenQuery, hasItemQuery, itemSearch, itemsQuery.data, enabledFeatures, allows]);

  // Keep the active row in range as results change.
  useEffect(() => {
    setActive((i) => (entries.length === 0 ? 0 : Math.min(i, entries.length - 1)));
  }, [entries.length]);

  // Scroll the highlighted row into view as the selection moves. The list is a fixed-height
  // scroller, so an arrow-key step past the visible window — most visibly a wrap from the top
  // to the bottom (or vice versa) — would otherwise leave the highlighted row off-screen where
  // the user can't see what they've selected (issue #450). `block: 'nearest'` scrolls only when
  // the row isn't already fully visible, so ordinary in-view moves don't jump the list.
  const activeEntry = entries[active];
  useEffect(() => {
    if (acting || !activeEntry) return;
    const row = listRef.current?.querySelector<HTMLElement>(`#${CSS.escape(optionId(activeEntry))}`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [active, activeEntry, acting]);

  // Navigate to the Inventory screen with the query in its URL, then close the palette. The
  // quick-search box is how the palette reaches the item list at all — the detail view is dialog
  // state with no deep-linkable route. An item's name opens that one item ("open details", Enter's
  // default and the panel's primary); the raw query opens the whole match set (the "see all" row).
  const openInInventory = (search: string) => {
    onClose();
    void navigate({ to: '/inventory', search: inventorySearchFor(search) });
  };

  const select = (index: number) => {
    const entry = entries[index];
    if (!entry) return;
    if (entry.kind === 'screen') {
      onClose();
      // Settings is a dialog, not a routed screen — open it rather than navigating.
      if (entry.dest.to === '/settings') {
        openSettings();
        return;
      }
      void navigate({ to: entry.dest.to });
    } else if (entry.kind === 'all') {
      openInInventory(itemSearch);
    } else {
      openInInventory(entry.item.name);
    }
  };

  // Reveal the quick-actions panel for an item entry (find → act). Restores focus to the
  // input when it closes so the keyboard flow is never stranded.
  const openActions = (item: { readonly id: string; readonly name: string }) => setActing(item);
  const closeActions = () => {
    setActing(null);
    inputRef.current?.focus();
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
    } else if (e.key === 'ArrowRight') {
      // Open quick actions for the highlighted item — but only when the caret is at the end
      // of the query, so ArrowRight keeps editing text mid-word as usual.
      const entry = entries[active];
      const input = e.currentTarget;
      const caretAtEnd = input.selectionStart === input.value.length;
      if (entry?.kind === 'item' && caretAtEnd) {
        e.preventDefault();
        openActions(entry.item);
      }
    }
  };

  const listId = 'command-palette-results';
  // While the quick-actions panel is open, a dismiss (Escape / backdrop / the Close button)
  // first backs out to the results — the Modal owns the document-level Escape listener, so
  // routing "go back" through it is more robust than intercepting the key inside the panel.
  const dismiss = () => (acting ? closeActions() : onClose());
  return (
    <Modal open onClose={dismiss} title="Command palette" className="max-w-xl">
      <div className="flex items-center gap-2 rounded-lg border border-border bg-input/40 px-3 [&_svg]:size-4 [&_svg]:text-muted-foreground">
        {isScreenMode ? <ChevronRightIcon aria-hidden /> : <SearchIcon aria-hidden />}
        <Input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={activeEntry && !acting ? optionId(activeEntry) : undefined}
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

      {acting ? (
        <ItemActions
          key={acting.id}
          item={acting}
          onBack={closeActions}
          onOpenDetails={() => openInInventory(acting.name)}
        />
      ) : (
        <>
          <ul
            ref={listRef}
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
                      shortcut={hints.forRoute(entry.dest.to)}
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
                    onActions={() => openActions(entry.item)}
                    icon={<PackageIcon aria-hidden />}
                    label={entry.item.name}
                    positions={entry.positions}
                    testid="command-palette-result"
                  />
                ) : entry.kind === 'all' ? (
                  <EntryRow
                    key="see-all"
                    id={optionId(entry)}
                    active={index === active}
                    onSelect={() => select(index)}
                    onHover={() => setActive(index)}
                    icon={<SearchIcon aria-hidden />}
                    label={t('commandPalette.seeAllResults', { vars: { count: entry.total } })}
                    testid="command-palette-see-all"
                  />
                ) : null,
              )
            )}
          </ul>
        </>
      )}

      <p
        data-testid="command-palette-help"
        className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border pt-2 text-xs text-muted-foreground"
      >
        {acting ? (
          <span className="flex items-center gap-1">
            <Kbd>Esc</Kbd>
            to go back
          </span>
        ) : (
          <>
            <span className="flex items-center gap-1">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd>
              to move
            </span>
            <span className="flex items-center gap-1">
              <Kbd>↵</Kbd>
              to open
            </span>
            {!isScreenMode && hasItemQuery ? (
              <span className="flex items-center gap-1">
                <Kbd>→</Kbd>
                for actions
              </span>
            ) : null}
            <span className="flex items-center gap-1">
              <Kbd>Esc</Kbd>
              to close
            </span>
            <span className="ml-auto flex items-center gap-1">
              Type <Kbd>&gt;</Kbd> to jump to a screen
            </span>
          </>
        )}
      </p>
    </Modal>
  );
}

/**
 * Quick-actions panel over one found item (find → act) — the palette's peer of the item card's
 * action row ({@link import('@/features/inventory/components/ItemActions')}) and the scanner's
 * Discrete result card. Reuses the very same mutations and gating so behaviour stays identical:
 *
 * - **± adjust** — only for an active DISCRETE, non-unlimited item (gauge / serialised /
 *   untracked / unlimited items skip it); reuses {@link QuantityStepper}.
 * - **Move** — a location picker → `useMoveItem`.
 * - **Check out** — an inline contact-name field → `useCheckoutItem`, gated by the Contacts
 *   module exactly as the item card is (hidden when Contacts is off, or for gauge / untracked /
 *   removed items).
 * - **Open details** — the palette's original jump-to-item, kept as the primary.
 *
 * The item's full record is loaded here (via {@link useItem}) so the controls can adapt to its
 * tracking mode; a success is announced through a {@link LiveRegion} for assistive tech, and a
 * failed write is shown in the panel (and announced) rather than being left to reject silently.
 */
function ItemActions({
  item,
  onBack,
  onOpenDetails,
}: {
  readonly item: { readonly id: string; readonly name: string };
  readonly onBack: () => void;
  readonly onOpenDetails: () => void;
}) {
  const backRef = useRef<HTMLButtonElement>(null);
  const detail = useItem(item.id);
  const locationsQuery = useLocations();
  const locationRows = locationsQuery.data?.rows ?? [];
  const move = useMoveItem();
  const checkout = useCheckoutItem();
  const contactsEnabled = useFeature('contacts');

  const describeError = useErrorMessage();

  const [moveTarget, setMoveTarget] = useState('');
  const [contactName, setContactName] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Land focus on Back when the panel opens, so the whole panel is keyboard-reachable from a
  // known anchor and Escape/Back has an obvious visible home.
  useEffect(() => {
    backRef.current?.focus();
  }, []);

  const data = detail.data ?? null;

  // Both writes report their failure rather than rejecting into an unobserved promise: the
  // panel keeps what you typed/picked so the retry is one click, and the error replaces the
  // previous outcome so a stale success notice never sits beside a failed attempt.
  const moveHere = async () => {
    if (moveTarget === '') return;
    const name = locationRows.find((l) => l.id === moveTarget)?.name ?? 'the location';
    setError(null);
    try {
      await move.mutateAsync({ id: item.id, locationId: moveTarget });
    } catch (e) {
      setNotice(null);
      setError(describeError(e, `Could not move ${item.name}.`));
      return;
    }
    setNotice(`Moved ${item.name} to ${name}.`);
    setMoveTarget('');
  };

  const checkOut = async () => {
    const contact = contactName.trim();
    // The Enter shortcut on the contact field bypasses the button's `disabled`, so the guard
    // against a double-fire has to live here too — a second write must not slip through.
    if (contact.length === 0 || checkout.isPending) return;
    setError(null);
    try {
      await checkout.mutateAsync({ itemId: item.id, contactName: contact });
    } catch (e) {
      setNotice(null);
      setError(describeError(e, `Could not check ${item.name} out.`));
      return;
    }
    setNotice(`Checked out ${item.name} to ${contact}.`);
    setContactName('');
  };

  // ± is countable-only, and matches the item card / scanner gate exactly.
  const showAdjust = data?.trackingMode === 'DISCRETE' && data.isActive && !isUnlimited(data);
  // Checking out belongs to the Contacts module (hidden when off), and never applies to a
  // gauge / untracked / removed item — the same gate the item card uses.
  const showCheckout =
    contactsEnabled &&
    data?.isActive === true &&
    data.trackingMode !== 'CONSUMABLE_GAUGE' &&
    data.trackingMode !== 'UNTRACKED';

  return (
    <div
      role="group"
      aria-label={`Quick actions for ${item.name}`}
      className="mt-3 space-y-3 rounded-lg border border-border bg-card p-3"
      data-testid="command-palette-action-panel"
    >
      <div className="flex items-center gap-2">
        <Button
          ref={backRef}
          variant="ghost"
          size="icon"
          className="size-8"
          onClick={onBack}
          aria-label="Back to results"
          data-testid="command-palette-actions-back"
        >
          <ChevronLeftIcon />
        </Button>
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">{item.name}</span>
      </div>

      {data ? (
        <>
          {showAdjust ? (
            <div className="flex items-center gap-2" data-testid="command-palette-adjust">
              <span className="text-xs text-muted-foreground">On hand</span>
              <QuantityStepper id={data.id} quantity={data.quantity} />
            </div>
          ) : null}

          {/* Move to a location — through the same `useMoveItem` seam as the card + scanner. */}
          <div className="flex gap-2">
            <Select
              value={moveTarget}
              onChange={setMoveTarget}
              className="flex-1"
              aria-label="Move to location"
              data-testid="command-palette-move-location"
              options={[
                { value: '', label: 'Move to…' },
                ...locationRows.map((loc) => ({ value: loc.id, label: loc.name })),
              ]}
            />
            <Button
              variant="outline"
              onClick={() => void moveHere()}
              disabled={moveTarget === '' || move.isPending}
              data-testid="command-palette-move"
            >
              <MoveIcon /> Move
            </Button>
          </div>

          {/* Check out — gated by the Contacts module exactly like the item card. */}
          {showCheckout ? (
            <div className="flex gap-2">
              <Input
                value={contactName}
                onChange={(e) => setContactName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void checkOut();
                  }
                }}
                placeholder="Check out to…"
                aria-label="Check out to contact"
                data-testid="command-palette-checkout-contact"
                className="flex-1"
              />
              <Button
                variant="outline"
                onClick={() => void checkOut()}
                disabled={contactName.trim().length === 0 || checkout.isPending}
                data-testid="command-palette-checkout"
              >
                <CheckoutIcon /> Check out
              </Button>
            </div>
          ) : null}

          {/* Open the full record — the palette's original jump-to-item, kept as the primary. */}
          <Button
            variant="outline"
            onClick={onOpenDetails}
            className="w-full"
            data-testid="command-palette-open-details"
          >
            <EditIcon /> Open details
          </Button>
        </>
      ) : (
        <div className="flex items-center gap-2 px-1 py-4 text-sm text-muted-foreground">
          <Spinner className="size-4" /> Loading…
        </div>
      )}

      {/* A failed write says so in the panel; `role="alert"` also announces it, so it is not
        repeated in the LiveRegion below (which carries successes only). */}
      {error ? (
        <p role="alert" className="text-sm text-destructive" data-testid="command-palette-action-error">
          {error}
        </p>
      ) : null}

      {/* Announce each action's outcome for assistive tech — the panel's SR channel. */}
      <LiveRegion data-testid="command-palette-action-notice">
        {notice ? <span className="text-xs text-muted-foreground">{notice}</span> : null}
      </LiveRegion>
    </div>
  );
}

/**
 * One selectable row, shared by both modes; highlights the fuzzily-matched characters.
 *
 * When `onActions` is given (item rows), a trailing chevron reveals the quick-actions panel —
 * the pointer peer of the keyboard ArrowRight shortcut. It sits beside the `role="option"`
 * button rather than inside it (an option can't nest a control) and is kept out of the Tab
 * order (`tabIndex=-1`); keyboard users reach the same panel with ArrowRight.
 */
function EntryRow({
  id,
  active,
  onSelect,
  onHover,
  onActions,
  icon,
  label,
  positions,
  shortcut,
  testid,
}: {
  readonly id: string;
  readonly active: boolean;
  readonly onSelect: () => void;
  readonly onHover: () => void;
  readonly onActions?: () => void;
  readonly icon: ReactNode;
  readonly label: string;
  readonly positions?: readonly number[];
  /** The row's global shortcut, printed like a desktop menu accelerator (issue #127). */
  readonly shortcut?: string;
  readonly testid: string;
}) {
  return (
    <li
      className={cn('flex items-center rounded-lg transition-colors', active ? 'bg-primary/15' : null)}
      onMouseMove={onHover}
    >
      <button
        type="button"
        id={id}
        role="option"
        aria-selected={active}
        onClick={onSelect}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground',
          active ? 'text-foreground' : 'text-muted-foreground',
        )}
        data-testid={testid}
      >
        {icon}
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">
          <Highlight text={label} positions={positions} />
        </span>
        {/* Decorative: the row is already selectable, and reading the accelerator aloud mid-list
          would be noise. It is here to be *noticed* on the way to clicking. */}
        {shortcut !== undefined ? (
          <span aria-hidden className="shrink-0" data-testid="command-palette-shortcut">
            <Kbd>{shortcut}</Kbd>
          </span>
        ) : null}
      </button>
      {onActions ? (
        <button
          type="button"
          tabIndex={-1}
          onClick={onActions}
          aria-label={`Quick actions for ${label}`}
          data-testid="command-palette-row-actions"
          className={cn(
            'mr-1 shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 [&_svg]:size-4',
            active ? 'opacity-100' : 'opacity-0',
          )}
        >
          <ChevronRightIcon aria-hidden />
        </button>
      ) : null}
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
