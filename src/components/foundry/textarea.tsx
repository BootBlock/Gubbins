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
   * instead of staying at a fixed height with an inner scrollbar. Suits free prose (a
   * description, a note); leave it off where the fixed height is the point, such as a
   * paste-a-list box.
   *
   * A manual drag always wins: once the user has sized the box themselves, it stays at
   * their height until they drag it back to the default.
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
   * Deliberately re-attempted rather than measured once at mount: a box inside a `Modal` is
   * still in a closed `<dialog>` when its own layout effects run, and a box on an unselected
   * tab is not laid out at all — both report a height of zero, and a zero here would silently
   * disable "dragged back to the default forgets it". Cheap and idempotent: the first
   * successful measurement is the last.
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
    // No layout to measure (jsdom, or a hidden tab) — leave the height to CSS rather than
    // pinning the box to a meaningless zero.
    if (element.scrollHeight <= 0) return;
    if (defaultHeightRef.current === null && element.offsetHeight > 0) {
      defaultHeightRef.current = element.offsetHeight;
    }
    const floor = defaultHeightRef.current ?? 0;
    const ceiling = maxContentHeight(element, maxRows);
    element.style.height = `${Math.round(Math.min(Math.max(element.scrollHeight, floor), ceiling))}px`;
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
      // Pin it explicitly: the browser applies its own resize, but only an inline height we
      // set ourselves survives the box being unmounted and mounted again.
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
    // A box inside a `Modal` is measured above while its `<dialog>` is still closed, so it
    // reads zero; the dialog is opened by an effect in the same commit, which makes the next
    // frame the first moment it can be measured at all.
    if (typeof requestAnimationFrame !== 'function') return;
    const frame = requestAnimationFrame(captureDefaultHeight);
    return () => cancelAnimationFrame(frame);
  }, [sizeKey, captureDefaultHeight]);

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

/** The pixel height of `maxRows` lines of text in `element`, including its own chrome. */
function maxContentHeight(element: HTMLTextAreaElement, maxRows: number): number {
  const style = getComputedStyle(element);
  const lineHeight = pixels(style.lineHeight) || pixels(style.fontSize) * 1.5;
  // Without a usable line height there is no honest ceiling to impose, so impose none
  // rather than guessing one that could clip the content.
  if (lineHeight <= 0) return Number.POSITIVE_INFINITY;
  const chrome =
    pixels(style.paddingTop) +
    pixels(style.paddingBottom) +
    pixels(style.borderTopWidth) +
    pixels(style.borderBottomWidth);
  return maxRows * lineHeight + chrome;
}

/** A computed-style length in pixels, or 0 for a keyword (`normal`, `auto`) or empty value. */
function pixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
