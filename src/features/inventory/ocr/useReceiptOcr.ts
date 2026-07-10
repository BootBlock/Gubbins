/**
 * React glue for on-device receipt/label OCR (feature-gap **G2**).
 *
 * Drives one OCR pass: run the injected/real Tesseract engine over a chosen image
 * ({@link runReceiptOcr}), then interpret its text with the pure {@link parseReceiptText} seam.
 * All the parsing lives in the pure seam; this hook only owns the async run state (phase,
 * progress, error) for the review dialog. The recogniser factory is injectable so the dialog
 * can be tested without loading a real WASM worker.
 */
import { useCallback, useRef, useState } from 'react';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { describeOcrError, describeOcrStatus, runReceiptOcr, type OcrRecognizerFactory } from './ocr-engine';
import { parseReceiptText, type ReceiptCandidates } from './receipt-ocr';

export type OcrPhase = 'idle' | 'running' | 'done' | 'error';

export interface ReceiptOcrState {
  readonly phase: OcrPhase;
  /** Fraction complete (`0`…`1`) while running. */
  readonly progress: number;
  /** Friendly status label for the current phase (e.g. "Reading the image…"). */
  readonly statusLabel: string;
  /** The parsed candidates once done (may be empty — nothing found), else null. */
  readonly candidates: ReceiptCandidates | null;
  /** A user-facing error message when the pass failed, else null. */
  readonly error: string | null;
}

const IDLE: ReceiptOcrState = {
  phase: 'idle',
  progress: 0,
  statusLabel: '',
  candidates: null,
  error: null,
};

/**
 * Owns a single receipt-OCR pass. `scan(image)` runs the engine and parses the result; a new
 * `scan` (or `reset`) supersedes any in-flight pass via a run-id guard, so a stale worker
 * callback can never clobber fresh state. Reads the chosen model tier from preferences.
 */
export function useReceiptOcr(options?: { readonly createRecognizer?: OcrRecognizerFactory }) {
  const model = usePreferencesStore((s) => s.ocrModel);
  const [state, setState] = useState<ReceiptOcrState>(IDLE);
  const runIdRef = useRef(0);
  const createRecognizer = options?.createRecognizer;

  const scan = useCallback(
    async (image: Blob) => {
      const runId = ++runIdRef.current;
      setState({ phase: 'running', progress: 0, statusLabel: 'Preparing…', candidates: null, error: null });
      try {
        const text = await runReceiptOcr(image, {
          model,
          createRecognizer,
          onProgress: (p) => {
            if (runId !== runIdRef.current) return;
            setState((s) => ({ ...s, progress: p.progress, statusLabel: describeOcrStatus(p.status) }));
          },
        });
        if (runId !== runIdRef.current) return;
        const candidates = parseReceiptText(text, { referenceYear: new Date().getFullYear() });
        setState({ phase: 'done', progress: 1, statusLabel: '', candidates, error: null });
      } catch (err) {
        if (runId !== runIdRef.current) return;
        setState({
          phase: 'error',
          progress: 0,
          statusLabel: '',
          candidates: null,
          error: describeOcrError(err),
        });
      }
    },
    [model, createRecognizer],
  );

  const reset = useCallback(() => {
    runIdRef.current++; // supersede any in-flight pass
    setState(IDLE);
  }, []);

  return { ...state, scan, reset };
}
