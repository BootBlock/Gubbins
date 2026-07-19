/**
 * The visible half of the critical-tier promise (spec §7.6.1).
 *
 * `full-res-policy` refuses the full-resolution write once storage is critically full; this
 * says so at the point of the pick, in both photo grids. Without it the degradation would be
 * silent — the thumbnail looks identical in the grid, so the user would only discover the
 * missing full-resolution image later, opening it.
 *
 * Deliberately scoped to `critical` alone, not to every tier the policy refuses the write at:
 * from `locked` the Hard Stop rejects the insert outright, so "saved as thumbnails only" would
 * be a *second* false promise — there the storage banner's "saving paused" is the true message.
 *
 * Renders nothing otherwise, so call sites can mount it unconditionally. Not a live region: the
 * tier is already critical when a photo grid is opened, so this is read in normal reading order
 * rather than announced (and a conditionally-mounted `role="status"` mostly isn't announced
 * anyway — see the Foundry `LiveRegion` docblock).
 */
import { WarningIcon } from '@/components/icons';
import { useT } from '@/features/i18n';
import { useStorageStore } from '@/state/stores/useStorageStore';

export function FullResDisabledNote() {
  const t = useT();
  const tier = useStorageStore((state) => state.tier);
  if (tier !== 'critical') return null;

  return (
    <p
      data-testid="full-res-disabled-note"
      className="flex items-start gap-1.5 text-xs text-warning [&_svg]:mt-px [&_svg]:size-3.5 [&_svg]:shrink-0"
    >
      <WarningIcon aria-hidden="true" />
      <span>{t('media.fullResDisabled')}</span>
    </p>
  );
}
