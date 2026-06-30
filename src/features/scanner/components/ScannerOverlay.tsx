import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, Input, LiveRegion, Select, Surface, Tooltip } from '@/components/foundry';
import {
  CameraOffIcon,
  CheckoutIcon,
  CloseIcon,
  DiscreteIcon,
  MoveIcon,
  ScanIcon,
  SerialisedIcon,
} from '@/components/icons';
import { getItemRepository, type Item } from '@/db/repositories';
import { CheckoutDialog } from '@/features/contacts/components/CheckoutDialog';
import { useCheckoutItem } from '@/features/contacts/contacts';
import { useLocations } from '@/features/inventory/queries';
import { useMoveItem } from '@/features/inventory/mutations';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { runBatch, summariseBatch } from '../batch-actions';
import { ScanFeedback } from '../feedback';
import type { ScannerEngine } from '../barcode-decoder';
import { parseScannedCode } from '../scan-payload';
import {
  initialScannerState,
  scannerReducer,
  type ScannerMode,
} from '../scanner-machine';
import { ScannerQueueProvider, useScannerQueue } from '../ScannerQueueContext';
import { useScanner } from '../useScanner';

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
}: {
  open: boolean;
  onClose: () => void;
  /** Called with a scanned location id (Phase 73) — the parent selects it and closes. */
  onLocationScanned?: (locationId: string) => void;
}) {
  if (!open) return null;
  return (
    <ScannerQueueProvider>
      <ScannerOverlayInner onClose={onClose} onLocationScanned={onLocationScanned} />
    </ScannerQueueProvider>
  );
}

function ScannerOverlayInner({
  onClose,
  onLocationScanned,
}: {
  onClose: () => void;
  onLocationScanned?: (locationId: string) => void;
}) {
  const [state, dispatch] = useReducer(scannerReducer, undefined, () => initialScannerState('DISCRETE'));
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const feedback = useRef<ScanFeedback>(new ScanFeedback());
  const queue = useScannerQueue();
  const checkout = useCheckoutItem();
  const move = useMoveItem();
  const locations = useLocations();
  const locationRows = locations.data?.rows ?? [];
  const symbology = usePreferencesStore((s) => s.scannerSymbology);
  // §6.5 scan confirmation is user-mutable (quiet workshops, shared spaces, sensory
  // preference). Read both flags so a successful scan honours the current settings.
  const beepEnabled = usePreferencesStore((s) => s.scannerBeep);
  const hapticsEnabled = usePreferencesStore((s) => s.scannerHaptics);

  const [manual, setManual] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [discreteResult, setDiscreteResult] = useState<Item | null>(null);
  const [checkoutItem, setCheckoutItem] = useState<Item | null>(null);
  const [batchName, setBatchName] = useState('');
  const [moveTarget, setMoveTarget] = useState('');
  // The decoding engine is resolved asynchronously by useScanner (native → lazy WASM
  // → none); null until the camera is live. We only warn about manual-only entry once
  // it definitively resolves to 'none' (§6.6).
  const [engine, setEngine] = useState<ScannerEngine | null>(null);

  // Open the camera once on mount; prime audio from this user gesture (§6.5).
  useEffect(() => {
    feedback.current.prime();
    dispatch({ type: 'OPEN' });
    const fb = feedback.current;
    return () => fb.dispose();
  }, []);

  const handleDecode = useCallback(
    async (raw: string) => {
      const code = parseScannedCode(raw);
      if (!code) {
        setNotice('That code is not a Gubbins code.');
        return;
      }
      const confirmOpts = { beep: beepEnabled, haptics: hapticsEnabled };

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

      const item = await getItemRepository().getById(code.id);
      if (!item) {
        setNotice('No matching item found.');
        return;
      }
      setNotice(null);
      if (state.mode === 'CONTINUOUS') {
        const added = queue.offer(item.id, item.name);
        if (added) feedback.current.confirm(confirmOpts);
      } else {
        feedback.current.confirm(confirmOpts);
        dispatch({ type: 'REVIEW_QUEUE' }); // pause the live view
        setDiscreteResult(item);
      }
    },
    [state.mode, queue, beepEnabled, hapticsEnabled, locationRows, onLocationScanned],
  );

  useScanner({
    videoRef,
    status: state.status,
    dispatch,
    onDecode: handleDecode,
    onEngine: setEngine,
    symbology,
  });

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
    dispatch({ type: 'RESUME_SCANNING' });
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
        {discreteResult ? `Scanned ${discreteResult.name}` : null}
      </LiveRegion>

      {/* Header */}
      <div className="flex items-center gap-3 p-4">
        <ScanIcon className="size-5" />
        <span className="font-semibold">Scanner</span>
        <div className="ml-auto flex items-center rounded-lg bg-white/10 p-0.5">
          <Tooltip
            content="Scan **one** code, then act on it immediately (check out or look up)."
            triggerTabIndex={-1}
          >
            <ModeButton mode="DISCRETE" current={state.mode} onSelect={(m) => dispatch({ type: 'SET_MODE', mode: m })}>
              <DiscreteIcon /> Discrete
            </ModeButton>
          </Tooltip>
          <Tooltip
            content="Scan **many** codes into a queue, then apply one action (move or check out) to them all at once."
            triggerTabIndex={-1}
          >
            <ModeButton mode="CONTINUOUS" current={state.mode} onSelect={(m) => dispatch({ type: 'SET_MODE', mode: m })}>
              <SerialisedIcon /> Continuous
            </ModeButton>
          </Tooltip>
        </div>
        <Button variant="ghost" size="icon" onClick={close} aria-label="Close scanner" className="text-white hover:bg-white/10">
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
        {state.status === 'STREAM_ACTIVE' ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <div className="size-56 rounded-3xl border-2 border-white/70 shadow-[0_0_0_100vmax_rgba(0,0,0,0.45)]" />
          </div>
        ) : null}

        {state.status === 'ERROR_STATE' ? (
          <div className="absolute inset-0 grid place-items-center p-6">
            <Surface className="max-w-sm space-y-3 p-6 text-center text-foreground">
              <CameraOffIcon className="mx-auto size-8 text-muted-foreground" />
              <p className="text-sm">{state.error}</p>
              <Button onClick={() => dispatch({ type: 'OPEN' })}>Try the camera again</Button>
            </Surface>
          </div>
        ) : null}

        {state.status === 'REQUESTING_PERMISSIONS' ? (
          <p className="absolute text-sm text-white/80">Requesting camera access…</p>
        ) : null}

        {/* Discrete result card */}
        {discreteResult ? (
          <div className="absolute inset-x-0 bottom-0 p-4">
            <Surface className="space-y-3 p-4 text-foreground">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Scanned</p>
              <p className="text-lg font-semibold">{discreteResult.name}</p>
              <div className="flex gap-2">
                <Button onClick={() => setCheckoutItem(discreteResult)}>
                  <CheckoutIcon /> Check out
                </Button>
                <Button variant="outline" onClick={scanAgain}>
                  Scan again
                </Button>
              </div>
            </Surface>
          </div>
        ) : null}

        {/* Continuous queue review */}
        {state.status === 'PROCESSING_QUEUE' && !discreteResult ? (
          <div className="absolute inset-x-0 bottom-0 p-4">
            <Surface className="space-y-3 p-4 text-foreground">
              <p className="text-sm font-semibold">{queue.count} item{queue.count === 1 ? '' : 's'} in the queue</p>
              <ul className="max-h-40 space-y-1 overflow-auto text-sm">
                {queue.entries.map((e) => (
                  <li key={e.itemId} className="flex items-center justify-between gap-2">
                    <span className="truncate">{e.name ?? e.itemId}</span>
                    <button className="text-xs text-muted-foreground hover:text-destructive" onClick={() => queue.remove(e.itemId)}>
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
                  onChange={(e) => setMoveTarget(e.target.value)}
                  className="flex-1"
                  aria-label="Move all to location"
                  data-testid="scanner-move-location"
                >
                  <option value="">Move all to…</option>
                  {locationRows.map((loc) => (
                    <option key={loc.id} value={loc.id}>
                      {loc.name}
                    </option>
                  ))}
                </Select>
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
      <div className="space-y-2 p-4">
        {engine === 'none' ? (
          <p className="text-center text-xs text-white/70" data-testid="scanner-engine-none">
            Live scanning isn’t supported on this browser — enter a code below.
          </p>
        ) : engine === 'wasm' || engine === 'wasm-canvas' ? (
          <p className="text-center text-xs text-white/70" data-testid={`scanner-engine-${engine}`}>
            Using the compatibility scanner — point steadily at the code, or enter it below.
          </p>
        ) : null}
        {/* Manual-entry feedback ("No matching item found." etc.) is the screen-reader
            channel for the scanner: a blind user types a code and would otherwise get
            nothing back. Always-mounted polite region so the message is announced. */}
        <LiveRegion data-testid="scanner-notice">
          {notice ? <p className="text-center text-xs text-amber-300">{notice}</p> : null}
        </LiveRegion>
        <div className="mx-auto flex max-w-md gap-2">
          <Input
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submitManual()}
            placeholder="Enter or paste a code"
            className="bg-white/10 text-white placeholder:text-white/50"
            data-testid="scanner-manual-input"
          />
          <Button onClick={submitManual} data-testid="scanner-manual-submit">
            Enter
          </Button>
        </div>
      </div>

      {checkoutItem ? (
        <CheckoutDialog
          open
          item={checkoutItem}
          onClose={() => {
            setCheckoutItem(null);
            setDiscreteResult(null);
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
