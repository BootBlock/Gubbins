import { cn } from '@/lib/utils';
import { plural } from '@/lib/plural';
import { Surface } from '@/components/foundry';
import { ChevronRightIcon } from '@/components/icons';
import type { LocationWithCount } from '@/db/repositories';
import type { LayoutDensity } from '@/state/stores/useLayoutStore';
import { descriptionSnippet } from '../location-detail';
import { LocationKindIcon } from './LocationKindIcon';

/**
 * A one-line summary of what a child location holds, shown beneath its name so the
 * card/row conveys whether it's worth opening: its direct item count and, when it
 * nests further locations, how many. An entirely empty branch reads "Empty".
 *
 * @internal Exported for unit tests only.
 */
export function describeLocationContents(itemCount: number, subLocationCount: number): string {
  const parts: string[] = [];
  if (itemCount > 0) {
    parts.push(`${itemCount} ${plural(itemCount, 'item')}`);
  }
  if (subLocationCount > 0) {
    parts.push(`${subLocationCount} ${plural(subLocationCount, 'sub-location')}`);
  }
  return parts.length > 0 ? parts.join(' · ') : 'Empty';
}

/**
 * Shown in the item pane when the selected location holds no items of its own but *does*
 * nest other locations (the "drill down" case). Rather than a dead-end empty banner, each
 * child location is offered as a clickable card (Visual density) or row (Data density) that
 * navigates into it — mirroring the two item presentations so the pane reads consistently.
 *
 * Each child is a real `<button>` labelled with its name and contents summary: keyboard
 * operable and announced by screen readers. The Visual card reuses the {@link Surface}
 * primitive for its chrome, with a stretched button covering it so the whole card is the
 * hit target while the panel styling stays defined in one place.
 *
 * A child that carries a **description** shows a one-line, plain-text preview of it beneath the
 * summary (issue #617): choosing which of several bins to open is exactly the moment the note a
 * user wrote about a place is worth reading, and reading it otherwise meant hovering that row in
 * the tree or opening the location first. It is a preview, not the note — the full Markdown
 * renders in the detail panel once the location is open, so the card keeps a fixed height.
 */
export function SubLocationNav({
  childLocations,
  locations,
  density,
  onSelect,
  locationColorClass,
}: {
  /** The direct, active child locations of the selected location, in display order. */
  childLocations: readonly LocationWithCount[];
  /** Every location — used to count each child's own nested locations. */
  locations: readonly LocationWithCount[];
  density: LayoutDensity;
  onSelect: (id: string) => void;
  /** Resolve a location id to its Tailwind text-colour class (its swatch), if any. */
  locationColorClass?: (id: string) => string | undefined;
}) {
  // How many active child locations each child itself nests, so the summary can say
  // "2 sub-locations" for a branch that holds no items directly.
  const subLocationCounts = new Map<string, number>();
  for (const loc of locations) {
    if (loc.parentId !== null && !loc.archivedAt) {
      subLocationCounts.set(loc.parentId, (subLocationCounts.get(loc.parentId) ?? 0) + 1);
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto px-1 pt-2" data-testid="sub-location-nav">
      <p className="px-1 pb-3 text-sm text-muted-foreground">
        No items here — open a location to see what's inside.
      </p>
      <div
        className={density === 'data' ? 'flex flex-col gap-1.5 pb-4' : 'grid gap-4 pb-4'}
        style={
          density === 'data' ? undefined : { gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }
        }
      >
        {childLocations.map((loc) => {
          const summary = describeLocationContents(loc.itemCount, subLocationCounts.get(loc.id) ?? 0);
          const colorClass = locationColorClass?.(loc.id);
          const snippet = descriptionSnippet(loc.description);
          // The preview joins the accessible name too: the visible line is `aria-hidden` in the
          // Data row (the button's label is the whole announcement there), so leaving it out
          // would give a screen-reader user less to go on than a sighted one.
          const label = snippet
            ? `Open ${loc.name} — ${summary}. ${snippet}`
            : `Open ${loc.name} — ${summary}`;
          return density === 'data' ? (
            <button
              key={loc.id}
              type="button"
              onClick={() => onSelect(loc.id)}
              aria-label={label}
              className="group flex w-full items-center gap-4 rounded-lg border border-border/60 bg-card/40 px-4 py-2.5 text-left outline-none transition-colors hover:bg-card/80 focus-visible:ring-2 focus-visible:ring-primary/60"
            >
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-secondary/50 text-muted-foreground [&_svg]:size-4">
                <LocationKindIcon kind={loc.kind} />
              </span>
              <div className="min-w-0 flex-1">
                <p className={cn('truncate text-sm font-medium', colorClass)} aria-hidden>
                  {loc.name}
                </p>
                <p className="truncate text-xs text-muted-foreground" aria-hidden>
                  {summary}
                </p>
                {snippet ? (
                  <p className="truncate text-xs text-muted-foreground/80" aria-hidden>
                    {snippet}
                  </p>
                ) : null}
              </div>
              <ChevronRightIcon
                className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
                aria-hidden
              />
            </button>
          ) : (
            <Surface
              key={loc.id}
              className="relative flex items-center gap-4 p-5 transition-all duration-200 ease-emphasized hover:-translate-y-1 hover:shadow-primary/10 focus-within:ring-2 focus-within:ring-primary/60"
            >
              <span className="grid size-11 shrink-0 place-items-center rounded-lg bg-secondary/50 text-muted-foreground [&_svg]:size-5">
                <LocationKindIcon kind={loc.kind} />
              </span>
              <div className="min-w-0 flex-1">
                <h3 className={cn('truncate text-base font-semibold tracking-tight', colorClass)}>
                  {loc.name}
                </h3>
                <p className="mt-1 truncate text-xs text-muted-foreground">{summary}</p>
                {snippet ? <p className="mt-1 truncate text-xs text-muted-foreground/80">{snippet}</p> : null}
              </div>
              <ChevronRightIcon
                className="size-5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
                aria-hidden
              />
              {/* Stretched hit target: the whole card is one button, labelled for AT, while
                  Surface stays the single source of the panel chrome. */}
              <button
                type="button"
                onClick={() => onSelect(loc.id)}
                aria-label={label}
                className="absolute inset-0 rounded-2xl outline-none"
              />
            </Surface>
          );
        })}
      </div>
    </div>
  );
}
