import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  LiveRegion,
  Money,
  PageContainer,
  PageHeader,
  Pagination,
  Spinner,
  Surface,
  pageCount,
  MAIN_CONTENT_ID,
} from '@/components/foundry';
import {
  AddIcon,
  DeleteIcon,
  LowStockIcon,
  ShoppingCartIcon,
  TruckIcon,
  UploadIcon,
  WishlistIcon,
} from '@/components/icons';
import { useT } from '@/features/i18n';
import { useHotkeyScope } from '@/features/hotkeys/useHotkeyScope';
import { useHotkeyIntent } from '@/features/hotkeys/useHotkeyIntent';
import { PAGE_SIZE_BOUNDS, PAGE_SIZE_PRESETS } from '@/features/settings/settings';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { ReorderTab } from './ReorderTab';
import { WishlistTab } from './WishlistTab';
import type { Formatters } from '@/lib/format';
import { plural } from '@/lib/plural';
import { useFormatters } from '@/lib/useFormatters';
import { moneyDecimals } from '@/lib/money';
import { useInventoryItems, useLocations, useSupplierPartsForItems } from '@/features/inventory/queries';
import { preferredSupplierPart } from '@/features/inventory/supplier-cost';
import type { LocationOption } from '@/features/inventory/components/LocationSelect';
import type { PurchaseOrderLine, PurchaseOrderWithLines } from '@/db/repositories';
import { estimatedValue, poStatusPresentation, totalOrdered, totalReceived } from './po-presentation';
import { TabularExportMenu } from '@/features/export/TabularExportMenu';
import { exportEveryPage } from '@/features/export/export-every-page';
import { buildPurchaseOrdersExport, purchaseOrdersExportFilename } from './po-export';
import {
  readPurchaseOrdersPage,
  useAddPurchaseOrderLine,
  useCreatePurchaseOrder,
  useDeletePurchaseOrder,
  usePurchaseOrder,
  usePurchaseOrderCount,
  usePurchaseOrders,
  useReceivePurchaseOrderLine,
  useReturnPurchaseOrderLine,
  useRemovePurchaseOrderLine,
  useSetPurchaseOrderStatus,
} from './queries';
import { CreatePurchaseOrderDialog } from './components/CreatePurchaseOrderDialog';
import { PurchaseOrderLineDialog, type LineItemOption } from './components/PurchaseOrderLineDialog';
import { ReceiveLineDialog } from './components/ReceiveLineDialog';
import { ReturnLineDialog } from './components/ReturnLineDialog';
import { ImportPurchaseListDialog } from './components/ImportPurchaseListDialog';

/** The top-level tabs on the Purchase Orders screen. */
type PoTab = 'orders' | 'reorder' | 'wishlist';

/**
 * The Purchase Orders screen (inventory-depth Phase 62 + Phase 65 + feature-gap G8).
 *
 * - **Orders tab**: the existing supplier-keyed DRAFT/ORDERED/RECEIVED order list +
 *   detail panel (Phase 62).
 * - **Reorder / Shopping list tab**: items below their reorder point grouped by
 *   preferred supplier, with editable quantities and one-click DRAFT PO creation
 *   (Phase 65) — *stock-driven* buying.
 * - **Wishlist tab**: a manual list of wanted-but-not-owned things to buy (feature-gap
 *   G8) — *manual* buying, the counterpart to the stock-driven Reorder list.
 *
 * All three tabs live within the single `/purchase-orders` route (no new route file) so
 * route-tree merges with parallel phases remain clean. Status badges and design tokens
 * follow CLAUDE.md; copy is British English.
 *
 * The Orders master list pages **server-side** (issue #149): orders accumulate for as long as
 * the inventory is used, and a single capped read left everything past the hundredth
 * unreachable without saying so.
 */
export function PurchaseOrdersScreen() {
  const f = useFormatters();
  // The base currency's minor unit (issue #292), resolved once for the whole list rather than
  // per row. It is only the *fallback*: an order quoted in its own currency (issue #285) is
  // totalled at that currency's minor unit instead.
  const currencyDecimals = f.currencyFractionDigits();
  const t = useT();
  // App-wide list pagination (issue #20). Unpaginated the list still reads a bounded page — the
  // ceiling is the repository's, and asking for more than it allows would clamp anyway. It reads
  // the *first* page whatever `ordersPage` holds: switching the preference off from the Settings
  // modal leaves this screen mounted, and reading page 3 under copy that says "the first 100"
  // would be a lie.
  const paginated = usePreferencesStore((s) => s.paginateLists);
  const defaultPageSize = usePreferencesStore((s) => s.defaultPageSize);
  const setDefaultPageSize = usePreferencesStore((s) => s.setDefaultPageSize);
  const [ordersPage, setOrdersPage] = useState(1);
  const ordersPageSize = paginated ? defaultPageSize : PAGE_SIZE_BOUNDS.max;
  const ordersQuery = usePurchaseOrders(paginated ? ordersPage : 1, ordersPageSize);
  const ordersTotal = usePurchaseOrderCount();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<PoTab>('orders');

  const createPo = useCreatePurchaseOrder();

  // The contextual "new" shortcut (issue #127). Only offered on the Orders tab — `N` on the
  // Reorder or Wishlist tab would create something the user cannot see from where they stand.
  const openCreate = useCallback(() => {
    setActiveTab('orders');
    setCreateOpen(true);
  }, []);
  useHotkeyScope({ onNew: activeTab === 'orders' ? openCreate : undefined });

  // A "new purchase order" shortcut pressed from another screen navigates here and leaves an
  // intent behind, since the create dialog is local state with no route of its own.
  const pendingIntent = useHotkeyIntent((s) => s.pending);
  useEffect(() => {
    if (pendingIntent !== 'new-purchase-order') return;
    useHotkeyIntent.getState().consume('new-purchase-order');
    openCreate();
  }, [pendingIntent, openCreate]);

  const orders = ordersQuery.data?.rows ?? [];
  const selected = selectedId ?? (orders.length > 0 ? orders[0]!.id : null);
  // Fall back to the rows in hand when the count is unavailable, so a failed count query
  // degrades to "one page" rather than silently removing the pager from a longer list.
  const totalOrders = ordersTotal.data ?? (ordersQuery.data ? ordersQuery.data.offset + orders.length : 0);
  const orderPages = pageCount(totalOrders, ordersPageSize);
  // Unpaginated the read is capped at one page; how many orders that leaves unreachable.
  const hiddenOrders = paginated ? 0 : Math.max(0, totalOrders - orders.length);

  // Deleting the last order on the final page leaves the page out of range.
  useEffect(() => {
    if (paginated && orderPages > 0 && ordersPage > orderPages) setOrdersPage(orderPages);
  }, [paginated, orderPages, ordersPage]);

  return (
    <PageContainer>
      <PageHeader
        icon={<ShoppingCartIcon />}
        title="Purchase orders"
        actions={
          activeTab === 'orders' ? (
            <div className="flex flex-wrap items-center gap-2">
              {/*
               * One row per order, matching the master list, with the lines folded into totals.
               * Re-reads every page rather than serialising the page on screen — the order book
               * grows for as long as the inventory is used, so the rows in hand are a page of it.
               */}
              <TabularExportMenu
                build={(format) =>
                  exportEveryPage(
                    readPurchaseOrdersPage,
                    (rows) => buildPurchaseOrdersExport(format, rows),
                    t('export.list.truncated'),
                  )
                }
                filename={purchaseOrdersExportFilename}
                triggerLabel={t('export.list.trigger')}
                menuLabel={t('export.purchaseOrders.menuLabel')}
                toastHeading={t('export.purchaseOrders.toast')}
                disabled={ordersQuery.isLoading || totalOrders === 0}
                testIdPrefix="export-purchase-orders"
              />
              <Button variant="outline" onClick={() => setImportOpen(true)} data-testid="po-import">
                <UploadIcon />
                {t('purchasing.import.open')}
              </Button>
              <Button variant="primary" onClick={() => setCreateOpen(true)} data-testid="po-new">
                <AddIcon />
                New order
              </Button>
            </div>
          ) : undefined
        }
      />

      {/* Tab navigation — a plain div carries role="tablist" (a <nav> landmark is
          suppressed by the role override and inconsistent with the other tablists). */}
      <div role="tablist" aria-label="Purchase orders sections" className="flex gap-1 border-b border-border">
        <TabButton
          id="po-tab-orders"
          panelId="po-panel-orders"
          active={activeTab === 'orders'}
          onClick={() => setActiveTab('orders')}
        >
          <ShoppingCartIcon className="size-4" aria-hidden="true" />
          Orders
        </TabButton>
        <TabButton
          id="po-tab-reorder"
          panelId="po-panel-reorder"
          active={activeTab === 'reorder'}
          onClick={() => setActiveTab('reorder')}
          data-testid="po-tab-reorder"
        >
          <LowStockIcon className="size-4" aria-hidden="true" />
          Reorder / Shopping list
        </TabButton>
        <TabButton
          id="po-tab-wishlist"
          panelId="po-panel-wishlist"
          active={activeTab === 'wishlist'}
          onClick={() => setActiveTab('wishlist')}
          data-testid="po-tab-wishlist"
        >
          <WishlistIcon className="size-4" aria-hidden="true" />
          Wishlist
        </TabButton>
      </div>

      <main id={MAIN_CONTENT_ID} tabIndex={-1} className="flex-1 animate-rise outline-none">
        {/* Orders tab panel */}
        <div
          id="po-panel-orders"
          role="tabpanel"
          aria-labelledby="po-tab-orders"
          hidden={activeTab !== 'orders'}
          className="grid gap-6 lg:grid-cols-[20rem_1fr]"
        >
          {/*
           * WCAG 4.1.3 — always-mounted polite status region for the purchase-order
           * master list. The list count changes silently when orders are created or
           * deleted; this sr-only region announces it to screen-reader users. It is
           * always mounted so that later text mutations are reliably picked up, and
           * col-span-full keeps it out of the two-column grid flow.
           */}
          <p
            className="sr-only col-span-full"
            role="status"
            aria-live="polite"
            data-testid="po-list-count-live"
          >
            {ordersQuery.isLoading
              ? 'Loading purchase orders…'
              : ordersQuery.isError
                ? // The visible error carries its own role="alert"; keep this polite region
                  // from also (mis)reporting an empty list on failure (issue #306).
                  ''
                : totalOrders === 0
                  ? 'No purchase orders yet.'
                  : // The whole set, not the page in view — a per-page figure would understate
                    // how many orders there actually are.
                    `${totalOrders} ${plural(totalOrders, 'purchase order')}.`}
          </p>
          {/* Order list */}
          <section aria-label="Purchase orders" className="flex flex-col gap-2">
            {ordersQuery.isLoading ? (
              <Surface className="flex items-center justify-center p-8">
                <Spinner />
              </Surface>
            ) : ordersQuery.isError ? (
              // Never fall through to the empty state on failure: "No purchase orders yet"
              // would read like success and hide a real error (issue #306).
              <Surface className="flex flex-col items-center gap-3 p-6 text-center" data-testid="po-error">
                <p role="alert" className="text-sm text-destructive">
                  {t('purchasing.orders.error')}
                </p>
                <Button variant="outline" onClick={() => void ordersQuery.refetch()}>
                  {t('purchasing.orders.retry')}
                </Button>
              </Surface>
            ) : orders.length === 0 ? (
              <Surface className="p-6 text-sm text-muted-foreground" data-testid="po-empty">
                No purchase orders yet. Create one to start ordering parts from a supplier.
              </Surface>
            ) : (
              <>
                {orders.map((po) => (
                  <OrderListRow
                    key={po.id}
                    po={po}
                    active={po.id === selected}
                    formatters={f}
                    baseDecimals={currencyDecimals}
                    onSelect={() => setSelectedId(po.id)}
                  />
                ))}
                {paginated ? (
                  <Pagination
                    className="mt-1"
                    page={ordersPage}
                    pageCount={orderPages}
                    onPageChange={setOrdersPage}
                    pageSize={defaultPageSize}
                    onPageSizeChange={setDefaultPageSize}
                    pageSizeOptions={PAGE_SIZE_PRESETS}
                    minPageSize={PAGE_SIZE_BOUNDS.min}
                    maxPageSize={PAGE_SIZE_BOUNDS.max}
                    totalItems={totalOrders}
                    data-testid="po-pagination"
                  />
                ) : hiddenOrders > 0 ? (
                  // Unpaginated the read is still bounded, so say so rather than quietly hiding
                  // orders on the only screen that can open one.
                  <p className="text-xs text-muted-foreground" data-testid="po-truncated">
                    {t('purchasing.orders.truncated', {
                      vars: { count: hiddenOrders, shown: orders.length },
                    })}
                  </p>
                ) : null}
              </>
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
        </div>

        {/* Reorder / Shopping list tab panel */}
        <div
          id="po-panel-reorder"
          role="tabpanel"
          aria-labelledby="po-tab-reorder"
          hidden={activeTab !== 'reorder'}
        >
          <ReorderTab />
        </div>

        {/* Wishlist tab panel */}
        <div
          id="po-panel-wishlist"
          role="tabpanel"
          aria-labelledby="po-tab-wishlist"
          hidden={activeTab !== 'wishlist'}
        >
          <WishlistTab />
        </div>
      </main>

      <ImportPurchaseListDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onCreated={(poId) => setSelectedId(poId)}
      />

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
    </PageContainer>
  );
}

/** Accessible tab button that follows the WAI-ARIA tabs pattern. */
function TabButton({
  id,
  panelId,
  active,
  onClick,
  children,
  'data-testid': testId,
}: {
  id: string;
  panelId: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  'data-testid'?: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      id={id}
      aria-controls={panelId}
      aria-selected={active}
      onClick={onClick}
      data-testid={testId}
      className={`flex items-center gap-1.5 border-b-2 px-3 pb-2 pt-1 text-sm font-medium transition-colors [&_svg]:size-4 ${
        active
          ? 'border-ring text-foreground'
          : 'border-transparent text-muted-foreground hover:text-foreground'
      }`}
    >
      {children}
    </button>
  );
}

function OrderListRow({
  po,
  active,
  formatters,
  baseDecimals,
  onSelect,
}: {
  po: PurchaseOrderWithLines;
  active: boolean;
  formatters: Formatters;
  /** The base currency's minor unit, resolved once by the list rather than per row (issue #292). */
  baseDecimals: number;
  onSelect: () => void;
}) {
  const t = useT();
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
        <span className="font-medium">{po.supplierName ?? t('supplier.unknown')}</span>
        <span className={`text-xs font-semibold ${status.toneClass}`}>{status.label}</span>
      </div>
      <div className="flex w-full items-center justify-between text-xs text-muted-foreground">
        <span>{po.reference ?? 'No reference'}</span>
        {/* The order's own currency, not the base one: its line costs were copied verbatim from
            the supplier's quote and are never converted, so rendering a EUR order's total under
            the base symbol would misstate it (issue #285). Null ⇒ the base currency.
            The total is quantised to that same currency's minor unit rather than a flat 2dp
            (issue #292) — a yen-quoted order totals in whole yen even under a sterling base, so
            the figure agrees with the symbol it is rendered under. */}
        <Money
          value={estimatedValue(po.lines, po.currency ? moneyDecimals(po.currency) : baseDecimals)}
          currency={po.currency ?? undefined}
          formatters={formatters}
        />
      </div>
    </button>
  );
}

function PurchaseOrderDetail({ poId, onDeleted }: { poId: string; onDeleted: () => void }) {
  const f = useFormatters();
  const t = useT();
  const poQuery = usePurchaseOrder(poId);
  const itemsQuery = useInventoryItems({}, 100);
  const locationsQuery = useLocations();

  // The pickable items, and their supplier parts loaded in one batch so the line editor can
  // apply each item's quantity price-breaks (issue #37) without an N+1 fan-out.
  const pickableItems = useMemo(
    () => (itemsQuery.data?.pages ?? []).flatMap((p) => p.rows),
    [itemsQuery.data],
  );
  const supplierPartsQuery = useSupplierPartsForItems(pickableItems.map((i) => i.id));

  const addLine = useAddPurchaseOrderLine();
  const removeLine = useRemovePurchaseOrderLine();
  const receiveLine = useReceivePurchaseOrderLine();
  const returnLine = useReturnPurchaseOrderLine();
  const setStatus = useSetPurchaseOrderStatus();
  const deletePo = useDeletePurchaseOrder();

  const [lineOpen, setLineOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [receiving, setReceiving] = useState<PurchaseOrderLine | null>(null);
  const [returning, setReturning] = useState<PurchaseOrderLine | null>(null);

  // WCAG 4.1.3 Status Messages — the badge transition and the receipt-progress
  // counter both change silently; announce each change via the always-mounted
  // LiveRegion so SR users hear the outcome of their explicit action.
  const [statusAnnouncement, setStatusAnnouncement] = useState('');
  const [receiptAnnouncement, setReceiptAnnouncement] = useState('');
  // Track the previous received/ordered totals so a useEffect can detect a real
  // change and announce it without firing on first render.
  const prevReceivedRef = useRef<number | null>(null);

  const itemOptions = useMemo<LineItemOption[]>(() => {
    const bySupplier = supplierPartsQuery.data;
    return pickableItems.map((item) => {
      // The preferred supplier part supplies the flat cost, currency and price-breaks; the
      // dialog applies the item's manual override precedence and the quantity break itself.
      const preferred = preferredSupplierPart(bySupplier?.get(item.id) ?? []);
      return {
        id: item.id,
        name: item.name,
        manualUnitCost: item.unitCost,
        supplierUnitCost: preferred?.unitCost ?? null,
        priceBreaks: preferred?.priceBreaks ?? [],
        currency: preferred?.currency ?? null,
      };
    });
  }, [pickableItems, supplierPartsQuery.data]);

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
          <span className="text-base font-semibold">{po.supplierName ?? t('supplier.unknown')}</span>
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
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => setImportOpen(true)} data-testid="po-detail-import">
              <UploadIcon />
              {t('purchasing.import.open')}
            </Button>
            <Button variant="outline" onClick={() => setLineOpen(true)} data-testid="po-add-line">
              <AddIcon />
              Add line
            </Button>
          </div>
        </div>

        {po.lines.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">No lines yet. Add the parts you are ordering.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {po.lines.map((line) => {
              const outstanding = Math.max(0, line.orderedQty - line.receivedQty);
              const label = line.itemId
                ? (itemNameById.get(line.itemId) ?? line.description ?? 'Linked item')
                : (line.description ?? 'Unnamed line');
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
                      {line.unitCost != null && (
                        <>
                          {' · '}
                          <Money
                            value={line.unitCost}
                            currency={po.currency ?? undefined}
                            formatters={f}
                          />{' '}
                          each
                        </>
                      )}
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
                  {isActive && line.receivedQty > 0 && (
                    <Button variant="outline" onClick={() => setReturning(line)} data-testid="po-return-line">
                      Return
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

      <ImportPurchaseListDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        poId={po.id}
        // Deliberately undefined rather than the "unknown supplier" placeholder: that string is
        // display-only, and seeding the picker with it would create a supplier actually named it.
        supplierId={po.supplierId ?? undefined}
        supplierName={po.supplierName ?? undefined}
      />

      <PurchaseOrderLineDialog
        open={lineOpen}
        items={itemOptions}
        orderCurrency={po.currency}
        isSaving={addLine.isPending}
        onClose={() => setLineOpen(false)}
        onSubmit={(input) => {
          addLine.mutate({ poId: po.id, input }, { onSuccess: () => setLineOpen(false) });
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

      {returning && (
        <ReturnLineDialog
          open={returning !== null}
          line={returning}
          locationOptions={locationOptions}
          isSaving={returnLine.isPending}
          onClose={() => setReturning(null)}
          onSubmit={(input) => {
            returnLine.mutate(
              {
                poId: po.id,
                lineId: returning.id,
                quantity: input.quantity,
                locationId: input.locationId,
              },
              { onSuccess: () => setReturning(null) },
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
