import { createFileRoute } from '@tanstack/react-router';
import { ImportLaunchScreen } from '@/features/share/ImportLaunchScreen';

/**
 * File-handler landing route (plan EI-4). The OS opens a data file "with Gubbins" here; the
 * launched PWA reads it via `window.launchQueue` and seeds the import dialog.
 */
export const Route = createFileRoute('/import')({
  component: ImportLaunchScreen,
});
