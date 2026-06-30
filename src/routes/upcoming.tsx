import { createFileRoute } from '@tanstack/react-router';
import { CalendarScreen } from '@/features/calendar/CalendarScreen';

export const Route = createFileRoute('/upcoming')({
  component: CalendarScreen,
});
