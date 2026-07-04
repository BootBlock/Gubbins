import { useState } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { AppErrorBoundary } from '@/app/error/AppErrorBoundary';
import { BootGate } from '@/app/boot/BootGate';
import { createQueryClient } from '@/state/query/queryClient';
import { router } from '@/app/router';
import { ToastProvider } from '@/components/foundry';
import { ScrapeBridgeProvider } from '@/features/scraping';
import { ActiveTabScrapeListener } from '@/features/inventory/components/ActiveTabScrapeListener';
import { useApplyTheme } from '@/features/settings/useApplyTheme';

/**
 * Application composition root (spec §2.1, §2.2, §3).
 *
 * Layering: a top-level error boundary (Safe Mode) wraps the Tier-1 Query client,
 * which wraps the boot gate. The router — and therefore any code that touches the
 * database — only mounts once the boot gate reports the database ready.
 */
export function App() {
  const [queryClient] = useState(createQueryClient);
  useApplyTheme();

  return (
    <AppErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <ScrapeBridgeProvider>
            <BootGate>
              <RouterProvider router={router} />
              {/* Path A2: receives an Amazon active-tab scrape and opens the reviewable
                  add-item dialog. Inside BootGate so the DB/queries it needs are ready. */}
              <ActiveTabScrapeListener />
            </BootGate>
          </ScrapeBridgeProvider>
        </ToastProvider>
      </QueryClientProvider>
    </AppErrorBoundary>
  );
}
