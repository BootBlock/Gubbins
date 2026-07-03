import { createFileRoute } from '@tanstack/react-router';
import { BookingsScreen } from '@/features/bookings/BookingsScreen';
import { ModuleGuard } from '@/features/modules/ModuleGuard';

export const Route = createFileRoute('/bookings')({
  component: () => (
    <ModuleGuard feature="bookings">
      <BookingsScreen />
    </ModuleGuard>
  ),
});
