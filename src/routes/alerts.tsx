import { createFileRoute } from '@tanstack/react-router';
import { AlertsScreen } from '@/features/alerts/AlertsScreen';

export const Route = createFileRoute('/alerts')({
  component: AlertsScreen,
});
