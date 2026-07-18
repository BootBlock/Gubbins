import { createFileRoute } from '@tanstack/react-router';
import { WebhooksScreen } from '@/features/webhooks/WebhooksScreen';
import { ModuleGuard } from '@/features/modules/ModuleGuard';

export const Route = createFileRoute('/webhooks')({
  component: () => (
    <ModuleGuard feature="webhooks">
      <WebhooksScreen />
    </ModuleGuard>
  ),
});
