import { createFileRoute } from '@tanstack/react-router';
import { ActivityFeedScreen } from '@/features/activity/ActivityFeedScreen';

export const Route = createFileRoute('/activity')({
  component: ActivityFeedScreen,
});
