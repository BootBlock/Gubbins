import { createFileRoute } from '@tanstack/react-router';
import { SyncScreen } from '@/features/sync/SyncScreen';

export const Route = createFileRoute('/sync')({
  component: SyncScreen,
});
