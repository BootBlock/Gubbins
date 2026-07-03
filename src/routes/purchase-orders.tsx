import { createFileRoute } from '@tanstack/react-router';
import { ModuleGuard } from '@/features/modules/ModuleGuard';
import { PurchaseOrdersScreen } from '@/features/purchasing/PurchaseOrdersScreen';

export const Route = createFileRoute('/purchase-orders')({
  component: () => (
    <ModuleGuard feature="purchase-orders">
      <PurchaseOrdersScreen />
    </ModuleGuard>
  ),
});
