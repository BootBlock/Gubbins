import { Fragment, useMemo } from 'react';
import { Markdown } from '@/components/foundry';
import type { LocationWithCount } from '@/db/repositories';
import { useT } from '@/features/i18n';
import { resolveLocationDetailFields } from '../location-detail';
import { useLocationFieldValues } from '../categories';
import { FieldValue } from './ItemCardFields';

/**
 * The selected location's **own detail**, rendered atop the inventory list: its free-text
 * description as rich Markdown (the same engine that powers the sidebar's location tooltips),
 * and the custom-field values it holds about itself (issues #108, #617).
 *
 * A location has no screen of its own — it is a filter on the inventory — so this block is where
 * everything a user attached to a *place* is read: access instructions, a shelf's load rating, a
 * room's humidity, a link to the boiler manual. Before it, the field half of that was visible
 * only inside the Edit dialog, while the app happily published the same values to Home Assistant.
 *
 * Deliberately the **fuller panel** rather than another stat on {@link LocationInfoCard}: that
 * strip is a fixed set of measured facts that never wraps and sheds pieces as the viewport
 * narrows, and it is opt-out. User-authored text is unbounded and is exactly what must *not*
 * disappear at a narrow width or behind a dismissed card, so it gets a block that can wrap and
 * that shows whenever there is something to show.
 *
 * Renders nothing at all when the location carries neither a description nor a filled-in field
 * value, so the caller can mount it for any selected location without gating on content it would
 * have to fetch itself.
 */
export function LocationDetailCard({ location }: { location: LocationWithCount }) {
  const t = useT();
  const { data: values } = useLocationFieldValues(location.id);
  const fields = useMemo(() => resolveLocationDetailFields(values ?? []), [values]);
  const description = location.description?.trim() ?? '';

  if (description.length === 0 && fields.length === 0) return null;

  return (
    <section
      aria-label={t('inventory.location.detail.region', { vars: { name: location.name } })}
      data-testid="location-detail-card"
      className="mb-3 space-y-2 rounded-lg border border-border bg-card px-3 py-2"
    >
      {description.length > 0 ? <Markdown content={description} className="text-card-foreground" /> : null}

      {fields.length > 0 ? (
        // A wrapping grid of label/value pairs rather than the item card's right-aligned column:
        // this block is as wide as the item list, so pairs flow across it and wrap, and the values
        // themselves come from the shared card renderer so a field reads identically here and on
        // the items inside.
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs sm:grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,1fr)]">
          {fields.map((field) => (
            <Fragment key={field.id}>
              <dt className="text-muted-foreground">{field.label}</dt>
              <dd className="flex min-w-0 font-medium text-foreground">
                {/* Wrapping, not truncated: the panel exists to reveal what a place records about
                    itself, so clipping a long note here would defeat the point. */}
                <FieldValue field={field} wrap />
              </dd>
            </Fragment>
          ))}
        </dl>
      ) : null}
    </section>
  );
}
