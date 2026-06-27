import { useState } from 'react';
import { Button } from '@/components/foundry';
import {
  CheckoutIcon,
  DeleteIcon,
  EditIcon,
  GaugeIcon,
  MoveIcon,
  QrCodeIcon,
  RestoreIcon,
} from '@/components/icons';
import type { Item, LocationWithCount } from '@/db/repositories';
import { CheckoutDialog } from '@/features/contacts/components/CheckoutDialog';
import { useRestoreItem, useSoftDeleteItem } from '../mutations';
import { GaugeAdjustDialog } from './GaugeAdjustDialog';
import { ItemDetailDialog } from './ItemDetailDialog';
import { MoveItemDialog } from './MoveItemDialog';
import { QrCodeDialog } from './QrCodeDialog';

/**
 * Shared item action controls (move, update gauge, soft-delete/restore) plus the
 * dialogs they open. Used by both the Visual and Data presentations so behaviour
 * stays identical across the density toggle.
 */
export function ItemActions({
  item,
  locations,
  compact = false,
}: {
  item: Item;
  locations: readonly LocationWithCount[];
  compact?: boolean;
}) {
  const [dialog, setDialog] = useState<'move' | 'gauge' | 'details' | 'qr' | 'checkout' | null>(null);
  const softDelete = useSoftDeleteItem();
  const restore = useRestoreItem();
  const size = compact ? 'size-8' : '';

  return (
    <div className="flex items-center gap-1">
      <Button variant="outline" size="icon" className={size} aria-label="Item details" onClick={() => setDialog('details')}>
        <EditIcon />
      </Button>
      {item.trackingMode === 'CONSUMABLE_GAUGE' ? (
        <Button variant="outline" size="icon" className={size} aria-label="Update gauge" onClick={() => setDialog('gauge')}>
          <GaugeIcon />
        </Button>
      ) : null}
      <Button variant="outline" size="icon" className={size} aria-label="Move item" onClick={() => setDialog('move')}>
        <MoveIcon />
      </Button>
      <Button variant="outline" size="icon" className={size} aria-label="QR code" onClick={() => setDialog('qr')}>
        <QrCodeIcon />
      </Button>
      {item.isActive && item.trackingMode !== 'CONSUMABLE_GAUGE' ? (
        <Button variant="outline" size="icon" className={size} aria-label="Check out" onClick={() => setDialog('checkout')}>
          <CheckoutIcon />
        </Button>
      ) : null}
      {item.isActive ? (
        <Button
          variant="ghost"
          size="icon"
          className={size}
          aria-label="Remove from inventory"
          onClick={() => softDelete.mutate({ id: item.id })}
        >
          <DeleteIcon />
        </Button>
      ) : (
        <Button variant="ghost" size="icon" className={size} aria-label="Restore item" onClick={() => restore.mutate(item.id)}>
          <RestoreIcon />
        </Button>
      )}

      <MoveItemDialog item={item} open={dialog === 'move'} onClose={() => setDialog(null)} locations={locations} />
      {item.gauge ? (
        <GaugeAdjustDialog item={item} open={dialog === 'gauge'} onClose={() => setDialog(null)} />
      ) : null}
      <ItemDetailDialog item={item} open={dialog === 'details'} onClose={() => setDialog(null)} />
      <QrCodeDialog itemId={item.id} itemName={item.name} open={dialog === 'qr'} onClose={() => setDialog(null)} />
      <CheckoutDialog item={item} open={dialog === 'checkout'} onClose={() => setDialog(null)} />
    </div>
  );
}
