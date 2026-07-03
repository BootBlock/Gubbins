import { createFileRoute } from '@tanstack/react-router';
import { ModuleGuard } from '@/features/modules/ModuleGuard';
import { ReportsScreen } from '@/features/reports/ReportsScreen';

export const Route = createFileRoute('/reports')({
  component: () => (
    <ModuleGuard feature="reports">
      <ReportsScreen />
    </ModuleGuard>
  ),
});
