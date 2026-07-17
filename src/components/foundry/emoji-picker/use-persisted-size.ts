import { useCallback, useEffect, useRef, useState } from 'react';

/** A persisted pixel size for a resizable panel. */
export interface PanelSize {
  readonly width: number;
  readonly height: number;
}

/**
 * Persist a resizable panel's size to `localStorage` under `key`, so a dialog the user
 * has resized reopens at the same size (issue #83 — the emoji picker is resizable and
 * remembers its size). Device-local UI state, exactly like a window size; never synced.
 *
 * Returns the restored size (or `fallback` on first run / a malformed stored value) and a
 * setter that both updates state and writes back — call it from a `ResizeObserver` on the
 * panel so a drag-resize is captured. Reads/writes are guarded so a private-mode /
 * quota-refused `localStorage` degrades to in-memory rather than throwing.
 */
export function usePersistedSize(key: string, fallback: PanelSize): [PanelSize, (size: PanelSize) => void] {
  const [size, setSize] = useState<PanelSize>(() => readSize(key) ?? fallback);

  // Keep the latest size in a ref so the persisting setter is stable (safe as a
  // ResizeObserver dependency) without going stale.
  const sizeRef = useRef(size);
  sizeRef.current = size;

  const persist = useCallback(
    (next: PanelSize) => {
      // Ignore no-op observer callbacks (sub-pixel jitter) so we don't thrash storage.
      if (
        Math.round(next.width) === Math.round(sizeRef.current.width) &&
        Math.round(next.height) === Math.round(sizeRef.current.height)
      ) {
        return;
      }
      setSize(next);
      writeSize(key, next);
    },
    [key],
  );

  return [size, persist];
}

/**
 * Wire a `ResizeObserver` on `element` to `onResize`, reporting the element's live
 * content-box size. A convenience for {@link usePersistedSize} so the panel persists its
 * size as the user drags the resize handle. No-op where `ResizeObserver` is unavailable.
 *
 * The observer's **first** callback — the initial layout at the restored/default size — is
 * skipped: at that point no user resize has happened, and reporting it would persist the
 * *clamped* on-screen size (e.g. when `max-width` shrinks the panel on a narrow viewport),
 * silently shrinking the remembered size even though the user never dragged. Only genuine
 * post-mount changes are reported.
 */
export function useResizeObserver(element: HTMLElement | null, onResize: (size: PanelSize) => void): void {
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;

  useEffect(() => {
    if (!element || typeof ResizeObserver === 'undefined') return;
    let seenFirst = false;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      if (!seenFirst) {
        seenFirst = true;
        return;
      }
      onResizeRef.current({ width: rect.width, height: rect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
}

function readSize(key: string): PanelSize | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as PanelSize).width === 'number' &&
      typeof (parsed as PanelSize).height === 'number' &&
      Number.isFinite((parsed as PanelSize).width) &&
      Number.isFinite((parsed as PanelSize).height)
    ) {
      return { width: (parsed as PanelSize).width, height: (parsed as PanelSize).height };
    }
  } catch {
    // Malformed value or storage unavailable — fall back to the default size.
  }
  return null;
}

function writeSize(key: string, size: PanelSize): void {
  try {
    localStorage.setItem(
      key,
      JSON.stringify({ width: Math.round(size.width), height: Math.round(size.height) }),
    );
  } catch {
    // Storage full / unavailable (private mode) — the size simply won't persist.
  }
}
