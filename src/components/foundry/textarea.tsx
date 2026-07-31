import {
  type ChangeEvent,
  type TextareaHTMLAttributes,
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
} from 'react';
import { cn } from '@/lib/utils';
import { fieldClasses } from './field-classes';
import { forgetHeight, readRememberedHeight, rememberHeight } from './textarea-size';

/** How many rows an `autoGrow` box may stretch to before it starts scrolling instead. */
export const DEFAULT_TEXTAREA_MAX_ROWS = 12;

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /**
   * A stable id under which this box's height is remembered once the user drags its resize
   * handle (issue #615) — `'item.notes'`, `'supplier.note'`, and so on. Namespace it by the
   * thing being edited so two unrelated boxes never share a size.
   *
   * Nothing is stored until the user actually resizes, and shrinking the box back down to
   * its default height forgets it again: a box the user never touched keeps following the
   * app's default size, so that default stays free to change.
   *
   * Omit it for a box whose size shouldn't outlive the dialog.
   */
  readonly sizeKey?: string;
  /**
   * Grow to fit the content as the user types, between the `rows` height and `maxRows`,
   * instead of staying at a fixed height with an inner scrollbar. Suits anything the user
   * writes a line at a time — a description, a note, a short list they are building. Leave
   * it off where a *fixed viewport* is the point: a box sized to have bulk text pasted into
   * it and scrolled through is more usable at a stable height than one that leaps to its cap.
   *
   * A manual drag always wins: once the user has sized the box themselves, it stays at
   * their height until they shrink it back down to the default.
   */
  readonly autoGrow?: boolean;
  /** The ceiling for `autoGrow`, in rows. Defaults to {@link DEFAULT_TEXTAREA_MAX_ROWS}. */
  readonly maxRows?: number;
}

/**
 * Foundry Textarea — the multi-line counterpart to {@link Input} (spec §2.4.1).
 *
 * It shares the one-line controls' look but sizes itself from `rows` rather than the fixed
 * `h-10`, and is vertically resizable. On top of the bare element it adds two behaviours
 * that every call site would otherwise have to hand-roll:
 *
 *  - **It remembers a size the user chose.** Given a `sizeKey`, a drag of the resize handle
 *    is stored (see `textarea-size.ts`) and restored the next time the box mounts. Only a
 *    *deliberate* resize counts — a click to place the caret changes no height and stores
 *    nothing — and shrinking back down to the default clears the entry, so the app's
 *    default size is never frozen at whatever it happens to be today.
 *  - **It can grow with its content.** With `autoGrow`, the box tracks what's typed into it
 *    up to `maxRows`, then scrolls. A user-chosen height outranks it.
 */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, rows = 3, sizeKey, autoGrow = false, maxRows = DEFAULT_TEXTAREA_MAX_ROWS, onChange, ...props },
  forwardedRef,
) {
  const elementRef = useRef<HTMLTextAreaElement | null>(null);
  /**
   * The height the user chose, or `null` while the box is still at its default size. This
   * is what auto-grow stands aside for, and the `null` is what keeps an untouched box out
   * of storage entirely.
   */
  const chosenHeightRef = useRef<number | null>(null);
  /**
   * The height the box has with no height of ours applied — i.e. the app's current default
   * for it. Measured once so a drag back to it can be recognised and forgotten.
   */
  const defaultHeightRef = useRef<number | null>(null);

  const setElement = useCallback(
    (node: HTMLTextAreaElement | null) => {
      elementRef.current = node;
      if (typeof forwardedRef === 'function') forwardedRef(node);
      else if (forwardedRef) forwardedRef.current = node;
    },
    [forwardedRef],
  );

  /**
   * Note the height the box has with nothing of ours applied, once that can be measured.
   *
   * Deliberately re-attempted rather than measured once at mount: a box that mounts inside a
   * container with no layout — collapsed, hidden, or off-screen — measures zero, and a zero
   * here would silently disable "shrink it back down and it is forgotten". Cheap and
   * idempotent: the first successful measurement is the last.
   */
  const captureDefaultHeight = useCallback(() => {
    const element = elementRef.current;
    if (!element || defaultHeightRef.current !== null) return;
    const applied = element.style.height;
    element.style.height = '';
    const measured = element.offsetHeight;
    if (measured > 0) defaultHeightRef.current = measured;
    // Restored within the same task, so nothing is ever painted at the bare height.
    element.style.height = applied;
  }, []);

  const fitToContent = useCallback(() => {
    const element = elementRef.current;
    if (!element || !autoGrow || chosenHeightRef.current !== null) return;
    // Measuring the content needs the box at its natural height first, or last render's
    // height would be its own floor and it could only ever grow.
    element.style.height = '';
    // No layout to measure (the test environment, or a hidden container) — leave the height
    // to CSS rather than pinning the box to a meaningless zero.
    if (element.scrollHeight <= 0) return;
    if (defaultHeightRef.current === null && element.offsetHeight > 0) {
      defaultHeightRef.current = element.offsetHeight;
    }
    const box = boxMetrics(element);
    const floor = defaultHeightRef.current ?? 0;
    element.style.height = `${Math.round(Math.min(Math.max(contentFittingHeight(element, box), floor), ceilingHeight(box, maxRows)))}px`;
  }, [autoGrow, maxRows]);

  /** Apply, store or forget a height the user dragged the box to. */
  const applyChosenHeight = useCallback(
    (height: number) => {
      const element = elementRef.current;
      if (!element) return;
      const defaultHeight = defaultHeightRef.current;
      // Shrunk back to the size it shipped with — or as far as it will go, which is the same
      // request — so there is nothing to remember, and pinning it would silently opt this box
      // out of any future change to that default. "At or below" rather than "exactly": nobody
      // can land a drag on an exact pixel, so an exact match would make this unreachable.
      if (defaultHeight !== null && height <= defaultHeight + 1) {
        chosenHeightRef.current = null;
        element.style.height = '';
        if (sizeKey) forgetHeight(sizeKey);
        fitToContent();
        return;
      }
      chosenHeightRef.current = height;
      // Restate the height as an inline one of our own rather than relying on however the
      // browser recorded the drag, so the box and the stored value cannot disagree.
      element.style.height = `${height}px`;
      if (sizeKey) rememberHeight(sizeKey, height);
    },
    [sizeKey, fitToContent],
  );

  // Measure the default height, then restore any height this box was last dragged to.
  // Keyed on `sizeKey` alone: re-running it for any other reason would discard a size the
  // user chose during this session.
  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    element.style.height = '';
    defaultHeightRef.current = null;
    captureDefaultHeight();
    const remembered = sizeKey ? readRememberedHeight(sizeKey) : null;
    chosenHeightRef.current = remembered;
    if (remembered !== null) element.style.height = `${remembered}px`;
    // A box that mounts with no layout — inside something collapsed, hidden or off-screen —
    // measures zero above, and both the default height and the content fit depend on a real
    // measurement. Retry on the next frame, by which point a container that opens as part of
    // the same commit has done so.
    if (typeof requestAnimationFrame !== 'function') return;
    const frame = requestAnimationFrame(() => {
      captureDefaultHeight();
      fitToContent();
    });
    return () => cancelAnimationFrame(frame);
  }, [sizeKey, captureDefaultHeight, fitToContent]);

  // Re-fit whenever the content changes from outside (a dialog opening onto an existing
  // note, a form reset). Typing is handled by the change wrapper below, since an
  // uncontrolled box reports nothing here.
  useLayoutEffect(() => {
    fitToContent();
  }, [fitToContent, props.value, props.defaultValue]);

  // Spot a drag of the resize handle. The height is compared across the pointer gesture
  // rather than watched continuously, so an ordinary click into the box — which resizes
  // nothing — is never mistaken for a choice about its size.
  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    let heightAtPointerDown: number | null = null;

    // The pointer has to arrive over the box before it can grab the handle, which makes this
    // the last safe moment to measure the default height — by `pointerdown` the browser has
    // already taken its own baseline for the drag.
    const onPointerEnter = () => {
      captureDefaultHeight();
    };
    const onPointerDown = () => {
      heightAtPointerDown = element.offsetHeight;
    };
    const onPointerUp = () => {
      const before = heightAtPointerDown;
      heightAtPointerDown = null;
      if (before === null || before <= 0) return;
      const height = Math.round(element.offsetHeight);
      if (height <= 0 || Math.abs(height - before) < 1) return;
      applyChosenHeight(height);
    };

    element.addEventListener('pointerenter', onPointerEnter);
    element.addEventListener('pointerdown', onPointerDown);
    // On the window, not the element: a drag routinely ends with the pointer outside the
    // box it started in.
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    return () => {
      element.removeEventListener('pointerenter', onPointerEnter);
      element.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };
  }, [applyChosenHeight, captureDefaultHeight]);

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      onChange?.(event);
      fitToContent();
    },
    [onChange, fitToContent],
  );

  return (
    <textarea
      ref={setElement}
      rows={rows}
      className={cn(fieldClasses, 'h-auto min-h-[4.5rem] resize-y py-2 leading-relaxed', className)}
      // Only wrapped when there is something to do on each keystroke, so a box without
      // `autoGrow` keeps exactly the handler the call site passed.
      onChange={autoGrow ? handleChange : onChange}
      {...props}
    />
  );
});

/**
 * The measurements auto-grow needs, in pixels.
 *
 * `borderBox` is the one that bites: `scrollHeight` counts the content and its padding but
 * *not* the border, whereas a CSS `height` under `box-sizing: border-box` (which Tailwind's
 * preflight sets app-wide) counts all three. Assigning one to the other unadjusted leaves the
 * box short by its own border, so the content overflows and the scrollbar auto-grow exists to
 * avoid appears anyway.
 */
interface BoxMetrics {
  readonly lineHeight: number;
  readonly padding: number;
  readonly border: number;
  readonly borderBox: boolean;
}

function boxMetrics(element: HTMLTextAreaElement): BoxMetrics {
  const style = getComputedStyle(element);
  return {
    lineHeight: pixels(style.lineHeight) || pixels(style.fontSize) * 1.5,
    padding: pixels(style.paddingTop) + pixels(style.paddingBottom),
    border: pixels(style.borderTopWidth) + pixels(style.borderBottomWidth),
    borderBox: style.boxSizing === 'border-box',
  };
}

/** The `height` that makes `element` exactly tall enough for what it currently holds. */
function contentFittingHeight(element: HTMLTextAreaElement, box: BoxMetrics): number {
  return box.borderBox ? element.scrollHeight + box.border : element.scrollHeight - box.padding;
}

/** The `height` at which the box stops growing and starts scrolling instead. */
function ceilingHeight(box: BoxMetrics, maxRows: number): number {
  // Without a usable line height there is no honest ceiling to impose, so impose none
  // rather than guessing one that could clip the content.
  if (box.lineHeight <= 0) return Number.POSITIVE_INFINITY;
  return maxRows * box.lineHeight + (box.borderBox ? box.padding + box.border : 0);
}

/** A computed-style length in pixels, or 0 for a keyword (`normal`, `auto`) or empty value. */
function pixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
