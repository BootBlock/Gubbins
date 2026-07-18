import { useState } from 'react';
import { Autocomplete, InfoHint } from '@/components/foundry';
import { CloseIcon, TagIcon } from '@/components/icons';
import {
  useItemTags,
  useLocationTags,
  useSetItemTags,
  useSetLocationTags,
  useTagNames,
  useTagSuggestions,
} from '../tags';

/**
 * Presentational freeform tag editor (spec §4, §5). Low-friction: typing a new name and
 * pressing Enter (or comma) auto-creates the tag and assigns it; existing tags are reused
 * case-insensitively. Fully controlled — the owner-bound wrappers below ({@link TagEditor}
 * for an item, {@link LocationTagEditor} for a location — issue #84) supply `names` and an
 * `onChange` that persists the whole replacement set via {@link TagRepository.setFor}.
 *
 * The entry field is the Foundry {@link Autocomplete} in creatable mode: free text (any new
 * tag) *plus* a filtered list of tags already in the dictionary, with the APG combobox
 * keyboard model and a portalled listbox — so the suggestions escape the surrounding card
 * instead of being clipped by it (issue #84).
 */
export function TagEditorControl({
  names,
  onChange,
}: {
  names: readonly string[];
  onChange: (names: string[]) => void;
}) {
  const [input, setInput] = useState('');
  // Two sources, because neither alone is right. Empty field → the dictionary's first page, so
  // clicking the control shows what already exists instead of nothing. Typing → the prefix
  // query, which reaches the *whole* dictionary rather than only that first page (the
  // dictionary read is capped at one page, so filtering it client-side would silently hide
  // matches once there are more tags than fit).
  const { data: dictionary } = useTagNames();
  const { data: matches } = useTagSuggestions(input);

  const has = (name: string) => names.some((n) => n.toLowerCase() === name.toLowerCase());

  /**
   * Append every genuinely-new name in one `onChange`. Taking a list (rather than calling a
   * single-name `add` in a loop) is what makes a multi-tag paste correct: each call would
   * otherwise rebuild from the same stale `names` prop, so only the last would survive — and
   * in the bound wrappers each would fire its own racing write.
   */
  const addAll = (raws: readonly string[]) => {
    const additions: string[] = [];
    for (const raw of raws) {
      const name = raw.trim();
      if (!name) continue;
      // Compare against what is already applied *and* what this batch has added.
      if (has(name) || additions.some((n) => n.toLowerCase() === name.toLowerCase())) continue;
      additions.push(name);
    }
    setInput('');
    if (additions.length > 0) onChange([...names, ...additions]);
  };

  const add = (raw: string) => addAll([raw]);
  const remove = (name: string) => onChange(names.filter((n) => n !== name));

  /**
   * Comma is the second commit key alongside Enter (which the combobox handles): typing or
   * pasting "fragile," lands the tag instead of leaving a stray separator in the field, and
   * pasting "fragile,heavy,on-loan" lands all three at once.
   */
  const onInputChange = (next: string) => {
    if (!next.includes(',')) {
      setInput(next);
      return;
    }
    const parts = next.split(',');
    const trailing = parts[parts.length - 1]!.trim();
    addAll(parts.slice(0, -1));
    // addAll clears the field; anything after the final comma is still being typed.
    if (trailing) setInput(trailing);
  };

  // Tags already on this owner are dropped from the list — re-adding one is a no-op.
  const source = input.trim().length > 0 ? (matches ?? []) : (dictionary?.rows ?? []);
  const unusedSuggestions = source.map((t) => t.name).filter((n) => !has(n));

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {names.length === 0 ? (
          <span className="text-xs text-muted-foreground">No tags yet.</span>
        ) : (
          names.map((name) => (
            <span
              key={name}
              className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2.5 py-1 text-xs font-medium text-primary"
            >
              <TagIcon className="size-3" />
              {name}
              <button
                type="button"
                aria-label={`Remove tag ${name}`}
                onClick={() => remove(name)}
                className="ml-0.5 rounded-full p-0.5 transition-colors hover:bg-primary/25 [&_svg]:size-3"
              >
                <CloseIcon />
              </button>
            </span>
          ))
        )}
      </div>

      <div className="flex items-start gap-2">
        <div className="flex-1">
          <Autocomplete
            value={input}
            onChange={onInputChange}
            suggestions={unusedSuggestions}
            onCommit={add}
            placeholder="Add a tag and press Enter…"
            aria-label="Add a tag"
          />
        </div>
        <div className="pt-2.5">
          <InfoHint
            content={
              'Freeform labels for grouping and filtering — *fragile*, *RoHS*, *favourite*, anything.\n\n' +
              '- Press **Enter** or **comma** to add.\n' +
              '- Names are reused **case-insensitively**, so `Fragile` and `fragile` are the same tag.\n' +
              '- The same tag can sit on both items and locations, and is searchable from the inventory search bar.'
            }
          />
        </div>
      </div>
    </div>
  );
}

/** Tag editor bound to one item's tag set. */
export function TagEditor({ itemId }: { itemId: string }) {
  const { data: tags } = useItemTags(itemId);
  const setTags = useSetItemTags(itemId);
  return (
    <TagEditorControl names={tags?.map((t) => t.name) ?? []} onChange={(names) => setTags.mutate(names)} />
  );
}

/** Tag editor bound to one location's tag set (issue #84). */
export function LocationTagEditor({ locationId }: { locationId: string }) {
  const { data: tags } = useLocationTags(locationId);
  const setTags = useSetLocationTags(locationId);
  return (
    <TagEditorControl names={tags?.map((t) => t.name) ?? []} onChange={(names) => setTags.mutate(names)} />
  );
}
