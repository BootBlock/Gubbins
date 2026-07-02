import { useState } from 'react';
import { Button, Tooltip } from '@/components/foundry';
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
      <Tooltip content="Open the full item record — edit its details, images, tags, capabilities, custom fields & datasheets." triggerTabIndex={-1}>
        <span>
          <Button variant="outline" size="icon" className={size} aria-label="Item details" onClick={() => setDialog('details')}>
            <EditIcon className="text-glyph-edit" />
          </Button>
        </span>
      </Tooltip>
      {item.trackingMode === 'CONSUMABLE_GAUGE' ? (
        <Tooltip content="Record usage or weigh-in against a scale to update the remaining level." triggerTabIndex={-1}>
          <span>
            <Button variant="outline" size="icon" className={size} aria-label="Update gauge" onClick={() => setDialog('gauge')}>
              <GaugeIcon className="text-glyph-gauge" />
            </Button>
          </span>
        </Tooltip>
      ) : null}
      <Tooltip content="Move this item to another location. The move is recorded in the activity log." triggerTabIndex={-1}>
        <span>
          <Button variant="outline" size="icon" className={size} aria-label="Move item" onClick={() => setDialog('move')}>
            <MoveIcon className="text-glyph-move" />
          </Button>
        </span>
      </Tooltip>
      <Tooltip content="Show a printable label — a QR that deep-links back to this item, and/or a Code 128 barcode of its MPN." triggerTabIndex={-1}>
        <span>
          <Button variant="outline" size="icon" className={size} aria-label="Item label" onClick={() => setDialog('qr')}>
            <QrCodeIcon className="text-glyph-scan" />
          </Button>
        </span>
      </Tooltip>
      {item.isActive &&
      item.trackingMode !== 'CONSUMABLE_GAUGE' &&
      item.trackingMode !== 'UNTRACKED' ? (
        <Tooltip content="Loan this item to a contact, tracking who has it and when it is due back." triggerTabIndex={-1}>
          <span>
            <Button variant="outline" size="icon" className={size} aria-label="Check out" onClick={() => setDialog('checkout')}>
              <CheckoutIcon className="text-glyph-checkout" />
            </Button>
          </span>
        </Tooltip>
      ) : null}
      {item.isActive ? (
        <Tooltip content="**Soft-delete** — hides the item but keeps its history. Tick *Show removed* to restore it later." triggerTabIndex={-1}>
          <span>
            <Button
              variant="ghost"
              size="icon"
              className={size}
              aria-label="Remove from inventory"
              onClick={() => softDelete.mutate({ id: item.id })}
            >
              <DeleteIcon className="text-glyph-danger" />
            </Button>
          </span>
        </Tooltip>
      ) : (
        <Tooltip content="Bring this removed item back into active inventory." triggerTabIndex={-1}>
          <span>
            <Button variant="ghost" size="icon" className={size} aria-label="Restore item" onClick={() => restore.mutate(item.id)}>
              <RestoreIcon className="text-glyph-success" />
            </Button>
          </span>
        </Tooltip>
      )}

      <MoveItemDialog item={item} open={dialog === 'move'} onClose={() => setDialog(null)} locations={locations} />
      {item.gauge ? (
        <GaugeAdjustDialog item={item} open={dialog === 'gauge'} onClose={() => setDialog(null)} />
      ) : null}
      <ItemDetailDialog item={item} open={dialog === 'details'} onClose={() => setDialog(null)} />
      <QrCodeDialog
        itemId={item.id}
        itemName={item.name}
        itemMpn={item.mpn}
        open={dialog === 'qr'}
        onClose={() => setDialog(null)}
      />
      <CheckoutDialog item={item} open={dialog === 'checkout'} onClose={() => setDialog(null)} />
    </div>
  );
}
