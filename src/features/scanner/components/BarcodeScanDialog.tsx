import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Button, Input, LiveRegion, Surface } from '@/components/foundry';
import { FOCUSABLE_SELECTOR, nextTrapIndex } from '@/components/foundry/focus-trap';
import { isTopModal, popModal, pushModal } from '@/components/foundry/modal-stack';
import { CameraOffIcon, CloseIcon, ScanIcon } from '@/components/icons';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import type { ScannerEngine } from '../barcode-decoder';
import { ScanFeedback } from '../feedback';
import { parseScannedCode } from '../scan-payload';
import { initialScannerState, scannerReducer } from '../scanner-machine';
import { useScanner } from '../useScanner';

/**
 * A focused camera dialog that captures a single **retail barcode** and hands it back
 * (issue #8) — the "Scan" affordance beside the Add/Edit-item Barcode field, so a GTIN
 * need not be typed by hand.
 *
 * It deliberately reuses the app's one barcode-reading path rather than re-implementing
 * it: the tiered camera decode engine + permission/visibility lifecycle live in
 * {@link useScanner}, the pure decode/validation in {@link parseScannedCode} (GTIN check
 * via `gtin.ts`), the state machine in {@link scannerReducer}, and the §6.5 haptic/beep
 * confirmation in {@link ScanFeedback}. Only the *outcome* differs from the full
 * {@link ScannerOverlay}: instead of resolving the code to an inventory item and offering
 * scan→act, a decoded barcode is simply returned to the caller and the dialog closes.
 *
 * A scanned Gubbins QR label (an item/location deep-link) is politely rejected — it is not
 * a product barcode. A manual-entry box is always available as the graceful fallback for
 * browsers without a live-scan engine (§6.6), exactly as the overlay provides.
 */
export function BarcodeScanDialog({
  open,
  onClose,
  onCapture,
}: {
  open: boolean;
  onClose: () => void;
  /** Called with the decoded barcode (a normalised GTIN, else the raw decoded value). */
  onCapture: (barcode: string) => void;
}) {
  if (!open) return null;
  return <BarcodeScanDialogInner onClose={onClose} onCapture={onCapture} />;
}

function BarcodeScanDialogInner({
  onClose,
  onCapture,
}: {
  onClose: () => void;
  onCapture: (barcode: string) => void;
}) {
  const [state, dispatch] = useReducer(scannerReducer, undefined, () => initialScannerState('DISCRETE'));
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const feedback = useRef<ScanFeedback>(new ScanFeedback());
  // Latched once a barcode is captured, so a decoder that emits several codes in the same
  // frame (before the parent unmounts us) hands back only the first — no double capture.
  const capturedRef = useRef(false);
  const symbology = usePreferencesStore((s) => s.scannerSymbology);
  // §6.5 scan confirmation is user-mutable; honour the current settings on a hit.
  const beepEnabled = usePreferencesStore((s) => s.scannerBeep);
  const hapticsEnabled = usePreferencesStore((s) => s.scannerHaptics);

  const [manual, setManual] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [engine, setEngine] = useState<ScannerEngine | null>(null);

  const close = useCallback(() => {
    dispatch({ type: 'CLOSE' });
    onClose();
  }, [onClose]);
  // Latest `close` without re-running the mount-only stack effect (the parent passes an
  // inline closure that changes every render — cf. Foundry Modal's `onCloseRef`).
  const closeRef = useRef(close);
  closeRef.current = close;

  // Open the camera once on mount; prime audio from this user gesture (§6.5). Park focus on the
  // aria-labelled container so a screen reader announces the dialog (not the Close button), and
  // restore focus to whatever opened it (the "Scan" button) on close — the same contract Foundry
  // Modal gives, which this raw-portal takeover must reproduce itself.
  useEffect(() => {
    feedback.current.prime();
    dispatch({ type: 'OPEN' });
    const previouslyFocused = document.activeElement as HTMLElement | null;
    containerRef.current?.focus();
    const fb = feedback.current;
    return () => {
      fb.dispose();
      previouslyFocused?.focus?.();
    };
  }, []);

  // Register on the shared modal stack so this full-screen takeover behaves as the topmost
  // dialog: it can open over the Add/Edit-item {@link RailModal}, and only the topmost may
  // handle Escape/Tab — otherwise one Escape would also close the form underneath. Mirrors
  // Foundry {@link Modal}'s own keyboard contract, reusing its `modal-stack` / `focus-trap`
  // seams rather than re-implementing them. The parent Modal already owns the body scroll
  // lock; we only take keyboard ownership here.
  useEffect(() => {
    const token = pushModal();
    const onKey = (e: KeyboardEvent) => {
      if (!isTopModal(token)) return;
      if (e.key === 'Escape') {
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const container = containerRef.current;
      if (!container) return;
      const focusables = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      const active = document.activeElement as HTMLElement | null;
      const currentIndex = active ? focusables.indexOf(active) : -1;
      const next = nextTrapIndex(focusables.length, currentIndex, e.shiftKey);
      e.preventDefault();
      if (next === null) container.focus();
      else focusables[next]?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      popModal(token);
    };
  }, []);

  const handleDecode = useCallback(
    (raw: string) => {
      if (capturedRef.current) return;
      const code = parseScannedCode(raw);
      // A Gubbins item/location QR label is not a product barcode — say so rather than
      // dropping its deep-link URL into the barcode field.
      if (code?.kind === 'item' || code?.kind === 'location') {
        setNotice('That’s a Gubbins label — scan the product’s own barcode instead.');
        return;
      }
      // A valid retail barcode is normalised to its canonical GTIN; any other decoded
      // symbology (e.g. a Code 128 part label) is captured verbatim.
      const value = code?.kind === 'gtin' ? code.gtin : raw.trim();
      if (value.length === 0) return;
      capturedRef.current = true;
      feedback.current.confirm({ beep: beepEnabled, haptics: hapticsEnabled });
      onCapture(value);
      close();
    },
    [beepEnabled, hapticsEnabled, onCapture, close],
  );

  useScanner({
    videoRef,
    status: state.status,
    dispatch,
    onDecode: handleDecode,
    onEngine: setEngine,
    symbology,
  });

  const submitManual = () => {
    const value = manual.trim();
    if (value.length === 0) return;
    setManual('');
    handleDecode(value);
  };

  return createPortal(
    <div
      ref={containerRef}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex flex-col bg-black/90 text-white outline-none"
      role="dialog"
      aria-modal="true"
      aria-label="Scan a barcode"
      data-testid="barcode-scan-dialog"
    >
      {/* Header */}
      <div className="flex items-center gap-3 p-4">
        <ScanIcon className="size-5" aria-hidden />
        <span className="font-semibold">Scan barcode</span>
        <Button
          variant="ghost"
          size="icon"
          onClick={close}
          aria-label="Close scanner"
          className="ml-auto text-white hover:bg-white/10"
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
          data-testid="barcode-scan-video"
        />
        {state.status === 'STREAM_ACTIVE' ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <div className="size-56 rounded-3xl border-2 border-white/70 shadow-[0_0_0_100vmax_rgba(0,0,0,0.45)]" />
          </div>
        ) : null}

        {/* Idle guidance: say plainly what the frame is looking for so the scanner never
            leaves the user guessing. */}
        {state.status === 'STREAM_ACTIVE' ? (
          <p
            className="pointer-events-none absolute inset-x-0 top-[calc(50%+8rem)] px-6 text-center text-sm text-white/85"
            data-testid="barcode-scan-hint"
          >
            Point at the product’s barcode
          </p>
        ) : null}

        {state.status === 'ERROR_STATE' ? (
          <div className="absolute inset-0 grid place-items-center p-6">
            <Surface className="max-w-sm space-y-3 p-6 text-center text-foreground">
              <CameraOffIcon className="mx-auto size-8 text-muted-foreground" aria-hidden />
              <p className="text-sm">{state.error}</p>
              <Button onClick={() => dispatch({ type: 'OPEN' })}>Try the camera again</Button>
            </Surface>
          </div>
        ) : null}

        {state.status === 'REQUESTING_PERMISSIONS' ? (
          <p className="absolute text-sm text-white/80">Requesting camera access…</p>
        ) : null}
      </div>

      {/* Manual entry — graceful fallback (§6.6) and always-available aid. */}
      <div className="space-y-2 p-4">
        {engine === 'none' ? (
          <p className="text-center text-xs text-white/70" data-testid="barcode-scan-engine-none">
            Live scanning isn’t supported on this browser — enter a barcode below.
          </p>
        ) : engine === 'wasm' || engine === 'wasm-canvas' ? (
          <p className="text-center text-xs text-white/70" data-testid={`barcode-scan-engine-${engine}`}>
            Using the compatibility scanner — point steadily at the barcode, or enter it below.
          </p>
        ) : null}
        {/* Manual-entry feedback is the screen-reader channel: a blind user types a code and
            would otherwise get nothing back. Always-mounted polite region. */}
        <LiveRegion data-testid="barcode-scan-notice">
          {notice ? <p className="text-center text-xs text-warning">{notice}</p> : null}
        </LiveRegion>
        <div className="mx-auto flex max-w-md gap-2">
          <Input
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submitManual()}
            inputMode="numeric"
            aria-label="Enter a barcode"
            placeholder="Enter or paste a barcode"
            className="bg-white/10 text-white placeholder:text-white/50"
            data-testid="barcode-scan-manual-input"
          />
          <Button onClick={submitManual} data-testid="barcode-scan-manual-submit">
            Enter
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
