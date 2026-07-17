import { useEffect, useRef, type RefObject } from 'react';

/**
 * Foundry seam for a searchable dialog's two-role Escape (spec §2.4.1): while the given
 * search input is focused and non-empty, Escape *clears the filter* and keeps the dialog
 * open; otherwise it falls through untouched to the enclosing {@link Modal}, which
 * cancels. Shared by the glyph picker and the category-preset picker so the subtlety
 * lives in exactly one place.
 *
 * The clear must beat the Modal's own Escape-to-close, so the listener runs in the
 * **capture phase** — ahead of Modal's document (bubble) handler. The input's live DOM
 * value is read (not React state) to keep the `[active]`-only effect free of stale
 * closures, and the latest `onClear` is kept in a ref for the same reason.
 */
export function useSearchEscapeToClear(
  active: boolean,
  inputRef: RefObject<HTMLInputElement | null>,
  onClear: () => void,
): void {
  const onClearRef = useRef(onClear);
  onClearRef.current = onClear;

  useEffect(() => {
    if (!active) return;
    const onKeyCapture = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const input = inputRef.current;
      if (input && document.activeElement === input && input.value.length > 0) {
        event.preventDefault();
        event.stopPropagation();
        onClearRef.current();
      }
    };
    document.addEventListener('keydown', onKeyCapture, true);
    return () => document.removeEventListener('keydown', onKeyCapture, true);
  }, [active, inputRef]);
}
