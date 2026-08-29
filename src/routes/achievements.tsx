import { createFileRoute } from '@tanstack/react-router';
import { AchievementsScreen } from '@/features/achievements/AchievementsScreen';

export const Route = createFileRoute('/achievements')({
  component: AchievementsScreen,
});
