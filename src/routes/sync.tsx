import { createFileRoute } from '@tanstack/react-router';
import { ModuleGuard } from '@/features/modules/ModuleGuard';
import { SyncScreen } from '@/features/sync/SyncScreen';

export const Route = createFileRoute('/sync')({
  component: () => (
    <ModuleGuard feature="sync">
      <SyncScreen />
    </ModuleGuard>
  ),
});
