import { createFileRoute } from '@tanstack/react-router';
import { BookingsScreen } from '@/features/bookings/BookingsScreen';

export const Route = createFileRoute('/bookings')({
  component: BookingsScreen,
});
