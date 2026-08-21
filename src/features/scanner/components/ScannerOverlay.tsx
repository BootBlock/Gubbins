import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';

import { plural } from '@/lib/plural';
import { createPortal } from 'react-dom';
import { Button, Input, LiveRegion, Modal, Select, Surface, Tooltip } from '@/components/foundry';
import {
  AddIcon,
  CheckoutIcon,
  CloseIcon,
  DiscreteIcon,
  EditIcon,
  HelpIcon,
  InfoIcon,
  MoveIcon,
  NfcIcon,
  QrCodeIcon,
  ScanIcon,
  SerialisedIcon,
} from '@/components/icons';
import { getItemRepository, type Item } from '@/db/repositories';
import { CheckoutDialog } from '@/features/contacts/components/CheckoutDialog';
import { useCheckoutItem } from '@/features/contacts/contacts';
import { QuantityStepper } from '@/features/inventory/components/QuantityStepper';
import { shortId } from '@/features/inventory/labels/label-template';
import { useItem, useLocations } from '@/features/inventory/queries';
import { useMoveItem } from '@/features/inventory/mutations';
import { isUnlimited } from '@/features/inventory/unlimited';
import { useT } from '@/features/i18n';
import { useFeature } from '@/features/modules/useFeature';
import { ProductLookupPanel, type ProductLookupResultPayload } from '@/features/scraping';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { runBatch, summariseBatch } from '../batch-actions';
import { ScanFeedback } from '../feedback';
import type { ScannerEngineStatus } from '../barcode-decoder';
import { isShortItemCode, isStructuredQrPayload, parseScannedCode } from '../scan-payload';
import { initialScannerState, scannerReducer, type ScannerMode } from '../scanner-machine';
import { ScannerQueueProvider, useScannerQueue } from '../ScannerQueueContext';
import { useNfcScan } from '../useNfcScan';
import { useScanner } from '../useScanner';
import { ScannerViewfinder } from './ScannerViewfinder';

/**
 * The mobile scanner overlay (spec §6). A full-screen camera viewfinder governed by
 * the {@link scannerReducer} state machine, with Discrete (scan-one-then-act) and
 * Continuous (batch to a working queue) modes (§6.3), the §6.5 haptic/Web-Audio
 * confirmation, and a manual code-entry fallback for browsers without the native
 * Barcode Detection API (§6.6). The Continuous queue lives in a Tier-3
 * {@link ScannerQueueProvider} mounted with the overlay.
 */
export function ScannerOverlay({
  open,
  onClose,
  onLocationScanned,
  onCreateFromBarcode,
  onViewItem,
}: {
  open: boolean;
  onClose: () => void;
  /** Called with a scanned location id (Phase 73) — the parent selects it and closes. */
  onLocationScanned?: (locationId: string) => void;
  /**
   * Called with a valid retail barcode (GTIN) that no existing item carries — the parent
   * opens the add-item form pre-filled with it (recommendation point 1). When a product lookup
   * has already resolved the barcode here, the resolved product rides along so the form pre-fills
   * its name/brand/description too (issue #59). When omitted, an unknown barcode is still
   * recognised but the "Add item" affordance is hidden.
   */
  onCreateFromBarcode?: (gtin: string, product?: ProductLookupResultPayload) => void;
  /**
   * Called with the scanned item when the user taps "View details" on the Discrete result
   * card — the scanner has no deep-linkable item route (detail is dialog/list state), so the
   * parent routes it (jump-to-item: seed the search + highlight the card), mirroring the
   * command palette. When omitted the "View details" affordance is hidden.
   */
  onViewItem?: (item: Item) => void;
}) {
  if (!open) return null;
  return (
    <ScannerQueueProvider>
      <ScannerOverlayInner
        onClose={onClose}
        onLocationScanned={onLocationScanned}
        onCreateFromBarcode={onCreateFromBarcode}
        onViewItem={onViewItem}
      />
    </ScannerQueueProvider>
  );
}

function ScannerOverlayInner({
  onClose,
  onLocationScanned,
  onCreateFromBarcode,
  onViewItem,
}: {
  onClose: () => void;
  onLocationScanned?: (locationId: string) => void;
  onCreateFromBarcode?: (gtin: string, product?: ProductLookupResultPayload) => void;
  onViewItem?: (item: Item) => void;
}) {
  const t = useT();
  const [state, dispatch] = useReducer(scannerReducer, undefined, () => initialScannerState('DISCRETE'));
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // The framing reticle: the decoder crops each frame to this box so a barcode framed in it is
  // large relative to the analysed pixels on any viewport shape (issue #59).
  const reticleRef = useRef<HTMLDivElement | null>(null);
  const feedback = useRef<ScanFeedback>(new ScanFeedback());
  const queue = useScannerQueue();
  const checkout = useCheckoutItem();
  const move = useMoveItem();
  const locations = useLocations();
  const locationRows = useMemo(() => locations.data?.rows ?? [], [locations.data?.rows]);
  const symbology = usePreferencesStore((s) => s.scannerSymbology);
  // §6.5 scan confirmation is user-mutable (quiet workshops, shared spaces, sensory
  // preference). Read both flags so a successful scan honours the current settings.
  const beepEnabled = usePreferencesStore((s) => s.scannerBeep);
  const hapticsEnabled = usePreferencesStore((s) => s.scannerHaptics);
  // Which camera to open, and where the viewfinder's picker writes the user's choice (issue #135).
  const cameraId = usePreferencesStore((s) => s.scannerCameraId);
  const setCameraId = usePreferencesStore((s) => s.setScannerCameraId);

  const [manual, setManual] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  // The "What can I scan?" explainer — the scanner accepts several kinds of code (Gubbins
  // item/location QR labels and retail EAN/UPC barcodes) and this is where that is spelled
  // out, so the button is never a mystery. Closed by default; opened from the header.
  const [helpOpen, setHelpOpen] = useState(false);
  const [discreteResult, setDiscreteResult] = useState<Item | null>(null);
  // A recognised retail barcode that no item carries yet — offer to create one (point 1).
  const [gtinResult, setGtinResult] = useState<string | null>(null);
  // A product resolved for that unknown barcode via an online / extension lookup (issue #59), so
  // the "Add item" hand-off can pre-fill its name and brand rather than just the bare number.
  const [lookupResult, setLookupResult] = useState<ProductLookupResultPayload | null>(null);
  const [checkoutItem, setCheckoutItem] = useState<Item | null>(null);
  const [batchName, setBatchName] = useState('');
  const [moveTarget, setMoveTarget] = useState('');
  // The Discrete result card's own move-target, kept separate from the Continuous
  // `moveTarget` so the two never cross-talk.
  const [singleMove, setSingleMove] = useState('');
  // Track the scanned Discrete item live so the ± stepper's optimistic adjustments (which
  // patch the `inventoryKeys.item(id)` cache) flow back into the card — `discreteResult` is
  // only the snapshot taken at scan time. Falls back to that snapshot until the query loads.
  const liveDiscrete = useItem(discreteResult?.id);
  const scanned = discreteResult ? (liveDiscrete.data ?? discreteResult) : null;
  // The decoding engine is resolved asynchronously by useScanner (native → lazy WASM
  // → none); null until the camera is live. We only warn about manual-only entry once
  // it definitively resolves to 'none' (§6.6) — or to 'failed', when an engine that did
  // resolve later died under us (issue #678).
  const [engine, setEngine] = useState<ScannerEngineStatus | null>(null);

  // Open the camera once on mount; prime audio from this user gesture (§6.5).
  useEffect(() => {
    feedback.current.prime();
    dispatch({ type: 'OPEN' });
    const fb = feedback.current;
    return () => fb.dispose();
  }, []);

  const handleDecode = useCallback(
    async (raw: string) => {
      const confirmOpts = { beep: beepEnabled, haptics: hapticsEnabled };

      // A resolved item (from a Gubbins code, or a retail barcode an item already carries)
      // is confirmed and either queued (Continuous) or shown for a Discrete action.
      const presentItem = (item: Item) => {
        setNotice(null);
        setGtinResult(null);
        setLookupResult(null);
        if (state.mode === 'CONTINUOUS') {
          const added = queue.offer(item.id, item.name);
          if (added) feedback.current.confirm(confirmOpts);
        } else {
          feedback.current.confirm(confirmOpts);
          dispatch({ type: 'REVIEW_QUEUE' }); // pause the live view
          setDiscreteResult(item);
        }
      };

      /**
       * Resolve a printed **short code** — the eight-character fallback identifier every label
       * carries (issue #338), and the value a label's Code 128 falls back to when the preferred
       * one is too long to print (issue #331). Returns true when the scan was dealt with here.
       *
       * This is what makes that line an identifier rather than an ornament: a torn QR, a
       * smudged barcode or a name since edited, and the printed code is all that is left to
       * type into the box below. A prefix can in principle name two records, so an ambiguous
       * code says so instead of opening whichever came back first.
       */
      const resolveShortCode = async (value: string): Promise<boolean> => {
        if (!isShortItemCode(value)) return false;
        const matches = await getItemRepository().findByShortCode(value);
        if (matches.length > 1) {
          setNotice(t('scanner.shortCode.ambiguous'));
          return true;
        }
        if (matches.length === 1) {
          presentItem(matches[0]!);
          return true;
        }
        // Location labels print the same fallback line, and the loaded rows answer for free.
        const short = value.trim().toUpperCase();
        const loc = locationRows.find((l) => shortId(l.id) === short);
        if (!loc) return false;
        setNotice(null);
        feedback.current.confirm(confirmOpts);
        onLocationScanned?.(loc.id);
        return true;
      };

      const code = parseScannedCode(raw);
      if (!code) {
        // Not a code the pure parser knows — but a short code names nothing on its own, so it
        // can only be recognised by asking the database. Try that before giving up.
        if (await resolveShortCode(raw)) return;
        // A marketing QR resolves to a website link, not a Gubbins code or a barcode — name
        // that plainly rather than a generic "unrecognised" (issue #59).
        setNotice(
          isStructuredQrPayload(raw)
            ? 'That’s a website link, not a Gubbins code or a product barcode.'
            : 'That code isn’t a Gubbins code or a recognised barcode.',
        );
        return;
      }

      // A scanned location label jumps straight to that location (Phase 73). Validate
      // it against the loaded list, then hand off to the parent to select it + close.
      if (code.kind === 'location') {
        const loc = locationRows.find((l) => l.id === code.id);
        if (!loc) {
          setNotice('No matching location found.');
          return;
        }
        setNotice(null);
        feedback.current.confirm(confirmOpts);
        onLocationScanned?.(code.id);
        return;
      }

      // A retail barcode (GTIN): resolve it to an item that already records it; failing
      // that, offer to create one (recommendation point 1). Never a dead end.
      if (code.kind === 'gtin') {
        const existing = await getItemRepository().getByBarcode(code.gtin);
        if (existing) {
          presentItem(existing);
          return;
        }
        // An eight-digit short code is also a syntactically valid EAN-8, so a label's own
        // fallback code can arrive here. A retail barcode an item actually carries wins (above);
        // failing that, try the short code before offering to create a product for it.
        if (await resolveShortCode(raw)) return;
        setNotice(null);
        feedback.current.confirm(confirmOpts);
        dispatch({ type: 'REVIEW_QUEUE' }); // pause the live view for the prompt
        setDiscreteResult(null);
        setLookupResult(null);
        setGtinResult(code.gtin);
        return;
      }

      const item = await getItemRepository().getById(code.id);
      if (!item) {
        setNotice('No matching item found.');
        return;
      }
      presentItem(item);
    },
    [t, state.mode, queue, beepEnabled, hapticsEnabled, locationRows, onLocationScanned],
  );

  const camera = useScanner({
    videoRef,
    roiRef: reticleRef,
    status: state.status,
    dispatch,
    onDecode: (raw) => void handleDecode(raw),
    onEngine: setEngine,
    // A torch or camera the hardware refused isn't a scan failure — say so through the same notice
    // region a manual-entry miss uses, which is the screen-reader channel for this screen.
    onCameraWarning: setNotice,
    symbology,
    cameraId,
  });

  // Tap-to-scan over Web NFC (issue #71), alongside the camera. Only arms where the user has
  // the NFC capability on *and* the device supports the API; a tapped tag feeds the same
  // `handleDecode` path as a camera read, and a start/read failure surfaces via the notice
  // region (the screen-reader channel) just like a manual-entry miss.
  const nfcFeature = useFeature('nfc');
  const nfc = useNfcScan({
    active: nfcFeature,
    onRead: (raw) => void handleDecode(raw),
    onError: setNotice,
  });
  const nfcReady = nfcFeature && nfc.supported;

  const close = () => {
    dispatch({ type: 'CLOSE' });
    onClose();
  };

  const submitManual = () => {
    const value = manual.trim();
    if (value.length === 0) return;
    setManual('');
    void handleDecode(value);
  };

  const scanAgain = () => {
    setDiscreteResult(null);
    setGtinResult(null);
    setLookupResult(null);
    setSingleMove('');
    dispatch({ type: 'RESUME_SCANNING' });
  };

  // Move the single scanned item to a location — the one-id peer of the Continuous
  // `batchMove`, through the same `useMoveItem` seam. The card stays put afterwards so
  // several actions can be applied to the same scanned item; the outcome is announced
  // through the always-mounted notice region (the SR channel).
  const moveScanned = async () => {
    if (!discreteResult || singleMove === '') return;
    const name = locationRows.find((l) => l.id === singleMove)?.name ?? 'the location';
    await move.mutateAsync({ id: discreteResult.id, locationId: singleMove });
    setNotice(`Moved ${discreteResult.name} to ${name}.`);
    setSingleMove('');
  };

  // Hand the scanned item back to the parent to open its full record (jump-to-item), then
  // close the scanner. The scanner has no deep-linkable item route, so the parent routes it.
  const viewScanned = () => {
    if (!discreteResult) return;
    const item = discreteResult;
    setDiscreteResult(null);
    setSingleMove('');
    dispatch({ type: 'CLOSE' });
    onViewItem?.(item);
    onClose();
  };

  // Hand a fresh barcode to the parent to seed the add-item form, then close the scanner. A
  // product resolved by the lookup rides along so its name/brand pre-fill the form too (issue #59).
  const createFromBarcode = () => {
    if (!gtinResult) return;
    const gtin = gtinResult;
    const product = lookupResult ?? undefined;
    setGtinResult(null);
    setLookupResult(null);
    dispatch({ type: 'CLOSE' });
    onCreateFromBarcode?.(gtin, product);
    onClose();
  };

  const reviewQueue = () => dispatch({ type: 'REVIEW_QUEUE' });

  // §6.3 finalisation: apply one batch action to the whole working queue. Both paths
  // run through the pure `runBatch` so a single failed item never aborts the rest, and
  // announce the outcome via the always-mounted notice region (the SR channel).
  const ids = () => queue.entries.map((e) => e.itemId);

  const batchCheckout = async () => {
    const contact = batchName.trim();
    if (contact.length === 0 || queue.count === 0) return;
    const outcome = await runBatch(ids(), (id) => checkout.mutateAsync({ itemId: id, contactName: contact }));
    setNotice(summariseBatch('CHECKOUT', outcome, contact));
    queue.clear();
    setBatchName('');
    dispatch({ type: 'RESUME_SCANNING' });
  };

  const batchMove = async () => {
    if (moveTarget === '' || queue.count === 0) return;
    const outcome = await runBatch(ids(), (id) => move.mutateAsync({ id, locationId: moveTarget }));
    const name = locationRows.find((l) => l.id === moveTarget)?.name ?? 'the location';
    setNotice(summariseBatch('MOVE', outcome, name));
    queue.clear();
    setMoveTarget('');
    dispatch({ type: 'RESUME_SCANNING' });
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col bg-black/90 text-white" data-testid="scanner-overlay">
      {/* Announce a discrete scan result for screen readers: the visible result card is
          interactive (buttons), so the announcement lives in a separate hidden region. */}
      <LiveRegion visuallyHidden data-testid="scanner-scan-announce">
        {discreteResult
          ? `Scanned ${discreteResult.name}`
          : gtinResult
            ? `Scanned barcode ${gtinResult}, not in your inventory`
            : null}
      </LiveRegion>

      {/* Header
          The row holds more than a 320px-wide viewport can fit on one line (WCAG 1.4.10
          Reflow), and the overlay is `fixed`, so anything that overflows is unreachable
          rather than merely off to the side. So it wraps instead: Close and Help stay
          pinned to the first line, the title absorbs the pressure by truncating, and the
          mode toggle drops onto a second line below `sm`. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 p-4 pt-safe-gutter-top pr-safe-gutter-right pl-safe-gutter-left">
        <ScanIcon className="size-5 shrink-0" />
        <span className="min-w-0 flex-1 truncate font-semibold">Scanner</span>
        {/* The wrapper takes the whole second line so the toggle drops below the title; the
            pill inside stays sized to its two buttons rather than stretching across it. */}
        <div
          className="order-last flex basis-full sm:order-none sm:basis-auto"
          data-testid="scanner-mode-toggle"
        >
          <div className="flex items-center rounded-lg bg-white/10 p-0.5">
            <Tooltip
              content="Scan **one** code, then act on it immediately (check out or look up)."
              triggerTabIndex={-1}
            >
              <ModeButton
                mode="DISCRETE"
                current={state.mode}
                onSelect={(m) => dispatch({ type: 'SET_MODE', mode: m })}
              >
                <DiscreteIcon /> Discrete
              </ModeButton>
            </Tooltip>
            <Tooltip
              content="Scan **many** codes into a queue, then apply one action (move or check out) to them all at once."
              triggerTabIndex={-1}
            >
              <ModeButton
                mode="CONTINUOUS"
                current={state.mode}
                onSelect={(m) => dispatch({ type: 'SET_MODE', mode: m })}
              >
                <SerialisedIcon /> Continuous
              </ModeButton>
            </Tooltip>
          </div>
        </div>
        {/* `shrink-0` sits on the Tooltip: its wrapper span is the flex item, not the Button. */}
        <Tooltip content="What can I scan?" triggerTabIndex={-1} className="shrink-0">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setHelpOpen(true)}
            aria-label="What can I scan?"
            aria-haspopup="dialog"
            className="text-white hover:bg-white/10"
          >
            <HelpIcon />
          </Button>
        </Tooltip>
        <Button
          variant="ghost"
          size="icon"
          onClick={close}
          aria-label="Close scanner"
          className="shrink-0 text-white hover:bg-white/10"
        >
          <CloseIcon />
        </Button>
      </div>

      {/* Viewfinder / state */}
      <div className="relative flex flex-1 items-center justify-center overflow-hidden">
        <video
          ref={videoRef}
          className="h-full w-full object-cover"
          muted
          playsInline
          data-testid="scanner-video"
        />
        {/* The framing reticle, live "Scanning…" activity feedback and permission/error states —
            shared with the Add/Edit-item barcode dialog so both stay in step (issue #58). The
            idle guidance says plainly what the frame is looking for; the header's "?" opens the
            fuller explainer. */}
        <ScannerViewfinder
          status={state.status}
          hint="Point at a Gubbins QR label or a product barcode"
          hintTestId="scanner-idle-hint"
          error={state.error}
          onRetry={() => dispatch({ type: 'OPEN' })}
          reticleRef={reticleRef}
          camera={camera}
          onSelectCamera={setCameraId}
        />

        {/* "Ready to tap" NFC indicator (issue #71) — shown only where the NFC capability is on
            and the device supports Web NFC. `role="status"` announces readiness and any
            start-time error (e.g. permission denied) once; tapped-tag results are announced
            through the separate scan-announce region above. */}
        {nfcReady ? (
          <div className="absolute inset-x-0 top-3 z-10 flex justify-center px-safe-gutter-x">
            <span
              role="status"
              data-testid="scanner-nfc-indicator"
              className={`flex items-center gap-2 rounded-full bg-white/10 px-4 py-1.5 text-xs font-medium backdrop-blur ${
                nfc.status === 'error' ? 'text-warning' : 'text-white/90'
              }`}
            >
              <NfcIcon className="size-4" aria-hidden />
              {nfc.status === 'error'
                ? nfc.error
                : nfc.status === 'ready'
                  ? 'Ready — tap an NFC tag'
                  : 'Starting NFC…'}
            </span>
          </div>
        ) : null}

        {/* Discrete result card — act on one scanned item without leaving the scanner. */}
        {scanned ? (
          <div className="absolute inset-x-0 bottom-0 p-4 pr-safe-gutter-right pl-safe-gutter-left">
            <Surface className="space-y-3 p-4 text-foreground" data-testid="scanner-discrete-result">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Scanned</p>
              <p className="text-lg font-semibold">{scanned.name}</p>

              {/* Record usage/restock inline for a countable item — the core scan→act loop.
                  Gated exactly as the item card is: active, DISCRETE, not an unlimited source.
                  Gauge / serialised / untracked / unlimited items skip ± (it doesn't apply) and
                  keep check-out / move / view below. Reuses `QuantityStepper`, whose optimistic
                  `useAdjustQuantity` writes flow back via the `useItem` subscription above. */}
              {scanned.trackingMode === 'DISCRETE' && scanned.isActive && !isUnlimited(scanned) ? (
                <div className="flex items-center gap-2" data-testid="scanner-adjust-quantity">
                  <span className="text-xs text-muted-foreground">On hand</span>
                  <QuantityStepper id={scanned.id} quantity={scanned.quantity} />
                </div>
              ) : null}

              <div className="flex flex-wrap gap-2">
                <Button onClick={() => setCheckoutItem(discreteResult)}>
                  <CheckoutIcon /> Check out
                </Button>
                {onViewItem ? (
                  <Button variant="outline" onClick={viewScanned} data-testid="scanner-view-item">
                    <EditIcon /> View details
                  </Button>
                ) : null}
                <Button variant="outline" onClick={scanAgain}>
                  Scan again
                </Button>
              </div>

              {/* Move this one item to a location — the single-item peer of the Continuous
                  batch move, through the same `useMoveItem` seam. */}
              <div className="flex gap-2 border-t border-border/60 pt-3">
                <Select
                  value={singleMove}
                  onChange={setSingleMove}
                  className="flex-1"
                  aria-label="Move to location"
                  data-testid="scanner-move-single-location"
                  options={[
                    { value: '', label: 'Move to…' },
                    ...locationRows.map((loc) => ({ value: loc.id, label: loc.name })),
                  ]}
                />
                <Button
                  variant="outline"
                  onClick={() => void moveScanned()}
                  disabled={singleMove === '' || move.isPending}
                  data-testid="scanner-move-single"
                >
                  <MoveIcon /> Move here
                </Button>
              </div>
            </Surface>
          </div>
        ) : null}

        {/* Unknown-barcode card: a valid GTIN no item carries yet (recommendation point 1).
            Offer to create an item pre-filled with it (when the parent wired the handoff). */}
        {gtinResult ? (
          <div className="absolute inset-x-0 bottom-0 p-4 pr-safe-gutter-right pl-safe-gutter-left">
            <Surface className="space-y-3 p-4 text-foreground" data-testid="scanner-gtin-result">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">New barcode</p>
              <p className="font-mono text-lg font-semibold tracking-wide">{gtinResult}</p>
              {lookupResult ? (
                <p className="text-sm text-muted-foreground" data-testid="scanner-gtin-product">
                  Found <span className="font-medium text-foreground">{lookupResult.name}</span>
                  {lookupResult.brand ? ` · ${lookupResult.brand}` : ''} — its details will pre-fill the new
                  item.
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No item in your inventory has this barcode yet.
                </p>
              )}
              {/* Identify the product by its barcode (issue #59): the same keyless lookup the add-item
                  form offers — the companion extension when present, else the open Open Food Facts
                  database after a one-time consent. On a hit its name/brand pre-fill the new item. It
                  renders nothing when the lookup capability is off, so it degrades to manual entry. */}
              {!lookupResult ? (
                <ProductLookupPanel
                  barcode={gtinResult}
                  onResult={setLookupResult}
                  onEnterManually={onCreateFromBarcode ? createFromBarcode : undefined}
                />
              ) : null}
              <div className="flex gap-2">
                {onCreateFromBarcode ? (
                  <Button onClick={createFromBarcode} data-testid="scanner-create-from-barcode">
                    <AddIcon /> Add item with this barcode
                  </Button>
                ) : null}
                <Button variant="outline" onClick={scanAgain}>
                  Scan again
                </Button>
              </div>
            </Surface>
          </div>
        ) : null}

        {/* Continuous queue review */}
        {state.status === 'PROCESSING_QUEUE' && !discreteResult && !gtinResult ? (
          <div className="absolute inset-x-0 bottom-0 p-4 pr-safe-gutter-right pl-safe-gutter-left">
            <Surface className="space-y-3 p-4 text-foreground">
              <p className="text-sm font-semibold">
                {queue.count} {plural(queue.count, 'item')} in the queue
              </p>
              <ul className="max-h-40 space-y-1 overflow-auto text-sm">
                {queue.entries.map((e) => (
                  <li key={e.itemId} className="flex items-center justify-between gap-2">
                    <span className="truncate">{e.name ?? e.itemId}</span>
                    <button
                      className="text-xs text-muted-foreground hover:text-destructive"
                      onClick={() => queue.remove(e.itemId)}
                    >
                      remove
                    </button>
                  </li>
                ))}
              </ul>
              <Input
                value={batchName}
                onChange={(e) => setBatchName(e.target.value)}
                placeholder="Check all out to…"
                data-testid="scanner-batch-contact"
              />
              <div className="flex gap-2">
                <Button
                  onClick={() => void batchCheckout()}
                  disabled={queue.count === 0 || batchName.trim().length === 0 || checkout.isPending}
                  data-testid="scanner-checkout-all"
                >
                  <CheckoutIcon /> Check out all
                </Button>
                <Button variant="outline" onClick={() => dispatch({ type: 'RESUME_SCANNING' })}>
                  Keep scanning
                </Button>
              </div>

              {/* §6.3 headline batch action: move the whole queue to a new location. */}
              <div className="flex gap-2 border-t border-border/60 pt-3">
                <Select
                  value={moveTarget}
                  onChange={setMoveTarget}
                  className="flex-1"
                  aria-label="Move all to location"
                  data-testid="scanner-move-location"
                  options={[
                    { value: '', label: 'Move all to…' },
                    ...locationRows.map((loc) => ({ value: loc.id, label: loc.name })),
                  ]}
                />
                <Button
                  variant="outline"
                  onClick={() => void batchMove()}
                  disabled={queue.count === 0 || moveTarget === '' || move.isPending}
                  data-testid="scanner-move-all"
                >
                  <MoveIcon /> Move all
                </Button>
              </div>
            </Surface>
          </div>
        ) : null}

        {/* Continuous queue toast */}
        {state.mode === 'CONTINUOUS' && state.status === 'STREAM_ACTIVE' && queue.count > 0 ? (
          <button
            className="absolute inset-x-0 bottom-4 mx-auto flex w-fit items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground shadow-lg"
            onClick={reviewQueue}
          >
            {queue.count} scanned · tap to review
          </button>
        ) : null}
      </div>

      {/* Manual entry — graceful fallback (§6.6) and always-available aid */}
      <div className="space-y-2 p-4 pb-safe-gutter-bottom pr-safe-gutter-right pl-safe-gutter-left">
        {/* The scanner's screen-reader channel, and the one region both its in-place messages
            live in: which engine resolved (or that it died mid-scan, issue #678) and the
            manual-entry feedback ("No matching item found." etc.) — a blind user types a code
            and would otherwise get nothing back. Both arrive *after* mount, so the region is
            always mounted and only its children change; a region inserted alongside its message
            is frequently never announced. */}
        <LiveRegion className="space-y-2" data-testid="scanner-notice">
          {engine === 'none' ? (
            <p className="text-center text-xs text-white/70" data-testid="scanner-engine-none">
              Live scanning isn’t supported on this browser — enter a code below.
            </p>
          ) : engine === 'failed' ? (
            <p className="text-center text-xs text-white/70" data-testid="scanner-engine-failed">
              {t('scanner.engine.stopped')}
            </p>
          ) : engine === 'wasm' || engine === 'wasm-canvas' ? (
            <p className="text-center text-xs text-white/70" data-testid={`scanner-engine-${engine}`}>
              Using the compatibility scanner — point steadily at the code, or enter it below.
            </p>
          ) : null}
          {notice ? <p className="text-center text-xs text-warning">{notice}</p> : null}
        </LiveRegion>
        <div className="mx-auto flex max-w-md gap-2">
          <Input
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submitManual()}
            placeholder={t('scanner.manual.placeholder')}
            className="bg-white/10 text-white placeholder:text-white/50"
            data-testid="scanner-manual-input"
          />
          <Button onClick={submitManual} data-testid="scanner-manual-submit">
            Enter
          </Button>
        </div>
      </div>

      {/* "What can I scan?" — the answer to the recurring question (issue #5): the scanner
          reads Gubbins' own printed QR labels and ordinary retail barcodes, and it does the
          matching on-device rather than looking products up online. A Foundry Modal so the
          panel is focus-trapped, Escape-dismissable and announced. */}
      <Modal open={helpOpen} onClose={() => setHelpOpen(false)} title="What can I scan?">
        <div className="space-y-4">
          <ul className="space-y-4 text-sm">
            <li className="flex gap-3">
              <QrCodeIcon className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
              <span>
                <span className="font-medium">Gubbins labels</span> — the QR codes you print for your items
                and locations. Scanning an item opens it to adjust, check out or move; scanning a location
                jumps straight to it.
              </span>
            </li>
            <li className="flex gap-3">
              <QrCodeIcon className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
              <span>
                <span className="font-medium">{t('scanner.help.shortCode.title')}</span> —{' '}
                {t('scanner.help.shortCode.body')}
              </span>
            </li>
            <li className="flex gap-3">
              <SerialisedIcon className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
              <span>
                <span className="font-medium">Product barcodes</span> — a shop's EAN or UPC barcode. Gubbins
                finds the item that already carries it, or offers to add a new item with the barcode saved to
                it — and can look the product up to fill in its name and brand.
              </span>
            </li>
            {nfcReady ? (
              <li className="flex gap-3" data-testid="scanner-help-nfc">
                <NfcIcon className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
                <span>
                  <span className="font-medium">NFC tags</span> — tap a tag you've written from an item's
                  label to open it, just like scanning its QR code. Hold the tag flat against the back of your
                  phone.
                </span>
              </li>
            ) : null}
          </ul>
          <p className="flex gap-2 text-xs text-muted-foreground">
            <InfoIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              Codes are matched against your own inventory on this device first. Looking a product up online
              is optional — it happens only when you tap “Look up”, and you're asked before the first time.
            </span>
          </p>
          <Button onClick={() => setHelpOpen(false)} className="w-full">
            Got it
          </Button>
        </div>
      </Modal>

      {checkoutItem ? (
        <CheckoutDialog
          open
          item={checkoutItem}
          onClose={() => {
            setCheckoutItem(null);
            setDiscreteResult(null);
            setSingleMove('');
            dispatch({ type: 'RESUME_SCANNING' });
          }}
        />
      ) : null}
    </div>,
    document.body,
  );
}

function ModeButton({
  mode,
  current,
  onSelect,
  children,
}: {
  mode: ScannerMode;
  current: ScannerMode;
  onSelect: (m: ScannerMode) => void;
  children: React.ReactNode;
}) {
  const activeCls = current === mode ? 'bg-white text-black' : 'text-white/80';
  return (
    <button
      className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors [&_svg]:size-3.5 ${activeCls}`}
      onClick={() => onSelect(mode)}
      aria-pressed={current === mode}
    >
      {children}
    </button>
  );
}
