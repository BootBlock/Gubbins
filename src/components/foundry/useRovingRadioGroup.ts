import { useCallback, useRef, type KeyboardEvent } from 'react';

/**
 * Headless keyboard behaviour for a WAI-ARIA **radiogroup** rendered as a roving-`tabindex`
 * set of `role="radio"` controls (a colour swatch grid, an icon-type palette, a preset list…).
 *
 * The group is a single tab stop: the checked radio carries `tabIndex={0}` and the rest
 * `-1`. Once focused, the arrow keys *move and select* (standard radiogroup semantics), Home/End
 * jump to the ends, and Space/Enter re-affirm the focused option — all wrapping at the edges.
 *
 * The hook is deliberately index-based and option-shape-agnostic so it suits both controlled
 * (`value`/`onChange`) and local-state consumers: it hands back a `selectAt(index)` that
 * normalises the index (wrap-around), invokes {@link onSelect}, and moves DOM focus to that
 * option's element, plus an `onKeyDown(event, index)` to spread onto each radio. Consumers own
 * rendering and the checked/`tabIndex` wiring; they register each option's element in
 * {@link refs} so focus can follow selection.
 *
 * Mirrors the codebase's "extract the logic out of the DOM glue" seam — the three original
 * copies (LocationKindPicker, ColorSwatchPicker, FirstRunModules) collapse onto this.
 */
export function useRovingRadioGroup<E extends HTMLElement = HTMLElement>({
  count,
  onSelect,
}: {
  /** Number of options in the group. */
  readonly count: number;
  /** Commit the selection at the (already-normalised) index — set state or call `onChange`. */
  readonly onSelect: (index: number) => void;
}) {
  /** Register each option's element here (`refs.current[index] = el`) so focus can follow. */
  const refs = useRef<(E | null)[]>([]);

  const selectAt = useCallback(
    (index: number) => {
      if (count <= 0) return;
      const next = ((index % count) + count) % count;
      onSelect(next);
      refs.current[next]?.focus();
    },
    [count, onSelect],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<E>, index: number) => {
      switch (event.key) {
        case 'ArrowRight':
        case 'ArrowDown':
          event.preventDefault();
          selectAt(index + 1);
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
          event.preventDefault();
          selectAt(index - 1);
          break;
        case 'Home':
          event.preventDefault();
          selectAt(0);
          break;
        case 'End':
          event.preventDefault();
          selectAt(count - 1);
          break;
        case ' ':
        case 'Enter':
          event.preventDefault();
          selectAt(index);
          break;
      }
    },
    [count, selectAt],
  );

  return { refs, selectAt, onKeyDown };
}
