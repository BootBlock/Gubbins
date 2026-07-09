import { createFileRoute } from '@tanstack/react-router';
import { ModuleGuard } from '@/features/modules/ModuleGuard';
import { InsuranceScheduleScreen } from '@/features/reports/InsuranceScheduleScreen';

export const Route = createFileRoute('/insurance-schedule')({
  component: () => (
    <ModuleGuard feature="reports">
      <InsuranceScheduleScreen />
    </ModuleGuard>
  ),
});
