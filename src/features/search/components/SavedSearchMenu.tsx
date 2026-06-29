import { useState, type KeyboardEvent } from 'react';
import { Button, Input, Tooltip } from '@/components/foundry';
import { AddIcon, CloseIcon } from '@/components/icons';
import { useSavedSearchesStore } from '../useSavedSearchesStore';

/**
 * Saved text searches (spec §3 — Phase 48). Sits under the {@link TextQueryInput}
 * power box: recall a named query as a chip (click → loads + runs it), delete one
 * (×), or name and save the current query. Persistence + the add/dedupe/cap logic
 * live in {@link useSavedSearchesStore} / the pure `saved-searches.ts` seam; this is
 * thin UI glue, so it is component-tested rather than via a contrived pure module.
 */
export function SavedSearchMenu({
  currentQuery,
  onRecall,
}: {
  /** The query text currently in the box — what "Save" persists. */
  readonly currentQuery: string;
  /** Load + run a recalled query (the parent re-parses it into the builder). */
  readonly onRecall: (query: string) => void;
}) {
  const searches = useSavedSearchesStore((s) => s.searches);
  const save = useSavedSearchesStore((s) => s.save);
  const remove = useSavedSearchesStore((s) => s.remove);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');

  const canSave = currentQuery.trim().length > 0;

  // No <form> here: this control is rendered *inside* the TextQueryInput form, and a
  // nested form is invalid HTML. Enter on the name field is handled directly instead
  // (and stopped from bubbling up to submit the outer query form).
  const confirmSave = () => {
    if (name.trim().length === 0 || !canSave) return;
    save(name, currentQuery);
    setName('');
    setNaming(false);
  };

  const onNameKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    event.stopPropagation();
    confirmSave();
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="saved-searches">
      {searches.length > 0 ? (
        <span className="text-[11px] text-muted-foreground">Saved:</span>
      ) : null}

      {searches.map((s) => (
        <span
          key={s.id}
          data-testid="saved-search-chip"
          className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 pl-2.5 pr-1 text-xs"
        >
          <Tooltip content={`\`${s.query}\``} triggerTabIndex={-1}>
            <button
              type="button"
              onClick={() => onRecall(s.query)}
              data-testid="saved-search-recall"
              className="py-1 font-medium text-foreground transition-colors hover:text-primary"
            >
              {s.name}
            </button>
          </Tooltip>
          <button
            type="button"
            onClick={() => remove(s.id)}
            aria-label={`Delete saved search ${s.name}`}
            data-testid="saved-search-remove"
            className="grid size-4 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive [&_svg]:size-3"
          >
            <CloseIcon />
          </button>
        </span>
      ))}

      {naming ? (
        <div className="flex items-center gap-1">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={onNameKeyDown}
            placeholder="Name this search"
            aria-label="Saved search name"
            data-testid="saved-search-name"
            className="h-7 w-40 text-xs"
            autoFocus
          />
          <Button
            type="button"
            variant="secondary"
            className="h-7 text-xs"
            data-testid="saved-search-confirm"
            disabled={name.trim().length === 0}
            onClick={confirmSave}
          >
            Save
          </Button>
          <button
            type="button"
            onClick={() => {
              setNaming(false);
              setName('');
            }}
            className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setNaming(true)}
          disabled={!canSave}
          data-testid="saved-search-save"
          className="inline-flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 [&_svg]:size-3"
        >
          <AddIcon /> Save search
        </button>
      )}
    </div>
  );
}
