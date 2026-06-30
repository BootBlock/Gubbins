import { createFileRoute } from '@tanstack/react-router';
import { PurchaseOrdersScreen } from '@/features/purchasing/PurchaseOrdersScreen';

export const Route = createFileRoute('/purchase-orders')({
  component: PurchaseOrdersScreen,
});
