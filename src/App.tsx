import { useState } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { AppErrorBoundary } from '@/app/error/AppErrorBoundary';
import { BootGate } from '@/app/boot/BootGate';
import { SignInGate } from '@/features/users/SignInGate';
import { createQueryClient } from '@/state/query/queryClient';
import { router } from '@/app/router';
import { BurstProvider, ToastProvider } from '@/components/foundry';
import { ScrapeBridgeProvider } from '@/features/scraping';
import { ActiveTabScrapeListener } from '@/features/inventory/components/ActiveTabScrapeListener';
import { FirstItemCelebration } from '@/features/inventory/components/FirstItemCelebration';
import { ReminderNotifications } from '@/features/alerts/ReminderNotifications';
import { OrphanImageSweeper } from '@/features/maintenance/OrphanImageSweeper';
import { useApplyTheme } from '@/features/settings/useApplyTheme';
import { useApplyLanguage } from '@/features/i18n';
import { PwaUpdatePrompt } from '@/components/PwaUpdatePrompt';
import { ClockOverrideBadge } from '@/features/lab/ClockOverrideBadge';
import { ClockSkewBadge } from '@/features/clock-skew/ClockSkewBadge';

/**
 * Application composition root (spec §2.1, §2.2, §3).
 *
 * Layering: a top-level error boundary (Safe Mode) wraps the Tier-1 Query client,
 * which wraps the boot gate. The router — and therefore any code that touches the
 * database — only mounts once the boot gate reports the database ready.
 *
 * {@link PwaUpdatePrompt} is a sibling of <BootGate>, not nested inside it: it owns the
 * only service-worker registration in the app, and that worker is what supplies the
 * COOP/COEP headers BootGate's cross-origin-isolation check requires on a static host
 * (GitHub Pages — spec §2.2.6). Nesting it inside BootGate would deadlock a first-ever
 * visit: BootGate never reaches `ready` without isolation, isolation never arrives
 * without the worker registering, and the worker never registers without this mounting.
 */
export function App() {
  const [queryClient] = useState(createQueryClient);
  useApplyTheme();
  // Keep the active message catalog in step with the formatting locale (G4): text and
  // number/date/currency formatting share the one locale.
  useApplyLanguage();

  return (
    <AppErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          {/* App-wide milestone success burst overlay (visual-flair F4). Sits above the router so
              any feature can fire a one-shot celebration via `useBurst()`; its fixed overlay is
              pointer-events-none and decorative (aria-hidden). */}
          <BurstProvider>
            <ScrapeBridgeProvider>
              <PwaUpdatePrompt />
              {/* Says so on screen whenever the hidden date override is shifting what the app
                  treats as "today" — a shifted clock is otherwise invisible and changes what
                  counts as expired/overdue everywhere. Renders nothing in normal use. Outside
                  BootGate so it shows even on the boot screens, which are date-driven too. */}
              <ClockOverrideBadge />
              {/* Says so on screen when *this device's* clock is materially wrong (#326). Gubbins
                  corrects for the error rather than judging on it, but a silent correction would
                  leave the app disagreeing with the taskbar clock for no visible reason. Renders
                  nothing when the clock is trustworthy. */}
              <ClockSkewBadge />
              <BootGate>
                {/* Sign-in gate (issue #79): inside BootGate because it reads users from the
                    database, and wrapping the router because "sign-in is required" has to mean
                    there is no route to reach past it. Renders its children untouched — and
                    does no work at all — while the users module is off, which is the state the
                    app ships in. */}
                <SignInGate>
                  <RouterProvider router={router} />
                  {/* Path A2: receives an Amazon active-tab scrape and opens the reviewable
                    add-item dialog. Inside BootGate so the DB/queries it needs are ready. */}
                  <ActiveTabScrapeListener />
                  {/* Milestone burst (F4): celebrates the first item ever added. Inside BootGate so
                    the item-count query it watches has a ready database. */}
                  <FirstItemCelebration />
                  {/* Local reminder notifications (G3): fires OS notifications for due alerts and
                    handles their clicks. Inside BootGate so the alert feeds it reads have a ready
                    database; renders nothing. Opt-in and silent unless enabled + permission granted. */}
                  <ReminderNotifications />
                  {/* Reclaims full-resolution image files left in OPFS by item deletes and sync
                    merges (#206). Inside BootGate so the database it queries is ready; renders
                    nothing and runs a throttled, race-safe background sweep. */}
                  <OrphanImageSweeper />
                </SignInGate>
              </BootGate>
            </ScrapeBridgeProvider>
          </BurstProvider>
        </ToastProvider>
      </QueryClientProvider>
    </AppErrorBoundary>
  );
}
