import { useState } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { AppErrorBoundary } from '@/app/error/AppErrorBoundary';
import { BootGate } from '@/app/boot/BootGate';
import { createQueryClient } from '@/state/query/queryClient';
import { router } from '@/app/router';
import { ToastProvider } from '@/components/foundry';
import { ScrapeBridgeProvider } from '@/features/scraping';

/**
 * Application composition root (spec §2.1, §2.2, §3).
 *
 * Layering: a top-level error boundary (Safe Mode) wraps the Tier-1 Query client,
 * which wraps the boot gate. The router — and therefore any code that touches the
 * database — only mounts once the boot gate reports the database ready.
 */
export function App() {
  const [queryClient] = useState(createQueryClient);

  return (
    <AppErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <ScrapeBridgeProvider>
            <BootGate>
              <RouterProvider router={router} />
            </BootGate>
          </ScrapeBridgeProvider>
        </ToastProvider>
      </QueryClientProvider>
    </AppErrorBoundary>
  );
}
