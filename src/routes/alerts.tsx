import { createFileRoute } from '@tanstack/react-router';
import { AlertsScreen } from '@/features/alerts/AlertsScreen';
import { ModuleGuard } from '@/features/modules/ModuleGuard';

export const Route = createFileRoute('/alerts')({
  component: () => (
    <ModuleGuard feature="alerts">
      <AlertsScreen />
    </ModuleGuard>
  ),
});
