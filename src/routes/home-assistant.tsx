import { createFileRoute } from '@tanstack/react-router';
import { HomeAssistantSetupScreen } from '@/features/home-assistant/HomeAssistantSetupScreen';
import { ModuleGuard } from '@/features/modules/ModuleGuard';

export const Route = createFileRoute('/home-assistant')({
  component: () => (
    <ModuleGuard feature="home-assistant">
      <HomeAssistantSetupScreen />
    </ModuleGuard>
  ),
});
