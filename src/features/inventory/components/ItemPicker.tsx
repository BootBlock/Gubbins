/**
 * ItemPicker — the app-wide control for choosing **one inventory item** (issue #484).
 *
 * Every picker that offers items used to read a fixed first page of the catalogue and present it
 * as the choice. At `MAX_PAGE_SIZE` that is the alphabetically first hundred items of the whole
 * inventory, so on a catalogue of any real size most items simply could not be picked — a "Zener
 * diode" was unreachable from the kit, BOM, purchase-order, relation, substitution and export
 * pickers alike, with nothing on screen to say so.
 *
 * So the typed text drives the read instead of trimming a fixed prefix:
 *
 * - **Typing** runs {@link useItemRelevanceSearch} — the closest `limit` matches ranked over the
 *   *whole* match set, not the alphabetically-first slice of it, so the item whose name is what
 *   you typed is among the offered rows however many matched.
 * - **An empty box** browses the first `limit` items, so opening the field still shows something
 *   to choose from on a small inventory.
 * - Either way the control says how much it is *not* showing, rather than presenting a capped
 *   read as the whole set.
 *
 * It is an editable combobox ({@link AutocompleteField}), because the Foundry `Select` has no
 * text-filter affordance — a picker that searches has to be a control the user can type into.
 * The value it reports is still an item id; {@link usePickerSelection} owns that id ↔ label
 * contract, leaving this component the item-shaped reads either side of it.
 */
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import {
  Autocomplete,
  AutocompleteField,
  LiveRegion,
  PICKER_OPTION_LIMIT,
  usePickerSelection,
} from '@/components/foundry';
import type { Item } from '@/db/repositories';
import { useT } from '@/features/i18n';
import { itemDisplayName } from '../item-display';
import { useInventoryItems, useItem, useItemRelevanceSearch } from '../queries';

/** The default label for a row — its name, with the serial number where one distinguishes it. */
function defaultItemLabel(item: Item): string {
  return itemDisplayName(item.name, item.serialNo);
}

const itemId = (item: Item): string => item.id;

export interface ItemPickerProps {
  /** The chosen item's id, or `null` / `''` for "nothing chosen". */
  readonly value: string | null;
  /**
   * Fires with the chosen item's id, or `null` when the box no longer names an item — including
   * while the user is midway through typing. The row is passed alongside when one was resolved,
   * so a caller needing the item itself does not have to read it back.
   */
  readonly onChange: (itemId: string | null, item?: Item) => void;
  /** Visible field label. Omit it *only* where the field is named by `aria-label` instead. */
  readonly label?: ReactNode;
  /** Accessible name for the unlabelled case; ignored when `label` is given. */
  readonly 'aria-label'?: string;
  /** Rich-Markdown help for the InfoHint badge (labelled case only). */
  readonly hint?: string;
  readonly placeholder?: string;
  readonly 'data-testid'?: string;
  /** Item ids to leave out of the offered rows — the item being edited, ones already added. */
  readonly exclude?: ReadonlySet<string>;
  /** Offer decommissioned items too. Off by default: linking live inventory should not offer them. */
  readonly includeInactive?: boolean;
  /**
   * How a row is named. Defaults to name + serial number; a caller overrides it to annotate the
   * row (the purchase-order and BOM pickers say when a receipt against an item cannot move stock).
   */
  readonly labelFor?: (item: Item) => string;
}

export function ItemPicker({
  value,
  onChange,
  label,
  'aria-label': ariaLabel,
  hint,
  placeholder,
  'data-testid': testId,
  exclude,
  includeInactive = false,
  labelFor = defaultItemLabel,
}: ItemPickerProps) {
  const t = useT();
  const valueId = value === null || value === '' ? null : value;
  // What the box holds, and whether it holds a label this control wrote (a chosen item) rather
  // than something the user typed — see {@link usePickerSelection}'s `setText`.
  const [box, setBox] = useState({ text: '', committed: false });
  const setText = useCallback((text: string, committed: boolean) => setBox({ text, committed }), []);

  // The chosen item, for the case where the caller set the value and the box has never named it.
  const chosen = useItem(valueId ?? undefined);

  // A committed label is not a query: searching for one would answer a successful choice by
  // announcing that nothing matches it.
  const query = box.committed ? '' : box.text.trim();
  const searching = query.length > 0;

  // The two reads are mutually exclusive by construction, so only one is ever in flight: a typed
  // query is answered by relevance, an empty box by the first page of the catalogue.
  const relevance = useItemRelevanceSearch(query, PICKER_OPTION_LIMIT, searching, includeInactive);
  const browse = useInventoryItems(
    includeInactive ? { includeInactive: true } : {},
    PICKER_OPTION_LIMIT,
    !searching,
  );

  const rows = useMemo<readonly Item[]>(() => {
    const found = searching
      ? (relevance.data?.rows ?? [])
      : // Sliced because this browse shares a cache entry with any other read of the same filters,
        // whose further pages are not rows this picker offered (`useInventoryItems` keys on the
        // filters alone, not the page size).
        (browse.data?.pages.flatMap((page) => page.rows) ?? []).slice(0, PICKER_OPTION_LIMIT);
    return exclude ? found.filter((item) => !exclude.has(item.id)) : found;
  }, [searching, relevance.data, browse.data, exclude]);

  /** How many rows the read returned before any exclusion — what says whether it was truncated. */
  const returned = searching
    ? (relevance.data?.rows.length ?? 0)
    : Math.min(browse.data?.pages.flatMap((page) => page.rows).length ?? 0, PICKER_OPTION_LIMIT);

  const { suggestions, onText } = usePickerSelection<Item>({
    value,
    onChange,
    rows,
    setText,
    resolved: chosen.data,
    labelFor,
    idFor: itemId,
  });

  /**
   * What the control is not showing. Silent while it is showing everything there is — there is
   * nothing to tell the user then — and specific about which of the two reads is truncated, since
   * "type to search" is the remedy for one and "keep typing" for the other.
   */
  let status: string | null = null;
  if (searching) {
    const total = relevance.data?.total ?? 0;
    if (relevance.data && total === 0) {
      status = t('itemPicker.noMatches', { vars: { query } });
    } else if (total > returned) {
      // Against what the read *returned*, not what survived `exclude` — otherwise hiding the item
      // being edited would report matches that no amount of typing could ever reveal.
      status = t('itemPicker.matchesTruncated', { vars: { shown: rows.length, total } });
    }
  } else if (browse.data?.pages[0]?.hasMore) {
    status = t('itemPicker.browseTruncated', { vars: { shown: rows.length } });
  }

  const shared = {
    value: box.text,
    onChange: onText,
    suggestions,
    // The rows were narrowed by the database against what was typed, so the combobox must not
    // narrow them a second time — a match the FTS index found on a folded token would otherwise
    // be dropped by its literal substring test, and the popup would come up empty for a query
    // that genuinely matched.
    prefiltered: true,
    maxOptions: PICKER_OPTION_LIMIT,
    placeholder: placeholder ?? t('itemPicker.placeholder'),
    'data-testid': testId,
  } as const;

  return (
    <div>
      {label !== undefined ? (
        <AutocompleteField {...shared} label={label} hint={hint} />
      ) : (
        <Autocomplete {...shared} aria-label={ariaLabel} />
      )}
      {/* Always mounted, so the message is announced when it appears rather than inserted with it. */}
      <LiveRegion className="text-xs text-muted-foreground">
        {/* The gap hangs off the message, not the region: an always-mounted region with a margin
            would otherwise push the control out of line with the button beside it. */}
        {status !== null ? (
          <span className="mt-1 block" data-testid="item-picker-status">
            {status}
          </span>
        ) : null}
      </LiveRegion>
    </div>
  );
}
