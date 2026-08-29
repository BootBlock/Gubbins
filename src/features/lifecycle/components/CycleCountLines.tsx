/**
 * The shared count sheet for one location (spec §4.4): the blind DISCRETE count inputs
 * (each with a live variance chip), the SERIALISED presence toggles, and the control that adds
 * an item the auditor found here but the database does not place here (issue #640 — see
 * {@link FoundHereField}). Extracted from {@link CycleCountDialog} so the standalone dialog and the
 * guided audit-day stepper render the identical sheet — the only thing that differs between the
 * two is the footer (Close/Authorise vs Skip/Authorise-&-continue), which each caller owns.
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
import { CloseIcon } from '@/components/icons';
import { foundLineKey, serialisedLabel, type SerialisedPresence } from '../cycle-count';
import type { CycleCountSessionLine, SerialisedSessionLine } from '../CycleCountContext';
import type { LocationCycleCount } from '../useLocationCycleCount';
import { FoundHereField } from './FoundHereField';

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
  const { lines, counts, setCount, serialised, presence, setPresence, foundSerialised, removeFound } = count;
  // Which line keys the auditor added themselves, so the row can say so. Derived from `found`
  // rather than tracked separately, because `found` is what the provider prunes when a refetch
  // turns an addition into a line the database supplies itself.
  const foundKeys = new Set(count.found.filter((e) => e.mode === 'DISCRETE').map(foundLineKey));
  return (
    <>
      {lines.length > 0 && (
        <Sheet
          rows={lines}
          rowKey={(line) => line.key}
          rowHeight={COUNT_ROW_HEIGHT}
          testId="cycle-count-lines"
        >
          {(line) => (
            <CountRow
              line={line}
              value={counts[line.key] ?? ''}
              setCount={setCount}
              found={foundKeys.has(line.key)}
              removeFound={removeFound}
            />
          )}
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

      {foundSerialised.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Found here — recorded elsewhere
          </p>
          <ul className="space-y-1.5" data-testid="found-serialised-lines">
            {foundSerialised.map((line) => (
              <li key={line.itemId}>
                <FoundInstanceRow line={line} removeFound={removeFound} />
              </li>
            ))}
          </ul>
        </div>
      )}

      <FoundHereField count={count} />
    </>
  );
}

/** One serialised instance the auditor found here. Removable; no present/missing to judge. */
function FoundInstanceRow({
  line,
  removeFound,
}: {
  line: SerialisedSessionLine;
  removeFound: LocationCycleCount['removeFound'];
}) {
  return (
    <div className={ROW_CLASSES}>
      <span className="flex-1 text-sm font-medium">{serialisedLabel(line)}</span>
      {/*
        Keyboard-reachable on purpose: the trigger is a plain label rather than a control, so it is
        the tooltip's *own* tab stop that carries the explanation of what authorising will do to
        this unit. `triggerTabIndex={-1}` belongs on a trigger wrapping something already
        focusable — the remove button beside it — not here.
      */}
      <Tooltip content="Authorising this count **moves** this unit into the location you are counting, and records the move in its history.">
        <span className="text-xs font-semibold text-warning">Move here</span>
      </Tooltip>
      <RemoveFoundButton itemId={line.itemId} label={serialisedLabel(line)} removeFound={removeFound} />
    </div>
  );
}

/** Take a found item back off the sheet. Icon-only, so it carries its own accessible name. */
function RemoveFoundButton({
  itemId,
  label,
  removeFound,
}: {
  itemId: string;
  label: string;
  removeFound: LocationCycleCount['removeFound'];
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      className="size-7 shrink-0 p-0"
      onClick={() => removeFound(itemId)}
      aria-label={`Remove ${label} from this count`}
      data-testid={`remove-found-${itemId}`}
    >
      <CloseIcon className="size-4" aria-hidden />
    </Button>
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
              // The whole sheet's size and this row's place in it, stated rather than counted.
              // A `<li>` carries implicit `listitem` semantics, so assistive tech otherwise
              // reports the *window* — "3 of 13" on a 400-line shelf, changing as the auditor
              // scrolls. On a sheet whose whole point is that nothing was left off it, a spoken
              // total an order of magnitude short is a wrong answer, not a rough one. Same
              // treatment every other windowed list here gets (`select.tsx`, `ItemCard`,
              // `LocationTreeItem`); `WholeSheet` needs none, as every row is in the DOM.
              aria-setsize={rows.length}
              aria-posinset={virtualRow.index + 1}
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
  found,
  removeFound,
}: {
  line: CycleCountSessionLine;
  value: string;
  setCount: LocationCycleCount['setCount'];
  /** This line was added by the auditor, not by the location's own stock (issue #640). */
  found: boolean;
  removeFound: LocationCycleCount['removeFound'];
}) {
  const counted = value.trim().length ? Number(value) : null;
  const variance = counted !== null ? counted - line.expected : null;
  return (
    <div className={ROW_CLASSES}>
      <span className="flex-1 text-sm font-medium">
        {line.name}
        {found ? (
          /* Says why this line is here at all, since the sheet is otherwise everything the
             database expects and an unexplained extra row reads as a bug. The expected quantity
             stays hidden either way — the count is still blind. */
          <span className="ml-2 rounded bg-warning/15 px-1.5 py-0.5 text-xs font-normal text-warning">
            Found here
          </span>
        ) : null}
      </span>
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
      {found ? <RemoveFoundButton itemId={line.itemId} label={line.name} removeFound={removeFound} /> : null}
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
