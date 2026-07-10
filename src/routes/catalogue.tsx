import { createFileRoute } from '@tanstack/react-router';
import { ModuleGuard } from '@/features/modules/ModuleGuard';
import { CatalogueScreen } from '@/features/reports/CatalogueScreen';

export const Route = createFileRoute('/catalogue')({
  component: () => (
    <ModuleGuard feature="reports">
      <CatalogueScreen />
    </ModuleGuard>
  ),
});
