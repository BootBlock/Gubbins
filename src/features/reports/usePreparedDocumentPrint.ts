/**
 * "Prepare the whole document, then print" — shared by the two printable reports.
 *
 * Both the insurance schedule (issue #163) and the parts catalogue (issue #410) are read a page
 * at a time and print a *complete* artefact instead, which the Print button has to assemble
 * first. The assembling is identical for both, and the rules it has to obey are subtle enough
 * that two copies would be two chances to get one of them wrong:
 *
 *  - `window.print()` is called from an **effect**, once React has committed the loaded document.
 *    Calling it from the click handler would raise the print dialog against a half-built page.
 *  - Every image in the print artefact is **decoded first**, or the thumbnails print blank.
 *  - `afterprint` drops the document again, so a whole inventory's rows are not held alive once
 *    the print is over.
 *  - A prepared document is dropped whenever the settings it was built under change. A document
 *    that no longer matches those settings is a *wrong* document, not a stale one — and this is
 *    the rule the caller has to hold up, by memoising `load` on exactly those settings.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/** The reader-facing status line at each stage of preparing a document. */
export interface PreparedPrintMessages {
  readonly preparing: string;
  readonly progress: (done: number, total: number) => string;
  readonly ready: string;
  readonly cancelled: string;
  readonly failed: string;
}

/**
 * Drive the prepare-then-print flow for one document.
 *
 * `load` **must** be memoised (`useCallback`) on every setting the document depends on — the
 * scope, the grouping, the sort, whether photos are on, and the summary it pages through. Its
 * identity is what tells this hook a prepared document no longer describes what the reader
 * asked for, and a `load` rebuilt on every render would drop the document as fast as it arrives.
 *
 * `enabled` is the second half of that: a document cannot be assembled before its summary has
 * landed, and starting anyway would print a complete-looking artefact holding nothing.
 */
export function usePreparedDocumentPrint<TLine>(options: {
  /** CSS selector for the print-only document, whose images are decoded before printing. */
  readonly printDocSelector: string;
  /** Assemble the whole document. Memoise on every setting it depends on — see above. */
  readonly load: (
    onProgress: (loaded: number, total: number) => void,
    signal: AbortSignal,
  ) => Promise<Map<string | null, TLine[]>>;
  /** False while there is nothing to assemble yet (no scope chosen, no summary read). */
  readonly enabled: boolean;
  readonly messages: PreparedPrintMessages;
}) {
  const { printDocSelector, load, enabled, messages } = options;
  const [lines, setLines] = useState<Map<string | null, TLine[]> | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);

  // A prepared document is only valid for the settings it was prepared under, which `load`'s
  // identity carries.
  useEffect(() => {
    setLines(null);
  }, [load]);

  useEffect(() => {
    const drop = () => setLines(null);
    window.addEventListener('afterprint', drop);
    return () => window.removeEventListener('afterprint', drop);
  }, []);

  // Print only once the full document has actually been committed to the DOM.
  useEffect(() => {
    if (lines === null) return;
    let cancelled = false;
    void (async () => {
      // Thumbnails are decoded before the dialog opens, or they print as blanks.
      const images = Array.from(document.querySelectorAll<HTMLImageElement>(`${printDocSelector} img`));
      await Promise.all(images.map((img) => img.decode().catch(() => undefined)));
      if (!cancelled) window.print();
    })();
    return () => {
      cancelled = true;
    };
  }, [lines, printDocSelector]);

  const start = useCallback(async () => {
    if (!enabled) return;
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setStatus(messages.preparing);
    try {
      const loaded = await load(
        (done, total) => setStatus(messages.progress(done, total)),
        controller.signal,
      );
      setLines(loaded);
      setStatus(messages.ready);
    } catch (err) {
      setStatus((err as Error)?.name === 'AbortError' ? messages.cancelled : messages.failed);
    } finally {
      setBusy(false);
      abort.current = null;
    }
    // `messages` is read only inside this callback, so a caller that rebuilds it each render
    // changes `start`'s identity and nothing else — the document is never dropped for it.
  }, [enabled, load, messages]);

  const cancel = useCallback(() => abort.current?.abort(), []);

  return { lines, status, busy, start, cancel };
}
