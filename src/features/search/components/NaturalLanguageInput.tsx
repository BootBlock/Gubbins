import { useCallback, useId, useMemo, useState, type FormEvent } from 'react';
import { Button, Input, Tooltip, INFO_OPEN_DELAY_MS } from '@/components/foundry';
import { InfoIcon, VoiceIcon } from '@/components/icons';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useLocations } from '@/features/inventory/queries';
import { useCategories } from '@/features/inventory/categories';
import { useSearchBuilder } from '../SearchBuilderContext';
import { interpretNaturalLanguage, type NlContext, type NlRecognisedPart } from '../nl-query';

/**
 * The feature-gap G5 "ask in plain English" box (rule-based, no-LLM). It turns a
 * plain-English phrase — "low stock screws in the garage" — into the *same* Tier-3 AST
 * the Visual Builder edits ({@link useSearchBuilder}) via a `load` action, so the
 * graphical builder below visibly fills in and the existing `parseASTtoSQL` → FTS path
 * runs it. A sibling to the power-user {@link TextQueryInput}: same "fill the builder"
 * contract, friendlier input. The heavy lifting (intent lexicon, phrase → AST) lives in
 * the pure {@link interpretNaturalLanguage} seam; this is thin glue over it.
 */
export function NaturalLanguageInput() {
  const { dispatch } = useSearchBuilder();
  const [text, setText] = useState('');
  const [recognised, setRecognised] = useState<readonly NlRecognisedPart[] | null>(null);
  const [notUnderstood, setNotUnderstood] = useState(false);
  const hintId = useId();
  const statusId = useId();

  const locations = useLocations();
  const categories = useCategories();
  const lowStockQtyThreshold = usePreferencesStore((s) => s.lowStockQtyThreshold);

  // The resolver context (locations/categories by name + the low-stock threshold). Plain
  // data, recomputed only when a source changes, so the pure seam stays test-friendly.
  const context = useMemo<NlContext>(
    () => ({
      locations: locations.data?.rows.map((l) => ({ id: l.id, name: l.name })) ?? [],
      categories: categories.data?.rows.map((c) => ({ id: c.id, name: c.name })) ?? [],
      lowStockQtyThreshold,
    }),
    [locations.data, categories.data, lowStockQtyThreshold],
  );

  const run = useCallback(
    (phrase: string) => {
      const result = interpretNaturalLanguage(phrase, context);
      if (result.empty) {
        // Nothing matched — keep the current builder (don't blank it) and prompt gently.
        setRecognised(null);
        setNotUnderstood(phrase.trim().length > 0);
        return;
      }
      setNotUnderstood(false);
      setRecognised(result.recognised);
      dispatch({ type: 'load', ast: result.ast });
    },
    [context, dispatch],
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    run(text);
  };

  return (
    <form onSubmit={submit} className="space-y-field-gap-compact">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <VoiceIcon
            aria-hidden
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              if (notUnderstood) setNotUnderstood(false);
            }}
            placeholder="low stock screws in the garage"
            className="pl-9 text-xs"
            aria-label="Ask in plain English"
            aria-describedby={hintId}
            data-testid="nl-search-input"
          />
        </div>
        <Button type="submit" variant="secondary" className="h-9 text-xs" data-testid="nl-search-run">
          Ask
        </Button>
      </div>

      <p id={hintId} className="flex items-center gap-1 text-[11px] text-muted-foreground">
        Ask in plain English — e.g. <code className="font-mono">out of stock in the shed</code>,{' '}
        <code className="font-mono">more than 10</code>; press Enter to fill the builder.
        <Tooltip
          content={[
            'Type a request in plain English and press **Enter** — it fills the builder below.',
            '',
            'Understood phrases include:',
            '- **stock level** — "low stock", "out of stock", "in stock"',
            '- **amounts** — "more than 10", "fewer than 5", "exactly 3"',
            '- **a location** — "in the garage", "on shelf 2"',
            '- **a category** — any category name you use',
            '',
            'Anything left over becomes a name search. For expiring / on-loan and other',
            'time-based filters, use the status chips above the list.',
          ].join('\n')}
          placement="top"
          openDelayMs={INFO_OPEN_DELAY_MS}
          className="text-muted-foreground [&_svg]:size-3.5"
        >
          <InfoIcon aria-label="Plain-English search help" />
        </Tooltip>
      </p>

      {/* Echo what was understood (or a gentle miss), announced politely for screen readers. */}
      <p id={statusId} role="status" aria-live="polite" className="min-h-0">
        {recognised && recognised.length > 0 ? (
          <span className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
            <span>Understood:</span>
            {recognised.map((part, i) => (
              <span
                key={`${part.kind}-${i}`}
                className="rounded-full bg-primary/10 px-2 py-0.5 font-medium text-primary"
              >
                {part.label}
              </span>
            ))}
          </span>
        ) : notUnderstood ? (
          <span className="block text-[11px] text-muted-foreground" data-testid="nl-search-miss">
            Couldn’t pick out a filter — try words like “low stock”, “out of stock”, “in the garage” or “more
            than 10”.
          </span>
        ) : null}
      </p>
    </form>
  );
}
