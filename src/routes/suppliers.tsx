import { createFileRoute } from '@tanstack/react-router';
import { ModuleGuard } from '@/features/modules/ModuleGuard';
import { SuppliersScreen } from '@/features/suppliers/SuppliersScreen';

export const Route = createFileRoute('/suppliers')({
  component: () => (
    <ModuleGuard feature="suppliers">
      <SuppliersScreen />
    </ModuleGuard>
  ),
});
