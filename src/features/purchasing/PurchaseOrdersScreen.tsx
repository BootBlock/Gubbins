import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Banner,
  Button,
  LiveRegion,
  Modal,
  Money,
  PageContainer,
  PageHeader,
  Pagination,
  Spinner,
  Surface,
  pageCount,
  useToast,
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
import { useItem, useItemsById, useLocations } from '@/features/inventory/queries';
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
import { PurchaseOrderLineDialog } from './components/PurchaseOrderLineDialog';
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
                    // The same base minor unit the rows are rendered with, so an order stored
                    // without a currency of its own totals identically in the file (issue #292).
                    (rows) => buildPurchaseOrdersExport(format, rows, currencyDecimals),
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
  const { show } = useToast();
  const poQuery = usePurchaseOrder(poId);
  const locationsQuery = useLocations();

  const addLine = useAddPurchaseOrderLine();
  const removeLine = useRemovePurchaseOrderLine();
  const receiveLine = useReceivePurchaseOrderLine();
  const returnLine = useReturnPurchaseOrderLine();
  const setStatus = useSetPurchaseOrderStatus();
  const deletePo = useDeletePurchaseOrder();

  const [lineOpen, setLineOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [receiving, setReceiving] = useState<PurchaseOrderLine | null>(null);
  // The receiving line's item, read only while its dialog is open (issue #608): the tracking mode
  // decides whether the receipt can land stock at all, and therefore what the dialog may promise.
  // Read by id rather than looked up in `pickableItems`, which is only the first page of the
  // inventory — a line linked to an item outside that page would otherwise silently read as
  // stock-landing.
  const receivingItemQuery = useItem(receiving?.itemId ?? undefined);
  const [returning, setReturning] = useState<PurchaseOrderLine | null>(null);
  // Deleting an order — and removing one of its lines — is a hard delete that reaches every
  // synced device and has no restore path, so each is confirmed in its own dialog rather than
  // happening on the click that opened it (issue #588).
  const [confirmDeleteOrder, setConfirmDeleteOrder] = useState(false);
  // The line *id*, not the row: the order refetches while the dialog is open, so resolving the
  // row each render keeps the copy on the live figures — and a line that has gone (removed on
  // another device) closes the dialog rather than confirming against a row that no longer exists.
  const [confirmRemoveLineId, setConfirmRemoveLineId] = useState<string | null>(null);
  // Initial focus lands on the safe answer in both dialogs, so a reflex Enter keeps the record —
  // the same reason the destructive button is second in the row (see `UnsavedChangesPrompt`).
  const cancelDeleteOrderRef = useRef<HTMLButtonElement>(null);
  const cancelRemoveLineRef = useRef<HTMLButtonElement>(null);

  // WCAG 4.1.3 Status Messages — the badge transition and the receipt-progress
  // counter both change silently; announce each change via the always-mounted
  // LiveRegion so SR users hear the outcome of their explicit action.
  const [statusAnnouncement, setStatusAnnouncement] = useState('');
  const [receiptAnnouncement, setReceiptAnnouncement] = useState('');
  // Track the previous received/ordered totals so a useEffect can detect a real
  // change and announce it without firing on first render.
  const prevReceivedRef = useRef<number | null>(null);

  const locationOptions = useMemo<LocationOption[]>(() => {
    const rows = locationsQuery.data?.rows ?? [];
    return [
      { value: '', label: '— Item’s home location —' },
      ...rows.map((l) => ({ value: l.id, label: l.name })),
    ];
  }, [locationsQuery.data]);

  // Names for the items this order's lines are linked to, read by id in one round-trip. They used
  // to be taken from the line editor's candidate list, which was the first page of the catalogue —
  // so a line linked to anything outside that page fell back to its description, or to "Linked
  // item" when it had none (issue #484).
  const linkedItemIds = useMemo(
    () => (poQuery.data?.lines ?? []).flatMap((line) => (line.itemId === null ? [] : [line.itemId])),
    [poQuery.data],
  );
  const linkedItemsQuery = useItemsById(linkedItemIds);
  const itemNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const [id, item] of linkedItemsQuery.data ?? []) map.set(id, item.name);
    return map;
  }, [linkedItemsQuery.data]);

  /**
   * How a line is named on screen — the matched item's name, else the typed description. Shared
   * by the row, its remove button's accessible name and the confirmation copy, so all three
   * refer to the line the same way.
   */
  const describeLine = useCallback(
    (line: PurchaseOrderLine) =>
      line.itemId
        ? (itemNameById.get(line.itemId) ?? line.description ?? 'Linked item')
        : (line.description ?? 'Unnamed line'),
    [itemNameById],
  );

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
  // How the confirmation names the order: its reference when it has one — the thing a user
  // reconciles against an invoice — else the supplier it was raised against.
  const orderLabel = po.reference ?? po.supplierName ?? t('supplier.unknown');
  const removingLine = po.lines.find((l) => l.id === confirmRemoveLineId) ?? null;

  const deleteOrder = () => {
    deletePo.mutate(po.id, {
      onSuccess: () => {
        setConfirmDeleteOrder(false);
        show({
          tone: 'success',
          icon: <DeleteIcon />,
          heading: t('purchasing.orders.delete.toast.heading'),
          message: t('purchasing.orders.delete.toast.body', { vars: { order: orderLabel } }),
        });
        onDeleted();
      },
      // The mutation's own error toast names the failure; closing the dialog here would leave
      // it looking as though the order had gone, so it stays open for a second attempt.
    });
  };

  const removeLineNow = (line: PurchaseOrderLine) => {
    removeLine.mutate(
      { poId: po.id, lineId: line.id },
      {
        onSuccess: () => {
          setConfirmRemoveLineId(null);
          show({
            tone: 'success',
            icon: <DeleteIcon />,
            heading: t('purchasing.orders.line.remove.toast.heading'),
            message: t('purchasing.orders.line.remove.toast.body', {
              vars: { line: describeLine(line) },
            }),
          });
        },
      },
    );
  };

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
            // Cancelling is *reversible* — "Reopen as draft" above puts it straight back — so it
            // is not styled as the row's destructive action. Carrying the same solid red as
            // Delete order made the two read as the same weight of decision (issue #588).
            <Button
              variant="outline"
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
          {/* The irreversible action in this row, so it reads as its own thing: a text label
              rather than a bare bin beside "Cancel order", and de-emphasised so it is never the
              button reached for by accident. It asks before deleting. */}
          <Button
            variant="ghost"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => setConfirmDeleteOrder(true)}
            disabled={deletePo.isPending}
            data-testid="po-delete"
          >
            <DeleteIcon />
            {t('purchasing.orders.delete.trigger')}
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
              const label = describeLine(line);
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
                  {/* Named after the line it removes, so a screen reader hears which of the
                      several "remove" buttons in this list it has landed on — and ghost, not
                      solid red, so it doesn't outweigh the Receive/Return buttons beside it.
                      Removing the line is confirmed first (issue #588). */}
                  <Button
                    variant="ghost"
                    onClick={() => setConfirmRemoveLineId(line.id)}
                    disabled={removeLine.isPending}
                    aria-label={t('purchasing.orders.line.remove.label', { vars: { line: label } })}
                    data-testid="po-remove-line"
                  >
                    <DeleteIcon className="text-glyph-danger" />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </Surface>

      {/*
       * Confirming the order-level delete. It is a *hard* delete — the order and every line go,
       * a tombstone carries the deletion to every synced device, and nothing short of a backup
       * brings it back — so the copy names what is lost rather than asking a bare "are you sure":
       * which order, how many lines, and what happens to stock already received against it.
       */}
      <Modal
        open={confirmDeleteOrder}
        onClose={() => setConfirmDeleteOrder(false)}
        title={t('purchasing.orders.delete.title')}
        description={
          po.lines.length === 0
            ? t('purchasing.orders.delete.bodyEmpty', { vars: { order: orderLabel } })
            : t('purchasing.orders.delete.body', {
                vars: { order: orderLabel, count: po.lines.length },
              })
        }
        initialFocusRef={cancelDeleteOrderRef}
      >
        <div className="flex flex-col gap-4">
          {received > 0 ? (
            // The part that isn't obvious: the goods stay on the shelf, but the record of what
            // they cost and who they came from goes with the order.
            <Banner tone="warning">
              {t('purchasing.orders.delete.receivedNote', {
                vars: { received: f.quantity(received), ordered: f.quantity(ordered) },
              })}
            </Banner>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button
              ref={cancelDeleteOrderRef}
              variant="ghost"
              onClick={() => setConfirmDeleteOrder(false)}
              disabled={deletePo.isPending}
            >
              {t('purchasing.orders.delete.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={deleteOrder}
              disabled={deletePo.isPending}
              data-testid="po-delete-confirm"
            >
              {deletePo.isPending ? <Spinner /> : <DeleteIcon />}
              {t('purchasing.orders.delete.confirm')}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Confirming a line removal — the same hard delete, one line at a time. */}
      <Modal
        open={removingLine !== null}
        onClose={() => setConfirmRemoveLineId(null)}
        title={t('purchasing.orders.line.remove.title')}
        description={
          removingLine
            ? t('purchasing.orders.line.remove.body', { vars: { line: describeLine(removingLine) } })
            : undefined
        }
        initialFocusRef={cancelRemoveLineRef}
      >
        <div className="flex flex-col gap-4">
          {removingLine && removingLine.receivedQty > 0 ? (
            <Banner tone="warning">
              {t('purchasing.orders.delete.receivedNote', {
                vars: {
                  received: f.quantity(removingLine.receivedQty),
                  ordered: f.quantity(removingLine.orderedQty),
                },
              })}
            </Banner>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button
              ref={cancelRemoveLineRef}
              variant="ghost"
              onClick={() => setConfirmRemoveLineId(null)}
              disabled={removeLine.isPending}
            >
              {t('purchasing.orders.line.remove.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => removingLine && removeLineNow(removingLine)}
              disabled={removeLine.isPending}
              data-testid="po-remove-line-confirm"
            >
              {removeLine.isPending ? <Spinner /> : <DeleteIcon />}
              {t('purchasing.orders.line.remove.confirm')}
            </Button>
          </div>
        </div>
      </Modal>

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
          itemTrackingMode={receivingItemQuery.data?.trackingMode}
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
