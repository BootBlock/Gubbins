import { createFileRoute } from '@tanstack/react-router';
import { ActivityFeedScreen } from '@/features/activity/ActivityFeedScreen';
import { ModuleGuard } from '@/features/modules/ModuleGuard';

export const Route = createFileRoute('/activity')({
  component: () => (
    <ModuleGuard feature="activity">
      <ActivityFeedScreen />
    </ModuleGuard>
  ),
});
