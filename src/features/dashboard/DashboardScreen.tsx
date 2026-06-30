import { cn } from '@/lib/utils';
import { MAIN_CONTENT_ID, PageContainer } from '@/components/foundry';
import { BrandMark } from '@/components/BrandMark';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useWakeLock } from './useWakeLock';
import { DashboardGrid } from './DashboardGrid';
import { DashboardNav } from './DashboardNav';

/**
 * Landing screen — the §3 customisable widget board. The fixed status cards of the
 * earlier phases are now pinnable widgets in {@link DashboardGrid} (drag-and-drop +
 * keyboard reorder, show/hide, persisted to `useLayoutStore`). The header is the brand
 * hero; the grouped destination tiles live in {@link DashboardNav} below it.
 */
export function DashboardScreen() {
  const kioskMode = usePreferencesStore((state) => state.kioskMode);

  // §3 Kiosk & Tablet Ergonomics: keep a hardwired dashboard awake while kiosk mode
  // is on (feature-detected, graceful). The matching touch/selection containment is
  // applied to the content landmark below.
  useWakeLock(kioskMode);

  return (
    <PageContainer>
      <header className="flex flex-wrap items-center gap-4">
        <BrandMark className="size-12 rounded-2xl" />
        <div>
          <h1 className="bg-gradient-to-br from-foreground to-foreground/60 bg-clip-text text-2xl font-semibold tracking-tight text-transparent">
            Gubbins
          </h1>
          <p className="text-sm text-muted-foreground">Local-first inventory · your dashboard</p>
        </div>
      </header>

      {/* The landing hub shows every destination as a grouped tile grid, mapped from the
          same NAV_DESTINATIONS source of truth the global AppNav menu uses on every other
          screen — so the two can never drift. */}
      <DashboardNav />

      <main
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
        data-kiosk={kioskMode ? 'on' : undefined}
        className={cn('outline-none', kioskMode && 'touch-pan-y select-none')}
      >
        <DashboardGrid />
      </main>
    </PageContainer>
  );
}
