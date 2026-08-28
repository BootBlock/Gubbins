/**
 * DashboardGettingStarted — the first-run panel (improvement #5).
 *
 * While the inventory is still empty, the actionable widgets all render "nothing here"
 * rows, which makes a fresh install read as a discouraging wall of emptiness and hides the
 * real next step. This panel takes that prime spot instead, pointing at the three ways to
 * get data in: add an item, import a file, or scan a barcode. It self-hides once any item
 * exists, while the count is still loading (to avoid a flash), or when the
 * `dashboardGettingStarted` preference is off. Scan is dropped when the `scanner` capability
 * is off, exactly as the hero quick-actions drop theirs. The action buttons reuse the same
 * one-shot intent handoff ({@link useInventoryEntry}) as the hero quick-actions.
 */
import { Link } from '@tanstack/react-router';
import { cn } from '@/lib/utils';
import { Surface, buttonVariants } from '@/components/foundry';
import { AddIcon, ImportIcon, ScanIcon, PackageIcon } from '@/components/icons';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { ROUTE_PERMISSIONS } from '@/components/nav/nav-destinations';
import { usePermission } from '@/features/users/usePermission';
import { useItemCount } from '@/features/inventory/queries';
import { useInventoryEntry } from '@/features/inventory/useInventoryEntry';
import { useFeature } from '@/features/modules/useFeature';
import { useT } from '@/features/i18n';

export function DashboardGettingStarted() {
  const t = useT();
  const enabled = usePreferencesStore((s) => s.dashboardGettingStarted);
  // Count every item (including inactive) so the panel only shows on a genuinely empty
  // database, not when the last item has merely been archived.
  const count = useItemCount({ includeInactive: true });

  // Every button here lands on Inventory, so a role that cannot open it is not invited to
  // start there — the panel would be three routes to the refusal page (issue #522).
  const mayReachInventory = usePermission(ROUTE_PERMISSIONS.get('/inventory'));
  // Scan opens live camera scanning — the `scanner` capability (modular-ui-plan §4, Phase 6).
  // This panel is on screen seconds after the first-run module chooser, so offering a button
  // for the capability just switched off is the module system contradicting itself at its most
  // visible moment (issue #636). Add and Import always stay.
  const scannerEnabled = useFeature('scanner');

  // Don't render while loading (no count yet), once there's data, when switched off, or when
  // this role cannot reach the screen every action points at.
  if (!enabled || count.isPending || (count.data ?? 0) > 0) return null;
  if (!mayReachInventory) return null;

  return (
    <Surface className="flex flex-col gap-4 p-5" data-testid="dashboard-getting-started">
      <div className="flex items-center gap-2.5 text-muted-foreground [&_svg]:size-5">
        <PackageIcon aria-hidden />
        <h2 className="text-sm font-semibold text-foreground">{t('dashboard.gettingStarted.heading')}</h2>
      </div>
      {/* The body names the three routes in, so it drops the barcode clause alongside the button
          it describes — copy that still says "scan a barcode" with no control to do it is the
          same contradiction one sentence further down the panel. */}
      <p className="text-sm text-muted-foreground">
        {t(scannerEnabled ? 'dashboard.gettingStarted.body' : 'dashboard.gettingStarted.bodyNoScan')}
      </p>
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
        {scannerEnabled ? (
          <Link
            to="/inventory"
            onClick={() => useInventoryEntry.getState().requestIntent('scan')}
            className={cn(buttonVariants({ variant: 'outline' }))}
            data-testid="getting-started-scan"
          >
            <ScanIcon />
            {t('dashboard.gettingStarted.scan')}
          </Link>
        ) : null}
      </div>
    </Surface>
  );
}
