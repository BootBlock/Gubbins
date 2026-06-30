import { createFileRoute } from '@tanstack/react-router';
import { ReportsScreen } from '@/features/reports/ReportsScreen';

export const Route = createFileRoute('/reports')({
  component: ReportsScreen,
});
