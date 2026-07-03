import { createFileRoute } from '@tanstack/react-router';
import { CalendarScreen } from '@/features/calendar/CalendarScreen';
import { ModuleGuard } from '@/features/modules/ModuleGuard';

export const Route = createFileRoute('/upcoming')({
  component: () => (
    <ModuleGuard feature="upcoming">
      <CalendarScreen />
    </ModuleGuard>
  ),
});
