/**
 * The location delete confirmation (issue #823).
 *
 * Deleting a location is a hard delete with no undo: it tombstones the row for every synced
 * device, and everything hanging off that row cascades with it — its photos, the regions drawn on
 * those photos, the item placements pinned to those regions, its tags and its custom-field values.
 * The confirmation this replaced only ever appeared when items were homed *directly* in the
 * location, so a photographed, region-mapped shelf holding nothing of its own went in one click.
 *
 * So the dialog is unconditional, and its body is proportionate instead: it reads the real impact
 * from the database and names what moves separately from what is destroyed. Reading it here rather
 * than in the sidebar is what keeps the query scoped to the moments the dialog is on screen.
 */
import { useRef } from 'react';
import { Banner, Button, LiveRegion, Modal, Spinner } from '@/components/foundry';
import { DeleteIcon } from '@/components/icons';
import { useT } from '@/features/i18n';
import { useLocationDeleteImpact } from '../queries';
import { summariseLocationDelete } from '../location-delete-impact';

export function DeleteLocationDialog({
  id,
  name,
  busy,
  onCancel,
  onConfirm,
}: {
  readonly id: string;
  readonly name: string;
  /** The delete write is in flight — the buttons lock and the confirm shows a spinner. */
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const t = useT();
  const impact = useLocationDeleteImpact(id);
  // Initial focus lands on Cancel, so a reflex Enter keeps the location (the #588 precedent).
  const cancelRef = useRef<HTMLButtonElement>(null);

  const summary = impact.data
    ? summariseLocationDelete(
        impact.data,
        impact.data.promotedToName ?? t('inventory.locations.delete.topLevel'),
      )
    : null;
  const nothingToSay = summary !== null && summary.moves.length === 0 && summary.destroys.length === 0;

  return (
    <Modal
      open
      onClose={onCancel}
      title={t('inventory.locations.delete.title')}
      description={t('inventory.locations.delete.intro', { vars: { name } })}
      initialFocusRef={cancelRef}
      busy={busy}
    >
      <div className="flex flex-col gap-4">
        {/* The counts land a moment after the dialog opens, and the confirm button is held
            until they do — so a screen-reader user is told what arrived rather than being left
            with a description that no longer says everything the dialog does. The region is
            mounted with the dialog and only its children change, which is what `LiveRegion`
            exists to get right. */}
        <LiveRegion className="text-sm" data-testid="delete-location-impact">
          {impact.isPending ? (
            <p className="text-muted-foreground">{t('inventory.locations.delete.checking')}</p>
          ) : null}
          {impact.isError ? (
            // The counts are unavailable, but the cascade is not conditional on reading them —
            // say what goes regardless rather than presenting an empty, reassuring dialog.
            <Banner tone="warning">{t('inventory.locations.delete.checkFailed')}</Banner>
          ) : null}
          {nothingToSay ? (
            <p className="text-muted-foreground">{t('inventory.locations.delete.empty')}</p>
          ) : null}
          {summary && summary.moves.length > 0 ? (
            <>
              <p className="font-medium">{t('inventory.locations.delete.moves.heading')}</p>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
                {summary.moves.map((line) => (
                  <li key={line.key}>{t(line.key, { vars: line.vars })}</li>
                ))}
              </ul>
            </>
          ) : null}
          {summary && summary.destroys.length > 0 ? (
            <>
              <p className={summary.moves.length > 0 ? 'mt-4 font-medium' : 'font-medium'}>
                {t('inventory.locations.delete.destroys.heading')}
              </p>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-destructive">
                {summary.destroys.map((line) => (
                  <li key={line.key}>{t(line.key, { vars: line.vars })}</li>
                ))}
              </ul>
            </>
          ) : null}
        </LiveRegion>
        <div className="flex justify-end gap-2">
          <Button ref={cancelRef} variant="ghost" onClick={onCancel} disabled={busy}>
            {t('inventory.locations.delete.cancel')}
          </Button>
          <Button
            variant="destructive"
            onClick={onConfirm}
            // Held until the impact read settles — successfully or not — so the dialog can never
            // be confirmed before it has had the chance to say what it is about to destroy.
            disabled={busy || impact.isPending}
            data-testid="confirm-delete-location"
          >
            {busy ? <Spinner /> : <DeleteIcon />}
            {t('inventory.locations.delete.confirm')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
