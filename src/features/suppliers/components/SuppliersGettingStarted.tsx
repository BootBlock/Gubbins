import { Surface } from '@/components/foundry';
import { SupplierIcon } from '@/components/icons';
import { useT } from '@/features/i18n';

/**
 * SuppliersGettingStarted — the first-run panel for the Suppliers screen (#423).
 *
 * Shown in place of the list only when the dictionary is confirmed empty and nothing is being
 * searched for, since either case means the screen has something to say for itself already.
 * "No suppliers yet" told a first-time user what was missing but never what a supplier is for,
 * on a screen whose whole point is a concept they may not have met yet — so the empty state
 * explains the feature instead of merely reporting its absence.
 *
 * Mirrors {@link ContactsGettingStarted}'s icon+heading+body shape. It carries no buttons: the
 * header's "Add supplier" is the call to action, and the panel's own point is that naming a
 * supplier on a part or an order works just as well.
 */
export function SuppliersGettingStarted() {
  const t = useT();

  return (
    <Surface className="flex flex-1 flex-col gap-4 p-5" data-testid="suppliers-getting-started">
      <div className="flex items-center gap-2.5 text-muted-foreground [&_svg]:size-5">
        <SupplierIcon aria-hidden />
        <h3 className="text-sm font-semibold text-foreground">{t('suppliers.gettingStarted.heading')}</h3>
      </div>
      <p className="max-w-2xl text-sm text-muted-foreground">{t('suppliers.gettingStarted.bodyPurpose')}</p>
      <p className="max-w-2xl text-sm text-muted-foreground">{t('suppliers.gettingStarted.bodyWhy')}</p>
      <p className="max-w-2xl text-sm text-muted-foreground">{t('suppliers.gettingStarted.bodyHowTo')}</p>
    </Surface>
  );
}
