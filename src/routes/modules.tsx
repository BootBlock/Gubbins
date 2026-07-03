import { createFileRoute } from '@tanstack/react-router';
import { ModulesScreen } from '@/features/modules/ModulesScreen';

export const Route = createFileRoute('/modules')({
  component: ModulesScreen,
});
