/**
 * Per-item render containment for the inventory list (issue #313).
 *
 * The list renders the same item three ways — {@link ItemCard}, {@link ItemRow} and
 * {@link ItemTableRow} — inside a virtualised scroller with nothing between a row and the
 * route. One item whose data trips a render error would otherwise take the whole screen down
 * to the route error page, hiding the hundreds of rows that are perfectly fine.
 *
 * {@link withItemCrashBoundary} wraps a presentation at its *export*, so every call site
 * (flat list, grouped list, and anything added later) is covered without repeating the
 * plumbing. Each boundary resets on the `item` object identity, so a row that failed on
 * stale data retries itself the moment the query refetches — no reload needed.
 */
import { memo, type ComponentType } from 'react';
import { cn } from '@/lib/utils';
import { Surface } from '@/components/foundry';
import type { Item } from '@/db/repositories';
import { useT } from '@/features/i18n';
import { ContainedErrorBoundary } from '@/app/error/ContainedErrorBoundary';

/** The message itself — one line, muted-warning, shared by all three shapes. */
function CrashMessage({ className }: { className?: string }) {
  const t = useT();
  return (
    <p className={cn('text-xs text-warning', className)} data-testid="item-crashed">
      {t('inventory.item.crashed')}
    </p>
  );
}

/**
 * The list-position props every stand-in carries through (issue #208), so a crashed card/row
 * still counts as one `role="listitem"` at its absolute position rather than punching a hole
 * in the list semantics.
 */
interface CrashedListItemProps {
  ariaPosInSet?: number;
  ariaSetSize?: number;
}

/** Visual-Heavy stand-in — a plain card so the grid cell keeps its place. */
export function ItemCardCrashed({ ariaPosInSet, ariaSetSize }: CrashedListItemProps) {
  return (
    <Surface
      role="listitem"
      aria-posinset={ariaPosInSet}
      aria-setsize={ariaSetSize}
      className="flex select-none flex-col gap-4 p-5"
    >
      <CrashMessage />
    </Surface>
  );
}

/** Data-Heavy stand-in — matches {@link ItemRow}'s bordered strip. */
export function ItemRowCrashed({ ariaPosInSet, ariaSetSize }: CrashedListItemProps) {
  return (
    <div
      role="listitem"
      aria-posinset={ariaPosInSet}
      aria-setsize={ariaSetSize}
      className="flex select-none items-center gap-4 rounded-lg border border-border/60 bg-card/40 px-4 py-2.5"
    >
      <CrashMessage />
    </div>
  );
}

/**
 * Table stand-in — stays a `role="row"` carrying its absolute `aria-rowindex`, so a crashed
 * row doesn't punch a hole in the table semantics or desync the row numbering.
 */
export function ItemTableRowCrashed({
  gridTemplate,
  ariaRowIndex,
}: {
  gridTemplate: string;
  ariaRowIndex: number;
}) {
  return (
    <div
      role="row"
      aria-rowindex={ariaRowIndex}
      style={{ gridTemplateColumns: gridTemplate }}
      className="grid select-none items-center gap-4 border-b border-border/50 px-3 py-2"
    >
      <span role="cell" className="min-w-0">
        <CrashMessage />
      </span>
    </div>
  );
}

/**
 * Wraps an item presentation in a per-item {@link ContainedErrorBoundary}.
 *
 * The wrapper is itself `memo`'d, not just the inner component: these render inside the
 * virtualised list, where the whole point of the `memo` on each card/row is that React bails
 * out at the *element* and skips the subtree as siblings scroll. Memoising only the inner
 * component would still run this wrapper and the boundary for every visible row on every
 * parent re-render — so the memo goes on the outermost component, exactly where it was before
 * the boundary was introduced.
 */
export function withItemCrashBoundary<P extends { item: Item }>(
  Inner: ComponentType<P>,
  what: string,
  Fallback: ComponentType<P>,
): ComponentType<P> {
  function ItemCrashBoundary(props: P) {
    return (
      <ContainedErrorBoundary
        what={`${what} "${props.item.id}"`}
        resetKeys={[props.item]}
        fallback={<Fallback {...props} />}
      >
        <Inner {...props} />
      </ContainedErrorBoundary>
    );
  }
  ItemCrashBoundary.displayName = `withItemCrashBoundary(${what})`;
  return memo(ItemCrashBoundary) as ComponentType<P>;
}
