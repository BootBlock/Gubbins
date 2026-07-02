import { useCallback, useId, useState, type FormEvent } from 'react';
import { Button, Input, Tooltip, INFO_OPEN_DELAY_MS } from '@/components/foundry';
import { InfoIcon, SearchIcon } from '@/components/icons';
import { useSearchBuilder } from '../SearchBuilderContext';
import { parseTextQuery } from '../parse-text-query';
import { SavedSearchMenu } from './SavedSearchMenu';

/**
 * The §3 "hybrid text-based syntax" power-user search box (Phase 47, deepened in
 * Phase 48 with OR / parenthesised grammar + saved searches). It parses a query
 * string (e.g. `cap:voltage>3.3 (qty<10 OR mfr:acme)`) into the *same* Tier-3 AST the
 * Visual Builder edits ({@link useSearchBuilder}) via a `load` action — so the
 * graphical builder below visibly fills in and the existing `parseASTtoSQL` → FTS
 * path runs it. A parse failure surfaces inline and the previous tree is kept
 * (nothing is dispatched), so a typo never blanks the search.
 */
export function TextQueryInput() {
  const { dispatch } = useSearchBuilder();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const hintId = useId();
  const errorId = useId();

  /** Parse + load a query into the shared builder; surface a failure inline. */
  const runQuery = useCallback(
    (query: string) => {
      const result = parseTextQuery(query);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      dispatch({ type: 'load', ast: result.ast });
    },
    [dispatch],
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    runQuery(text);
  };

  /** Recall a saved search: reflect it in the box and run it. */
  const recall = (query: string) => {
    setText(query);
    runQuery(query);
  };

  return (
    <form onSubmit={submit} className="space-y-1.5">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              if (error) setError(null);
            }}
            placeholder="cap:voltage>3.3 (qty<10 OR mfr:acme)"
            className="pl-9 font-mono text-xs"
            aria-label="Text search query"
            aria-describedby={error ? `${hintId} ${errorId}` : hintId}
            aria-invalid={error ? true : undefined}
            data-testid="text-search-input"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
        </div>
        <Button type="submit" variant="secondary" className="h-9 text-xs">
          Run
        </Button>
      </div>
      <p id={hintId} className="flex items-center gap-1 text-[11px] text-muted-foreground">
        Power search — <code className="font-mono">field:text</code>,{' '}
        <code className="font-mono">qty&gt;10</code>, <code className="font-mono">cap:key&gt;3.3</code>,{' '}
        <code className="font-mono">OR</code> / <code className="font-mono">( )</code>; press Enter to fill
        the builder.
        <Tooltip
          content={[
            'Type a query and press **Enter** to fill the builder below.',
            '',
            '- `field:text` — match a field (e.g. `mfr:acme`, `name:resistor`)',
            '- `qty>10`, `qty<10`, `qty=10` — numeric comparisons',
            '- `cap:voltage>3.3` — compare a capability by key',
            '- combine with `OR` and group with `( )`; terms are **AND**-ed by default',
          ].join('\n')}
          placement="top"
          openDelayMs={INFO_OPEN_DELAY_MS}
          className="text-muted-foreground [&_svg]:size-3.5"
        >
          <InfoIcon aria-label="Search syntax help" />
        </Tooltip>
      </p>
      {error ? (
        <p
          id={errorId}
          role="alert"
          className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive"
          data-testid="text-search-error"
        >
          {error}
        </p>
      ) : null}
      <SavedSearchMenu currentQuery={text} onRecall={recall} />
    </form>
  );
}
