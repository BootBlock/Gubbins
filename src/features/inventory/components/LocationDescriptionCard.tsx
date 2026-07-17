import { Markdown } from '@/components/foundry';
import type { LocationWithCount } from '@/db/repositories';

/**
 * The selected location's free-text description, rendered atop the inventory list as
 * **rich Markdown** (the same engine that powers the sidebar's location tooltips). It
 * surfaces the notes the user attached to a location — access instructions, contents,
 * a URL — right where they're browsing that location's items, without opening the Edit
 * dialog.
 *
 * Shown only when the selected location actually carries a description; the caller gates
 * it on that (and on not being in a whole-collection visualisation, where a per-location
 * block wouldn't apply).
 */
export function LocationDescriptionCard({ location }: { location: LocationWithCount }) {
  return (
    <section
      aria-label={`Description of ${location.name}`}
      data-testid="location-description-card"
      className="mb-3 rounded-lg border border-border bg-card px-3 py-2"
    >
      <Markdown content={location.description ?? ''} className="text-card-foreground" />
    </section>
  );
}
