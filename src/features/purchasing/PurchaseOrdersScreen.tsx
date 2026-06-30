import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Button, LiveRegion, Spinner, Surface, MAIN_CONTENT_ID } from '@/components/foundry';
import {
  AddIcon,
  DeleteIcon,
  PackageIcon,
  ShoppingCartIcon,
  TruckIcon,
} from '@/components/icons';
import { BrandMark } from '@/components/BrandMark';
import { useFormatters } from '@/lib/useFormatters';
import { useInventoryItems, useLocations } from '@/features/inventory/queries';
import { effectiveUnitCost } from '@/features/inventory/supplier-cost';
import type { LocationOption } from '@/features/inventory/components/LocationSelect';
import type { PurchaseOrderLine, PurchaseOrderWithLines } from '@/db/repositories';
import {
  estimatedValue,
  poStatusPresentation,
  totalOrdered,
  totalReceived,
} from './po-presentation';
import {
  useAddPurchaseOrderLine,
  useCreatePurchaseOrder,
  useDeletePurchaseOrder,
  usePurchaseOrder,
  usePurchaseOrders,
  useReceivePurchaseOrderLine,
  useRemovePurchaseOrderLine,
  useSetPurchaseOrderStatus,
} from './queries';
import { CreatePurchaseOrderDialog } from './components/CreatePurchaseOrderDialog';
import { PurchaseOrderLineDialog, type LineItemOption } from './components/PurchaseOrderLineDialog';
import { ReceiveLineDialog } from './components/ReceiveLineDialog';

/**
 * The Formal Purchase Orders screen (inventory-depth Phase 62): a list of supplier-keyed
 * orders, an order detail with its lines and receipt progress, and a per-line receive flow
 * that lands stock into the existing per-location / batch ledger. Status badges and the whole
 * surface use design tokens only; copy is British English.
 */
export function PurchaseOrdersScreen() {
  const f = useFormatters();
  const ordersQuery = usePurchaseOrders();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const createPo = useCreatePurchaseOrder();

  const orders = ordersQuery.data?.rows ?? [];
  const selected = selectedId ?? (orders.length > 0 ? orders[0]!.id : null);

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col gap-6 px-4 py-6">
      <header className="flex flex-wrap items-center gap-3">
        <Link to="/" className="flex items-center gap-2 text-foreground [&_svg]:size-6">
          <BrandMark className="size-9 rounded-xl" />
          <span className="text-lg font-semibold tracking-tight">Gubbins</span>
        </Link>
        <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight [&_svg]:size-5">
          <ShoppingCartIcon /> Purchase orders
        </h1>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="primary" onClick={() => setCreateOpen(true)} data-testid="po-new">
            <AddIcon />
            New order
          </Button>
          <Link
            to="/inventory"
            className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground [&_svg]:size-4"
          >
            <PackageIcon />
            Inventory
          </Link>
        </div>
      </header>

      <main
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
        className="grid flex-1 animate-rise gap-6 outline-none lg:grid-cols-[20rem_1fr]"
      >
        {/* Order list */}
        <section aria-label="Purchase orders" className="flex flex-col gap-2">
          {ordersQuery.isLoading ? (
            <Surface className="flex items-center justify-center p-8">
              <Spinner />
            </Surface>
          ) : orders.length === 0 ? (
            <Surface className="p-6 text-sm text-muted-foreground" data-testid="po-empty">
              No purchase orders yet. Create one to start ordering parts from a supplier.
            </Surface>
          ) : (
            orders.map((po) => (
              <OrderListRow
                key={po.id}
                po={po}
                active={po.id === selected}
                currency={f.currency}
                onSelect={() => setSelectedId(po.id)}
              />
            ))
          )}
        </section>

        {/* Order detail */}
        <section aria-label="Order detail">
          {selected ? (
            <PurchaseOrderDetail key={selected} poId={selected} onDeleted={() => setSelectedId(null)} />
          ) : (
            <Surface className="p-6 text-sm text-muted-foreground">
              Select or create a purchase order to view its lines.
            </Surface>
          )}
        </section>
      </main>

      <CreatePurchaseOrderDialog
        open={createOpen}
        isSaving={createPo.isPending}
        onClose={() => setCreateOpen(false)}
        onSubmit={(input) => {
          createPo.mutate(input, {
            onSuccess: (po) => {
              setSelectedId(po.id);
              setCreateOpen(false);
            },
          });
        }}
      />
    </div>
  );
}

function OrderListRow({
  po,
  active,
  currency,
  onSelect,
}: {
  po: PurchaseOrderWithLines;
  active: boolean;
  currency: (value: number) => string;
  onSelect: () => void;
}) {
  const status = poStatusPresentation(po.effectiveStatus);
  return (
    <button
      type="button"
      onClick={onSelect}
      data-testid="po-list-row"
      aria-current={active ? 'true' : undefined}
      className={`flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors ${
        active ? 'border-ring bg-secondary/50' : 'border-border hover:bg-secondary/40'
      }`}
    >
      <div className="flex w-full items-center justify-between gap-2">
        <span className="font-medium">{po.supplierName}</span>
        <span className={`text-xs font-semibold ${status.toneClass}`}>{status.label}</span>
      </div>
      <div className="flex w-full items-center justify-between text-xs text-muted-foreground">
        <span>{po.reference ?? 'No reference'}</span>
        <span>{currency(estimatedValue(po.lines))}</span>
      </div>
    </button>
  );
}

function PurchaseOrderDetail({ poId, onDeleted }: { poId: string; onDeleted: () => void }) {
  const f = useFormatters();
  const poQuery = usePurchaseOrder(poId);
  const itemsQuery = useInventoryItems({}, 100);
  const locationsQuery = useLocations();

  const addLine = useAddPurchaseOrderLine();
  const removeLine = useRemovePurchaseOrderLine();
  const receiveLine = useReceivePurchaseOrderLine();
  const setStatus = useSetPurchaseOrderStatus();
  const deletePo = useDeletePurchaseOrder();

  const [lineOpen, setLineOpen] = useState(false);
  const [receiving, setReceiving] = useState<PurchaseOrderLine | null>(null);

  // WCAG 4.1.3 Status Messages — the badge transition and the receipt-progress
  // counter both change silently; announce each change via the always-mounted
  // LiveRegion so SR users hear the outcome of their explicit action.
  const [statusAnnouncement, setStatusAnnouncement] = useState('');
  const [receiptAnnouncement, setReceiptAnnouncement] = useState('');
  // Track the previous received/ordered totals so a useEffect can detect a real
  // change and announce it without firing on first render.
  const prevReceivedRef = useRef<number | null>(null);

  const itemOptions = useMemo<LineItemOption[]>(() => {
    const pages = itemsQuery.data?.pages ?? [];
    return pages
      .flatMap((p) => p.rows)
      .map((item) => ({
        id: item.id,
        name: item.name,
        // Phase-60 cost precedence: with no supplier parts loaded here this is the manual
        // override; a priced preferred supplier would refine it on the item detail.
        defaultUnitCost: effectiveUnitCost(item, []),
      }));
  }, [itemsQuery.data]);

  const locationOptions = useMemo<LocationOption[]>(() => {
    const rows = locationsQuery.data?.rows ?? [];
    return [
      { value: '', label: '— Item’s home location —' },
      ...rows.map((l) => ({ value: l.id, label: l.name })),
    ];
  }, [locationsQuery.data]);

  const itemNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const opt of itemOptions) map.set(opt.id, opt.name);
    return map;
  }, [itemOptions]);

  // Announce receipt-progress changes (e.g. after "Receive" dialog completes).
  // Keyed on the derived totals so every new receipt fires a fresh announcement.
  // prevReceivedRef guards against announcing on first render or PO-switch.
  const currentReceived = useMemo(
    () => (poQuery.data?.lines ?? []).reduce((sum, l) => sum + Math.max(0, l.receivedQty), 0),
    [poQuery.data?.lines],
  );
  const currentOrdered = useMemo(
    () => (poQuery.data?.lines ?? []).reduce((sum, l) => sum + Math.max(0, l.orderedQty), 0),
    [poQuery.data?.lines],
  );
  useEffect(() => {
    if (prevReceivedRef.current === null) {
      // First render — just record the baseline; don't announce.
      prevReceivedRef.current = currentReceived;
      return;
    }
    if (currentReceived !== prevReceivedRef.current) {
      prevReceivedRef.current = currentReceived;
      setReceiptAnnouncement(
        `Receipt updated: ${f.quantity(currentReceived)} of ${f.quantity(currentOrdered)} received.`,
      );
    }
  // f is stable between renders; including it satisfies exhaustive-deps without
  // causing extra fires.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentReceived, currentOrdered]);

  if (poQuery.isLoading) {
    return (
      <Surface className="flex items-center justify-center p-8">
        <Spinner />
      </Surface>
    );
  }
  const po = poQuery.data;
  if (!po) {
    return <Surface className="p-6 text-sm text-muted-foreground">Order not found.</Surface>;
  }

  const status = poStatusPresentation(po.effectiveStatus);
  const ordered = totalOrdered(po.lines);
  const received = totalReceived(po.lines);
  const isActive = po.effectiveStatus !== 'DRAFT' && po.effectiveStatus !== 'CANCELLED';

  return (
    <div className="flex flex-col gap-4">
      <Surface className="flex flex-wrap items-center gap-3 p-4">
        <div className="flex flex-col">
          <span className="text-base font-semibold">{po.supplierName}</span>
          <span className="text-xs text-muted-foreground">{po.reference ?? 'No reference'}</span>
        </div>
        <span
          className={`rounded-full bg-secondary/60 px-2.5 py-0.5 text-xs font-semibold ${status.toneClass}`}
          data-testid="po-detail-status"
        >
          {status.label}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {po.effectiveStatus === 'DRAFT' && (
            <Button
              variant="primary"
              onClick={() =>
                setStatus.mutate(
                  { id: po.id, status: 'ORDERED' },
                  { onSuccess: () => setStatusAnnouncement('Order status changed to Ordered.') },
                )
              }
              disabled={setStatus.isPending || po.lines.length === 0}
              data-testid="po-mark-ordered"
            >
              <TruckIcon />
              Mark as ordered
            </Button>
          )}
          {po.effectiveStatus === 'CANCELLED' ? (
            <Button
              variant="outline"
              onClick={() =>
                setStatus.mutate(
                  { id: po.id, status: 'DRAFT' },
                  { onSuccess: () => setStatusAnnouncement('Order status changed to Draft.') },
                )
              }
              disabled={setStatus.isPending}
            >
              Reopen as draft
            </Button>
          ) : (
            <Button
              variant="destructive"
              onClick={() =>
                setStatus.mutate(
                  { id: po.id, status: 'CANCELLED' },
                  { onSuccess: () => setStatusAnnouncement('Order status changed to Cancelled.') },
                )
              }
              disabled={setStatus.isPending}
              data-testid="po-cancel"
            >
              Cancel order
            </Button>
          )}
          <Button
            variant="destructive"
            onClick={() => deletePo.mutate(po.id, { onSuccess: onDeleted })}
            disabled={deletePo.isPending}
            aria-label="Delete order"
          >
            <DeleteIcon />
          </Button>
        </div>
      </Surface>

      <Surface className="p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">
            Lines · {f.quantity(received)} of {f.quantity(ordered)} received
          </h2>
          <Button variant="outline" onClick={() => setLineOpen(true)} data-testid="po-add-line">
            <AddIcon />
            Add line
          </Button>
        </div>

        {po.lines.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">
            No lines yet. Add the parts you are ordering.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {po.lines.map((line) => {
              const outstanding = Math.max(0, line.orderedQty - line.receivedQty);
              const label = line.itemId
                ? itemNameById.get(line.itemId) ?? line.description ?? 'Linked item'
                : line.description ?? 'Unnamed line';
              return (
                <li
                  key={line.id}
                  className="flex flex-wrap items-center gap-3 py-2"
                  data-testid="po-line-row"
                >
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium">{label}</span>
                    <span className="text-xs text-muted-foreground">
                      {f.quantity(line.receivedQty)} / {f.quantity(line.orderedQty)} received
                      {line.unitCost != null && ` · ${f.currency(line.unitCost)} each`}
                    </span>
                  </div>
                  {isActive && outstanding > 0 && (
                    <Button
                      variant="outline"
                      onClick={() => setReceiving(line)}
                      data-testid="po-receive-line"
                    >
                      Receive
                    </Button>
                  )}
                  <Button
                    variant="destructive"
                    onClick={() => removeLine.mutate({ poId: po.id, lineId: line.id })}
                    disabled={removeLine.isPending}
                    aria-label="Remove line"
                  >
                    <DeleteIcon />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </Surface>

      <PurchaseOrderLineDialog
        open={lineOpen}
        items={itemOptions}
        isSaving={addLine.isPending}
        onClose={() => setLineOpen(false)}
        onSubmit={(input) => {
          addLine.mutate(
            { poId: po.id, input },
            { onSuccess: () => setLineOpen(false) },
          );
        }}
      />

      {receiving && (
        <ReceiveLineDialog
          open={receiving !== null}
          line={receiving}
          locationOptions={locationOptions}
          isSaving={receiveLine.isPending}
          onClose={() => setReceiving(null)}
          onSubmit={(input) => {
            receiveLine.mutate(
              {
                poId: po.id,
                lineId: receiving.id,
                itemId: receiving.itemId,
                quantity: input.quantity,
                locationId: input.locationId,
                batch: input.batch,
              },
              { onSuccess: () => setReceiving(null) },
            );
          }}
        />
      )}

      {/*
       * WCAG 4.1.3 — always-mounted live regions for status-badge transitions and
       * receipt-progress changes. `visuallyHidden` (sr-only) because the badge and
       * the "X of Y received" counter are the visible feedback; these regions carry
       * the same information to screen-reader users who can't see those updates.
       * Two separate regions keep the two independent announcements from colliding.
       */}
      <LiveRegion visuallyHidden data-testid="po-status-live">
        {statusAnnouncement ? <p>{statusAnnouncement}</p> : null}
      </LiveRegion>
      <LiveRegion visuallyHidden data-testid="po-receipt-live">
        {receiptAnnouncement ? <p>{receiptAnnouncement}</p> : null}
      </LiveRegion>
    </div>
  );
}
