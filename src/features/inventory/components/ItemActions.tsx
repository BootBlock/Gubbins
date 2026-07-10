import { forwardRef, useImperativeHandle, useState } from 'react';
import { Button, Menu, MenuAction, MenuSeparator, Tooltip } from '@/components/foundry';
import {
  CheckoutIcon,
  DeleteIcon,
  EditIcon,
  GaugeIcon,
  MoreIcon,
  MoveIcon,
  QrCodeIcon,
  RestoreIcon,
  SaleIcon,
  WriteOffIcon,
} from '@/components/icons';
import type { Item, LocationWithCount } from '@/db/repositories';
import { CheckoutDialog } from '@/features/contacts/components/CheckoutDialog';
import { useFeature } from '@/features/modules/useFeature';
import { SellDialog } from '@/features/sales/components/SellDialog';
import { WriteOffDialog } from '@/features/sales/components/WriteOffDialog';
import { useRestoreItem, useSoftDeleteItem, useUpdateItem } from '../mutations';
import { GaugeAdjustDialog } from './GaugeAdjustDialog';
import { ItemDetailDialog } from './ItemDetailDialog';
import { MoveItemDialog } from './MoveItemDialog';
import { QrCodeDialog } from './QrCodeDialog';

/** Which of the item's dialogs to open — the shared vocabulary between a button and a card click. */
export type ItemDialogKind = 'move' | 'gauge' | 'details' | 'qr' | 'checkout' | 'sell' | 'writeoff';

/**
 * Rich help behind the loan-out row for an **Untracked** item (B5). A loan needs a countable
 * unit to check out and back in, so `checkout` rejects Untracked assets by design — but rather
 * than silently hiding "Loan out…", we surface *why* and offer the one-step, lossless escape
 * hatch: converting to **Bulk** (Discrete ↔ Untracked is reversible and keeps the on-hand
 * quantity), after which the item can be loaned. See {@link CONVERTIBLE_TRACKING_MODES}.
 */
const HINT_UNTRACKED_LOAN =
  '**Untracked items can’t be loaned.** A loan checks a countable unit out and back in, and an ' +
  'Untracked item has no quantity to track.\n\nConvert it to **Bulk** tracking to loan it out — ' +
  'its details and stock are kept, and you can switch it back to Untracked at any time.';

/**
 * Imperative handle {@link ItemActions} exposes so the containing card/row can open one of the
 * very same dialogs from a click on its body (the `cardClickAction` shortcut), reusing the one
 * dialog instance the buttons already drive — no second copy in the tree.
 */
export interface ItemActionsHandle {
  open(kind: ItemDialogKind): void;
}

/**
 * Shared item action controls plus the dialogs they open. Used by both the Visual and Data
 * presentations so behaviour stays identical across the density toggle.
 *
 * To keep the card/row footer compact enough to sit on one line beside the quantity stepper,
 * only the most immediate controls stay as their own buttons: **update gauge** (gauge items
 * only) and **remove / restore**. Everything else — **edit details**, **print label**, and the
 * secondary stock actions (**move**, **loan out**, **sell**, **write off**) — lives behind a
 * single "More actions" overflow {@link Menu}, keeping the same module + tracking-mode gating.
 *
 * Edit and label stay in the menu even though a body click can open them (the `cardClickAction`
 * shortcut defaults to opening details): that shortcut is a pointer-only convenience, so a
 * keyboard/AT user reaches the same actions through these focusable menu rows — the parity the
 * card-click invariant relies on. Move is always present, so the menu is never empty.
 *
 * Forwards a {@link ItemActionsHandle} ref so the parent card can open a dialog on a body
 * click without a second set of dialog state.
 */
export const ItemActions = forwardRef<
  ItemActionsHandle,
  {
    item: Item;
    locations: readonly LocationWithCount[];
    compact?: boolean;
  }
>(function ItemActions({ item, locations, compact = false }, ref) {
  const [dialog, setDialog] = useState<ItemDialogKind | null>(null);
  useImperativeHandle(ref, () => ({ open: setDialog }), []);
  const softDelete = useSoftDeleteItem();
  const restore = useRestoreItem();
  const update = useUpdateItem();
  // Checking out loans an item to a contact, so the entry point belongs to the Contacts
  // module (modular-ui-plan §4, Phase 6). Hidden when Contacts is off — the checkout
  // mutation and any existing loans stay intact, only the way in disappears.
  const contactsEnabled = useFeature('contacts');
  // Selling / writing off draws stock permanently out of inventory; gated behind the Sales &
  // disposals module and offered only for finite DISCRETE stock (serialised assets are retired
  // via "Remove from inventory"; gauges/untracked carry no countable units to sell).
  const salesEnabled = useFeature('sales');
  const canSell = salesEnabled && item.isActive && item.trackingMode === 'DISCRETE' && !item.isUnlimited;
  const size = compact ? 'size-8' : '';

  return (
    <div className="flex items-center gap-1">
      {item.trackingMode === 'CONSUMABLE_GAUGE' ? (
        <Tooltip
          content="Record usage or weigh-in against a scale to update the remaining level."
          triggerTabIndex={-1}
        >
          <span>
            <Button
              variant="outline"
              size="icon"
              className={size}
              aria-label="Update gauge"
              onClick={() => setDialog('gauge')}
            >
              <GaugeIcon className="text-glyph-gauge" />
            </Button>
          </span>
        </Tooltip>
      ) : null}
      {/* The record actions (edit, label) and secondary stock actions (move, loan, sell, write
          off) all live behind a single "More actions" overflow menu so the footer fits on one
          line beside the quantity stepper. Edit + label stay here — not as their own buttons —
          so keyboard/AT users still reach the `cardClickAction` targets the pointer body-click
          mirrors. Move is always offered, so the menu is never empty; loan/sell/write-off keep
          the same module + tracking-mode gating they had as standalone buttons. */}
      <Menu
        label="More actions"
        trigger={<MoreIcon className="text-muted-foreground" />}
        triggerSize="icon"
        triggerClassName={size}
        triggerProps={{ 'data-testid': 'item-actions-more' }}
      >
        <MenuAction icon={<EditIcon className="text-glyph-edit" />} onSelect={() => setDialog('details')}>
          Edit details…
        </MenuAction>
        <MenuAction icon={<QrCodeIcon className="text-glyph-scan" />} onSelect={() => setDialog('qr')}>
          Print label…
        </MenuAction>
        <MenuSeparator />
        <MenuAction icon={<MoveIcon className="text-glyph-move" />} onSelect={() => setDialog('move')}>
          Move…
        </MenuAction>
        {contactsEnabled && item.isActive && item.trackingMode !== 'CONSUMABLE_GAUGE' ? (
          item.trackingMode === 'UNTRACKED' ? (
            // Untracked assets can't be loaned by design (`checkout` rejects them — no unit to
            // check out/in). Rather than silently omit the action, offer the reason plus the
            // lossless one-step fix: convert to Bulk (Discrete ↔ Untracked is reversible and keeps
            // the on-hand quantity), routed through the same `useUpdateItem` path the details
            // editor uses — the repository guards it with `isConvertibleTrackingChange`. This is a
            // deliberate, user-initiated convert, never an auto-convert on a loan attempt (B5).
            <Tooltip content={HINT_UNTRACKED_LOAN} triggerTabIndex={-1} className="w-full">
              <MenuAction
                icon={<CheckoutIcon className="text-glyph-checkout" />}
                onSelect={() => update.mutate({ id: item.id, input: { trackingMode: 'DISCRETE' } })}
                data-testid="item-actions-loan-untracked-convert"
              >
                Convert to Bulk to loan out…
              </MenuAction>
            </Tooltip>
          ) : (
            <MenuAction
              icon={<CheckoutIcon className="text-glyph-checkout" />}
              onSelect={() => setDialog('checkout')}
            >
              Loan out…
            </MenuAction>
          )
        ) : null}
        {canSell ? (
          <>
            <MenuAction icon={<SaleIcon className="text-glyph-sale" />} onSelect={() => setDialog('sell')}>
              Sell…
            </MenuAction>
            <MenuAction
              icon={<WriteOffIcon className="text-glyph-neutral" />}
              onSelect={() => setDialog('writeoff')}
            >
              Write off…
            </MenuAction>
          </>
        ) : null}
      </Menu>
      {item.isActive ? (
        <Tooltip
          content="**Soft-delete** — hides the item but keeps its history. Tick *Show removed* to restore it later."
          triggerTabIndex={-1}
        >
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
            <Button
              variant="ghost"
              size="icon"
              className={size}
              aria-label="Restore item"
              onClick={() => restore.mutate(item.id)}
            >
              <RestoreIcon className="text-glyph-success" />
            </Button>
          </span>
        </Tooltip>
      )}

      <MoveItemDialog
        item={item}
        open={dialog === 'move'}
        onClose={() => setDialog(null)}
        locations={locations}
      />
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
      {canSell ? (
        <>
          <SellDialog item={item} open={dialog === 'sell'} onClose={() => setDialog(null)} />
          <WriteOffDialog item={item} open={dialog === 'writeoff'} onClose={() => setDialog(null)} />
        </>
      ) : null}
    </div>
  );
});
