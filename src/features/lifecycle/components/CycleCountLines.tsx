/**
 * The shared count sheet for one location (spec §4.4): the blind DISCRETE count inputs
 * (each with a live variance chip) and the SERIALISED presence toggles. Extracted from
 * {@link CycleCountDialog} so the standalone dialog and the guided audit-day stepper
 * render the identical sheet — the only thing that differs between the two is the footer
 * (Close/Authorise vs Skip/Authorise-&-continue), which each caller owns.
 *
 * Purely presentational: all state (counts, presence) is threaded in from
 * {@link useLocationCycleCount}; this component holds none of its own.
 *
 * Two things keep a long sheet usable (issue #561). A location's count is deliberately
 * uncapped — capping it is how an audit under-counts — so a bulk-storage shelf can put
 * thousands of lines here, and one `<Input>` per line put every one of them in the DOM at the
 * moment the auditor is standing in front of the shelf:
 *
 * - Past {@link WINDOW_THRESHOLD} rows the sheet is **windowed** through the same
 *   `@tanstack/react-virtual` seam the inventory list, the location sidebar and the activity
 *   log already use, so it costs what is on screen rather than what is on the shelf. Below
 *   that it renders as it always did — a drawer with a dozen lots gains nothing from a window
 *   and would lose a layout that grows with the dialog for a fixed scrolling box inside it.
 * - Every row is **memoised** on its own line and value, in both modes. Windowing alone would
 *   not be enough: the visible rows are still tens of inputs on a tablet, and each keystroke
 *   replaces the whole `counts` record, so all of them re-rendered on every digit typed.
 */
import { memo, useState, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Button, Input, Tooltip } from '@/components/foundry';
import { serialisedLabel, type SerialisedPresence } from '../cycle-count';
import type { CycleCountSessionLine, SerialisedSessionLine } from '../CycleCountContext';
import type { LocationCycleCount } from '../useLocationCycleCount';

/**
 * How many rows a sheet may hold before it is windowed rather than rendered whole. Well above
 * any drawer or shelf a person counts in one pass, and far below the point where the DOM is
 * the bottleneck — so the ordinary count keeps its ordinary layout and only a bulk location
 * pays for the scrolling window.
 */
const WINDOW_THRESHOLD = 40;

/**
 * Estimated row heights — a count row is an `h-10` input inside `py-2` plus the row gap; a
 * presence row is an `h-7` button in the same padding. Each row measures itself once mounted
 * (`measureElement`), so an estimate that is slightly out only affects the scrollbar before
 * the rows land, never the layout.
 */
const COUNT_ROW_HEIGHT = 62;
const PRESENCE_ROW_HEIGHT = 50;

/** How tall a windowed sheet may grow before it scrolls inside the dialog rather than with it. */
const SHEET_MAX_HEIGHT = 'max-h-[22rem]';

/** The card each line sits on, shared by both render modes. */
const ROW_CLASSES = 'flex items-center gap-3 rounded-lg bg-secondary/30 px-3 py-2';

export function CycleCountLines({ count }: { count: LocationCycleCount }) {
  const { lines, counts, setCount, serialised, presence, setPresence } = count;
  return (
    <>
      {lines.length > 0 && (
        <Sheet
          rows={lines}
          rowKey={(line) => line.key}
          rowHeight={COUNT_ROW_HEIGHT}
          testId="cycle-count-lines"
        >
          {(line) => <CountRow line={line} value={counts[line.key] ?? ''} setCount={setCount} />}
        </Sheet>
      )}

      {serialised.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Serialised instances
          </p>
          <Sheet
            rows={serialised}
            rowKey={(line) => line.itemId}
            rowHeight={PRESENCE_ROW_HEIGHT}
            testId="serialised-audit-lines"
          >
            {(line) => (
              <PresenceRow line={line} state={presence[line.itemId] ?? 'PRESENT'} setPresence={setPresence} />
            )}
          </Sheet>
        </div>
      )}
    </>
  );
}

interface SheetProps<T> {
  readonly rows: readonly T[];
  readonly rowKey: (row: T) => string;
  readonly rowHeight: number;
  readonly testId: string;
  readonly children: (row: T) => ReactNode;
}

/**
 * A list of count rows, rendered whole or windowed depending on how many there are. The two
 * modes are separate components because `useVirtualizer` cannot be called conditionally;
 * crossing the threshold therefore remounts the list, which only a refetch that changes the
 * sheet's length can do.
 */
function Sheet<T>(props: SheetProps<T>) {
  return props.rows.length > WINDOW_THRESHOLD ? <WindowedSheet {...props} /> : <WholeSheet {...props} />;
}

/** The ordinary sheet: every row in the DOM, growing with the dialog. */
function WholeSheet<T>({ rows, rowKey, testId, children }: SheetProps<T>) {
  return (
    <ul className="space-y-1.5" data-testid={testId}>
      {rows.map((row) => (
        <li key={rowKey(row)}>{children(row)}</li>
      ))}
    </ul>
  );
}

/** The windowed sheet: only the rows on screen (plus overscan) are in the DOM. */
function WindowedSheet<T>({ rows, rowKey, rowHeight, testId, children }: SheetProps<T>) {
  // The scroll element is held in state rather than a ref so that attaching it re-renders:
  // the virtualiser reads it during render, and a plain ref would still be null on the pass
  // that mounts the container — leaving the first window empty until something else happened
  // to re-render the sheet.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => rowHeight,
    // Generous enough that tabbing off the last visible input lands on a row that is already
    // mounted — a windowed list of *inputs* would otherwise have keyboard dead ends.
    overscan: 8,
  });
  return (
    <div ref={setScrollEl} className={`${SHEET_MAX_HEIGHT} overflow-auto`} data-testid={testId}>
      <ul className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const row = rows[virtualRow.index]!;
          return (
            <li
              key={rowKey(row)}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              className="absolute left-0 top-0 w-full pb-1.5"
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              {children(row)}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * One blind count line: the label, the input, and the live variance chip. Memoised so typing
 * in one row leaves its neighbours alone — `setCount` is a stable callback from the provider
 * and `value` is this row's own entry, so the props change only for the row being typed in.
 */
const CountRow = memo(function CountRow({
  line,
  value,
  setCount,
}: {
  line: CycleCountSessionLine;
  value: string;
  setCount: LocationCycleCount['setCount'];
}) {
  const counted = value.trim().length ? Number(value) : null;
  const variance = counted !== null ? counted - line.expected : null;
  return (
    <div className={ROW_CLASSES}>
      <span className="flex-1 text-sm font-medium">{line.name}</span>
      <Input
        type="number"
        min={0}
        step={1}
        value={value}
        onChange={(e) => setCount(line.key, e.target.value)}
        placeholder="count"
        className="w-24"
        aria-label={`Counted quantity for ${line.name}`}
        data-testid={`count-${line.key}`}
      />
      <span
        className={
          variance === null
            ? 'w-16 text-right text-xs text-muted-foreground'
            : variance === 0
              ? 'w-16 text-right text-xs text-success'
              : 'w-16 text-right text-xs font-semibold text-warning'
        }
      >
        {variance === null ? '—' : variance === 0 ? 'OK' : `${variance > 0 ? '+' : ''}${variance}`}
      </span>
    </div>
  );
});

/** One presence toggle. Memoised on its own instance and flag — see {@link CountRow}. */
const PresenceRow = memo(function PresenceRow({
  line,
  state,
  setPresence,
}: {
  line: SerialisedSessionLine;
  state: SerialisedPresence;
  setPresence: LocationCycleCount['setPresence'];
}) {
  const isMissing = state === 'MISSING';
  return (
    <div className={ROW_CLASSES}>
      <span className="flex-1 text-sm font-medium">{serialisedLabel(line)}</span>
      <Tooltip
        content="Toggle this instance between **present** and **missing**. A missing instance is reconciled on authorisation by a *reversible* soft-delete — it leaves active inventory but can be restored."
        triggerTabIndex={-1}
      >
        <span>
          <Button
            type="button"
            variant={isMissing ? 'destructive' : 'ghost'}
            className="h-7 px-3 text-xs"
            onClick={() => setPresence(line.itemId, isMissing ? 'PRESENT' : 'MISSING')}
            data-testid={`presence-${line.itemId}`}
          >
            {isMissing ? 'Missing' : 'Present'}
          </Button>
        </span>
      </Tooltip>
    </div>
  );
});
