/**
 * `ItemReservationsPanel` — the item side of project reservations (issue #653): "how much of
 * this is actually free, and who has spoken for the rest?".
 *
 * A reservation used to be written onto a BOM line and never read back anywhere but that one
 * project's shopping list, so two projects could each reserve more of a part than exists with
 * neither noticing. This is the read that closes it: the item's on-hand quantity, everything
 * open projects claim of it, and what is left over.
 *
 * Loans are already accounted for and are deliberately not listed: checking an item out
 * decrements its on-hand quantity, so the figure this starts from is post-loan.
 *
 * Read-only on purpose. A claim belongs to the project that made it, and releasing one from
 * here would change a bill of materials from a screen that shows no bill of materials — so the
 * panel names the project instead and leaves the change where it is made.
 */
import { Spinner, Tooltip } from '@/components/foundry';
import { ProjectIcon, WarningIcon } from '@/components/icons';
import type { Item } from '@/db/repositories';
import { useT } from '@/features/i18n';
import { cn } from '@/lib/utils';
import { useItemAvailability } from '../queries';

export function ItemReservationsPanel({ item }: { item: Item }) {
  const t = useT();
  const { data: availability, isLoading } = useItemAvailability(item.id);

  if (isLoading) {
    return (
      <div className="flex justify-center p-4">
        <Spinner />
      </div>
    );
  }
  // Absent means the id matched no item — a race with a delete, not "nothing reserved". Say
  // nothing rather than draw a confident "0 reserved" for a row that is on its way out.
  if (availability === undefined) return null;

  const { onHandQty, reservedQty, availableQty, overCommittedQty, isUnlimited, claims } = availability;

  return (
    <div className="space-y-field-gap">
      <div className="grid grid-cols-3 gap-2 text-sm">
        <Figure label={t('inventory.reservations.onHand', { vars: { count: onHandQty } })} />
        <Figure label={t('inventory.reservations.reserved', { vars: { count: reservedQty } })} />
        <Figure
          label={t('inventory.reservations.available', { vars: { count: availableQty } })}
          tone={availableQty === 0 && reservedQty > 0 ? 'warning' : 'default'}
        />
      </div>

      {isUnlimited ? (
        <p className="text-xs text-muted-foreground">{t('inventory.reservations.unlimited')}</p>
      ) : null}

      {overCommittedQty > 0 ? (
        // More is claimed than exists. `role="alert"` rather than a tinted line: this is the
        // condition the whole panel exists to catch, and it must reach a screen reader too.
        <p
          role="alert"
          className="flex items-start gap-1.5 rounded-lg bg-destructive/10 p-2 text-xs text-destructive [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0"
          data-testid="item-over-committed"
        >
          <WarningIcon aria-hidden />
          <span>
            {t(
              overCommittedQty === 1
                ? 'inventory.reservations.overCommitted.one'
                : 'inventory.reservations.overCommitted.other',
              { vars: { count: overCommittedQty } },
            )}
          </span>
        </p>
      ) : null}

      {claims.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('inventory.reservations.none')}</p>
      ) : (
        <ul className="divide-y divide-border/60 rounded-xl border border-border">
          {claims.map((claim) => {
            const backing = availability.backingByLine.get(claim.lineId);
            const unbackedQty = backing?.unbackedQty ?? 0;
            return (
              <li key={claim.lineId} className="flex items-center gap-2 px-3 py-2 text-sm">
                <ProjectIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{claim.projectName}</span>
                <span className="rounded-full bg-secondary px-2 py-0.5 text-xs text-secondary-foreground">
                  {t(
                    claim.status === 'ACTUAL'
                      ? 'inventory.reservations.status.actual'
                      : 'inventory.reservations.status.tentative',
                  )}
                </span>
                <span className="tabular-nums text-xs text-muted-foreground">
                  {t('inventory.reservations.claim.held', { vars: { count: backing?.backedQty ?? 0 } })}
                </span>
                {unbackedQty > 0 ? (
                  <Tooltip content={t('inventory.reservations.claim.unbackedTooltip')} triggerTabIndex={-1}>
                    <span className="tabular-nums rounded-full bg-destructive/10 px-2 py-0.5 text-xs text-destructive">
                      {t('inventory.reservations.claim.unbacked', { vars: { count: unbackedQty } })}
                    </span>
                  </Tooltip>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * One headline figure. Each label already reads as a whole phrase ("6 in stock"), so it is one
 * string rather than a term/value pair — splitting it would only make a screen reader announce
 * the number twice.
 */
function Figure({ label, tone = 'default' }: { label: string; tone?: 'default' | 'warning' }) {
  return (
    <div
      className={cn('rounded-lg bg-secondary/50 px-3 py-2 font-medium', tone === 'warning' && 'text-warning')}
    >
      {label}
    </div>
  );
}
