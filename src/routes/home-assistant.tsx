import { createFileRoute } from '@tanstack/react-router';
import { HomeAssistantSetupScreen } from '@/features/home-assistant/HomeAssistantSetupScreen';

export const Route = createFileRoute('/home-assistant')({
  component: HomeAssistantSetupScreen,
});
