import { useState } from 'react';
import { Input } from '@/components/foundry';
import { CloseIcon, TagIcon } from '@/components/icons';
import { useItemTags, useSetItemTags, useTagSuggestions } from '../tags';

/**
 * Freeform tag editor (spec §4, §5). Low-friction: typing a new name and pressing
 * Enter (or comma) auto-creates the tag and assigns it; existing tags are reused
 * case-insensitively. Edits are diffed by {@link TagRepository.setForItem}.
 */
export function TagEditor({ itemId }: { itemId: string }) {
  const { data: tags } = useItemTags(itemId);
  const setTags = useSetItemTags(itemId);
  const [input, setInput] = useState('');
  const { data: suggestions } = useTagSuggestions(input);

  const names = tags?.map((t) => t.name) ?? [];
  const has = (name: string) => names.some((n) => n.toLowerCase() === name.toLowerCase());

  const add = (raw: string) => {
    const name = raw.trim();
    setInput('');
    if (!name || has(name)) return;
    setTags.mutate([...names, name]);
  };
  const remove = (name: string) => setTags.mutate(names.filter((n) => n !== name));

  const unusedSuggestions = (suggestions ?? []).filter((s) => !has(s.name)).slice(0, 6);

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

      <div className="relative">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              add(input);
            }
          }}
          placeholder="Add a tag and press Enter…"
          aria-label="Add a tag"
        />
        {unusedSuggestions.length > 0 ? (
          <div className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-border bg-popover shadow-lg">
            {unusedSuggestions.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => add(s.name)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-secondary [&_svg]:size-3.5 [&_svg]:text-muted-foreground"
              >
                <TagIcon />
                {s.name}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
