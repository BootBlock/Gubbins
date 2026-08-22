import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type InputHTMLAttributes,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { CalculatorIcon } from '@/components/icons';
import { useT } from '@/features/i18n';
import { cn } from '@/lib/utils';
import { evaluateExpression, formatCalcResult, hasCalcExpression } from './evaluate-expression';
import { LiveRegion } from './live-region';
import {
  applyBounds,
  hasBounds,
  parseNumericText,
  removedBefore,
  resolveBounds,
  sanitiseNumericText,
  stepFrom,
} from './numeric-bounds';
import { Tooltip } from './tooltip';

/**
 * Foundry NumberInput — a numeric field with a built-in **micro-calculator** (issue #93).
 *
 * It looks and behaves like an ordinary number box, but you can *type a sum into it*:
 * enter `500/2` and, on **Enter** or when the field loses focus, it settles to `250`.
 * `+ − × ÷`, `^` powers, a postfix `%` (divide-by-100) and parentheses are all understood
 * — the pure {@link evaluateExpression} seam does the maths (no `eval`, ever). While you
 * type a calculation a live "= result" preview appears at the trailing edge, alongside a
 * calculator glyph whose rich-Markdown {@link Tooltip} documents the feature.
 *
 * This is the control the Foundry {@link Input} delegates to for `type="number"`, so every
 * number field in the app gains the calculator for free. Because the field must hold
 * operator characters (`/`, `*`, …) it is a `type="text"` box with `inputMode="decimal"`,
 * not a native `type="number"` spinbutton.
 *
 * That text box is also why the control has to apply `min` / `max` / `step` itself (issue
 * #676): the browser only honours those attributes on a real `number`/`range`/date input, so
 * on a text field they are inert markup — no stepper, no validity, no announced range. They
 * are read here through the pure {@link resolveBounds} seam and given back the three jobs they
 * do natively, and only those three: they bound the Up/Down stepper, they mark an out-of-range
 * value `aria-invalid`, and they are announced as the field's range.
 *
 * What the control deliberately does **not** do is rewrite a value you typed to fit them. A
 * native number field does not either, and rewriting on commit turned out to be actively
 * harmful here: it quantised a three-decimal currency to two, it settled a mistyped negative
 * price to `0` and let it save over the stored figure (undoing issue #675), and it changed the
 * box under call sites that read their own state in `onBlur`. Out-of-range text stays exactly
 * as typed and is reported, which is the contract the rest of the app already keeps.
 *
 * Characters a figure cannot contain (letters, a newline) are dropped as they arrive, the way
 * a native number box refuses them — with the sole exception of a comma, which means different
 * things in different locales and so is reported rather than guessed at. Call sites keep the
 * plain `min={0} step={1}` markup they already had; nothing there has to change.
 *
 * Accessibility (WCAG 2.x): the calculator hint is always exposed to assistive tech via a
 * visually-hidden `aria-describedby` (so it never depends on hovering the glyph), the
 * computed result is announced through a polite {@link LiveRegion} on commit (4.1.3 Status
 * Messages), and any `aria-describedby` / `aria-invalid` a parent {@link FormField} injects
 * is preserved and merged rather than clobbered. A field that declares a range also takes the
 * `spinbutton` role with `aria-valuemin`/`aria-valuemax`/`aria-valuenow`, so the bound is
 * announced instead of being visible only in the markup, and a value outside it is marked
 * `aria-invalid` on top of any invalidity a parent injects. A field with no range stays a plain
 * `textbox`, because there would be nothing for a spinbutton to report.
 */
export type NumberInputProps = InputHTMLAttributes<HTMLInputElement>;

/** Write a value into an input via the native setter so React's change tracking fires. */
function setNativeValue(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(el, value);
}

export const NumberInput = forwardRef<HTMLInputElement, NumberInputProps>(function NumberInput(
  {
    className,
    inputMode = 'decimal',
    autoComplete = 'off',
    onChange,
    onBlur,
    onFocus,
    onKeyDown,
    disabled,
    readOnly,
    'aria-describedby': ariaDescribedBy,
    ...props
  },
  forwardedRef,
) {
  const t = useT();
  const hintId = useId();
  const innerRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState<string>(() => String(props.value ?? props.defaultValue ?? ''));
  const [focused, setFocused] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  // The declared range, read straight off the same `min`/`max`/`step` attributes the call
  // sites already pass. They stay in `props` too, so the rendered markup still carries them.
  const bounds = useMemo(
    () => resolveBounds(props.min, props.max, props.step),
    [props.min, props.max, props.step],
  );
  const bounded = hasBounds(bounds);

  // Compose the caller's ref (often React Hook Form's `register().ref`) with our own.
  const setRef = useCallback(
    (node: HTMLInputElement | null) => {
      innerRef.current = node;
      if (typeof forwardedRef === 'function') forwardedRef(node);
      else if (forwardedRef) forwardedRef.current = node;
    },
    [forwardedRef],
  );

  // Keep the preview mirror in step when a controlled `value` changes from outside.
  useEffect(() => {
    if (props.value !== undefined) setText(String(props.value));
  }, [props.value]);

  /**
   * Evaluate the current text and, if it is a valid calculation, write the result back so
   * downstream `onChange` (RHF / controlled parents) sees the computed number. Returns
   * whether it actually rewrote the field.
   *
   * A plainly-typed number is never touched, in range or out of it. Working out `500/2` is a
   * rewrite the user asked for; moving their `-250` to `0` is not one, and the call site is
   * better placed to say what is wrong with it than this control is to guess a replacement.
   */
  const commit = useCallback((): boolean => {
    const el = innerRef.current;
    if (!el) return false;
    const raw = el.value;
    if (!hasCalcExpression(raw)) return false;
    const result = evaluateExpression(raw);
    if (!result.ok) return false;
    const formatted = formatCalcResult(result.value);
    if (formatted === raw.trim()) return false;
    setNativeValue(el, formatted);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    setText(formatted);
    setAnnouncement(t('numberInput.result', { vars: { result: formatted } }));
    return true;
  }, [t]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      // Drop anything a number field cannot mean before it reaches the caller — a letter, a
      // pasted thousands comma, a newline. Doing it here means the user sees the rejection as
      // they type, and no `Number(...)` downstream ever meets one of those characters.
      const el = e.currentTarget;
      const raw = el.value;
      const clean = sanitiseNumericText(raw);
      if (clean !== raw) {
        const caret = el.selectionStart ?? raw.length;
        const moved = caret - removedBefore(raw, caret);
        // A plain assignment, *not* {@link setNativeValue}: this runs inside React's own change
        // handling, so the node's value tracker has to be brought along. Writing through the
        // prototype setter would leave the tracker holding the rejected text, and the very next
        // keystroke that reproduced it would compare equal and fire no change event at all.
        el.value = clean;
        el.setSelectionRange(moved, moved);
      }
      setText(el.value);
      onChange?.(e);
    },
    [onChange],
  );

  const handleFocus = useCallback(
    (e: FocusEvent<HTMLInputElement>) => {
      // Re-sync the mirror from the DOM (covers an external reset while unfocused).
      setText(e.target.value);
      setFocused(true);
      onFocus?.(e);
    },
    [onFocus],
  );

  const handleBlur = useCallback(
    (e: FocusEvent<HTMLInputElement>) => {
      setFocused(false);
      // Evaluate *before* the caller's onBlur so form validation reads the computed value.
      commit();
      onBlur?.(e);
    },
    [commit, onBlur],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      // A field that declares a range is a spinbutton, so Up/Down must move the value by a
      // step the way a native one does — the affordance the text box otherwise gives up.
      const el = innerRef.current;
      if (bounded && el && !disabled && !readOnly && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        // Settle a half-typed sum first, so stepping from `40+3` moves off 43 rather than
        // throwing the calculation away and starting again from the bottom of the range.
        if (hasCalcExpression(el.value)) commit();
        const from = parseNumericText(el.value);
        const next = formatCalcResult(stepFrom(from, bounds, e.key === 'ArrowUp' ? 1 : -1));
        setNativeValue(el, next);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        setText(next);
        onKeyDown?.(e);
        return;
      }
      // Enter computes the sum in place; swallow it (so it doesn't submit the form) only when
      // there was actually something to settle, leaving an untouched plain number alone.
      if (e.key === 'Enter' && commit()) e.preventDefault();
      onKeyDown?.(e);
    },
    [bounded, bounds, commit, disabled, onKeyDown, readOnly],
  );

  const isCalc = hasCalcExpression(text);
  // The number the box currently denotes, or null while it is blank or mid-calculation.
  const current = isCalc ? null : parseNumericText(text);
  // Out of the declared range is exactly what a native number field reports as invalid, and it
  // is all this control claims: the entry is left alone for the call site to explain.
  const outOfRange = bounded && current !== null && applyBounds(current, bounds).adjusted;

  const preview = isCalc ? evaluateExpression(text) : null;
  const showAffordance = focused && isCalc && !disabled && !readOnly;

  return (
    <div className={cn('relative flex h-10 w-full items-stretch text-sm', className)}>
      <input
        {...props}
        ref={setRef}
        type="text"
        inputMode={inputMode}
        autoComplete={autoComplete}
        disabled={disabled}
        readOnly={readOnly}
        {...(bounded
          ? {
              role: 'spinbutton',
              'aria-valuemin': bounds.min,
              'aria-valuemax': bounds.max,
              // Omitted while the box is blank or holds a half-typed sum: there is no current
              // value to report, and a stale one would be worse than none.
              'aria-valuenow': current ?? undefined,
            }
          : {})}
        // Never downgrades an invalidity a parent {@link FormField} injected: the field is
        // invalid if either this control's range or the call site's own validation says so.
        aria-invalid={
          props['aria-invalid'] === true || props['aria-invalid'] === 'true' || outOfRange || undefined
        }
        aria-describedby={[ariaDescribedBy, hintId].filter(Boolean).join(' ')}
        onChange={handleChange}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        className={cn(
          'h-full w-full rounded-lg border border-border bg-input/40 px-3 text-[length:inherit] text-foreground shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50',
          showAffordance && 'pr-16',
        )}
      />

      {/* The visible calculator affordance sits over the field, so it must live inside this
          positioned wrapper. It is `aria-hidden` — assistive tech gets the same help from the
          portaled `srHint` below (referenced by `aria-describedby`) and hears the computed value
          from the live region, so the glyph is a pointer-only nicety and never joins the field's
          accessible name (which the wrapper would otherwise fold it into). */}
      {showAffordance ? (
        <div aria-hidden className="pointer-events-none absolute inset-y-0 right-2 flex items-center gap-1.5">
          {preview?.ok ? (
            <span className="max-w-[6rem] truncate rounded bg-muted px-1.5 py-0.5 text-xs font-medium tabular-nums text-muted-foreground">
              = {formatCalcResult(preview.value)}
            </span>
          ) : null}
          <Tooltip
            content={t('numberInput.help')}
            size="md"
            triggerTabIndex={-1}
            className="pointer-events-auto"
          >
            <span
              className={cn(
                'grid size-4 cursor-help place-items-center transition-colors ease-emphasized [&_svg]:size-4',
                preview?.ok ? 'text-muted-foreground/70 hover:text-foreground' : 'text-warning',
              )}
            >
              <CalculatorIcon />
            </span>
          </Tooltip>
        </div>
      ) : null}

      {/* Portaled to <body> so neither the always-present calculator hint nor the transient
          result announcement is nested inside a wrapping <label>, where either would be folded
          into the control's accessible name. `aria-describedby` still reaches the hint by id. */}
      {createPortal(
        <>
          <span id={hintId} className="sr-only">
            {t('numberInput.srHint')}
          </span>
          <LiveRegion visuallyHidden>{announcement ? <span>{announcement}</span> : null}</LiveRegion>
        </>,
        document.body,
      )}
    </div>
  );
});
