import { createFileRoute } from '@tanstack/react-router';
import { UsersScreen } from '@/features/users/UsersScreen';
import { ModuleGuard } from '@/features/modules/ModuleGuard';

export const Route = createFileRoute('/users')({
  component: () => (
    <ModuleGuard feature="users">
      <UsersScreen />
    </ModuleGuard>
  ),
});
