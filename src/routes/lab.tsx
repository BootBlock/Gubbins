import { createFileRoute } from '@tanstack/react-router';
import { LabScreen } from '@/features/lab/LabScreen';

/**
 * The hidden lab screen. Deliberately absent from the global nav, the command palette and the
 * wiki — reachable only by typing `/lab`.
 */
export const Route = createFileRoute('/lab')({
  component: LabScreen,
});
