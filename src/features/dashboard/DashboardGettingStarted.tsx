/**
 * DashboardGettingStarted — the first-run panel (improvement #5).
 *
 * While the inventory is still empty, the actionable widgets all render "nothing here"
 * rows, which makes a fresh install read as a discouraging wall of emptiness and hides the
 * real next step. This panel takes that prime spot instead, pointing at the three ways to
 * get data in: add an item, import a file, or scan a barcode. It self-hides once any item
 * exists, while the count is still loading (to avoid a flash), or when the
 * `dashboardGettingStarted` preference is off. The action buttons reuse the same one-shot
 * intent handoff ({@link useInventoryEntry}) as the hero quick-actions.
 */
import { Link } from '@tanstack/react-router';
import { cn } from '@/lib/utils';
import { Surface, buttonVariants } from '@/components/foundry';
import { AddIcon, ImportIcon, ScanIcon, PackageIcon } from '@/components/icons';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useItemCount } from '@/features/inventory/queries';
import { useInventoryEntry } from '@/features/inventory/useInventoryEntry';
import { useT } from '@/features/i18n';

export function DashboardGettingStarted() {
  const t = useT();
  const enabled = usePreferencesStore((s) => s.dashboardGettingStarted);
  // Count every item (including inactive) so the panel only shows on a genuinely empty
  // database, not when the last item has merely been archived.
  const count = useItemCount({ includeInactive: true });

  // Don't render while loading (no count yet), once there's data, or when switched off.
  if (!enabled || count.isPending || (count.data ?? 0) > 0) return null;

  return (
    <Surface className="flex flex-col gap-4 p-5" data-testid="dashboard-getting-started">
      <div className="flex items-center gap-2.5 text-muted-foreground [&_svg]:size-5">
        <PackageIcon aria-hidden />
        <h2 className="text-sm font-semibold text-foreground">{t('dashboard.gettingStarted.heading')}</h2>
      </div>
      <p className="text-sm text-muted-foreground">{t('dashboard.gettingStarted.body')}</p>
      <div className="flex flex-wrap gap-2">
        <Link
          to="/inventory"
          onClick={() => useInventoryEntry.getState().requestIntent('add')}
          className={cn(buttonVariants({ variant: 'primary' }))}
          data-testid="getting-started-add"
        >
          <AddIcon />
          {t('dashboard.gettingStarted.add')}
        </Link>
        <Link
          to="/inventory"
          onClick={() => useInventoryEntry.getState().requestIntent('import')}
          className={cn(buttonVariants({ variant: 'outline' }))}
          data-testid="getting-started-import"
        >
          <ImportIcon />
          {t('dashboard.gettingStarted.import')}
        </Link>
        <Link
          to="/inventory"
          onClick={() => useInventoryEntry.getState().requestIntent('scan')}
          className={cn(buttonVariants({ variant: 'outline' }))}
          data-testid="getting-started-scan"
        >
          <ScanIcon />
          {t('dashboard.gettingStarted.scan')}
        </Link>
      </div>
    </Surface>
  );
}
